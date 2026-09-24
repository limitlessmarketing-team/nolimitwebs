import { ReviewRequired, activityFields, field, CloseRecordNotFound } from './close.mjs';
import { expectedMode, idOf } from './stripe.mjs';

export const CANCEL_AUTHORIZATION = 'Cancel this unpaid proposal and disable its checkout';
export const CANCELED_MESSAGE = 'This proposal has been canceled. Please contact our team for your current proposal link.';
export const cancellationBlocks = p => Boolean(p?.cancellation);
const requireMatch = (ok, message) => { if (!ok) throw new ReviewRequired(message); };

// No invoice, payment, customer or subscription mutations are permitted here.
export function proposalCancellation({ config, api, close, store, now, publish }) {
  const own = (obj, p) => requireMatch(expectedMode(obj.livemode, config.mode) &&
    obj.metadata?.close_project_id === p.id && obj.metadata?.close_lead_id === p.leadId &&
    obj.metadata?.close_organization_id === config.organizationId, 'Stripe record does not match this proposal.');
  const accepted = p => p.depositId || p.setupAccepted || p.launchAt || p.finalId || p.subscriptionId || p.domainSubscriptionId;
  async function sessions(p) {
    if (p.linkId.startsWith('host_')) {
      if (!p.setupSessionId) return [];
      const s = await api(`checkout/sessions/${p.setupSessionId}`); own(s,p); return [s];
    }
    const result = [];
    let after = '';
    for (let page = 0; page < 20; page++) {
      const list = await api(`checkout/sessions?payment_link=${p.linkId}&limit=100${after ? `&starting_after=${after}` : ''}`);
      requireMatch(Array.isArray(list.data), 'Unable to verify proposal checkouts.');
      for (const s of list.data) { own(s,p); requireMatch(idOf(s.payment_link) === p.linkId, 'Checkout belongs to another proposal.'); result.push(s); }
      if (!list.has_more) return result;
      requireMatch(/^cs_[A-Za-z0-9_]+$/.test(list.data.at(-1)?.id || ''), 'Invalid checkout pagination.');
      after = list.data.at(-1).id;
    }
    throw new Error('Too many checkouts to verify; cancellation needs retry and review');
  }
  async function cancel(activity) {
    const input = String(field(activity,config.cancelFields.proposal) || '').trim();
    let url;
    try { url = new URL(input); } catch { throw new ReviewRequired('Paste the exact proposal link you want to cancel.'); }
    const token = url.hash.slice(1);
    requireMatch(url.origin === config.origin && url.pathname === '/proposal/' && !url.search &&
      /^(?:host_[a-f0-9]{64}|plink_[A-Za-z0-9]{12,100})$/.test(token), 'Use a proposal link from this billing environment.');
    requireMatch(field(activity,config.cancelFields.authorization) === CANCEL_AUTHORIZATION, 'Confirm cancellation of this unpaid proposal.');
    const existing = await store.findHostingToken(token);
    requireMatch(existing && existing.leadId === activity.lead_id, 'Proposal not found on this lead. Check the link and sandbox/live option.');
    let result;
    await store.withLock(existing.id,async(p,tx)=>{
      requireMatch(p.leadId === activity.lead_id && p.linkId === token, 'Proposal identity changed.');
      if (p.cancellation?.status === 'canceled') { result = 'Proposal canceled — old link and open checkouts disabled. You may create a replacement.'; await publish(p,result,tx); return; }
      requireMatch(!accepted(p), 'Proposal already accepted or billed. No payments or subscriptions were canceled; review this client in Stripe.');
      let current = await sessions(p);
      requireMatch(!current.some(s=>s.status === 'complete' || s.payment_status === 'paid'), 'Checkout already completed. No payments or subscriptions were canceled; review this client in Stripe.');
      p.cancellation ||= { status:'canceling', requestedAt:new Date(now()).toISOString(), activityId:activity.id };
      await tx.save(p); // Block new server checkouts before external writes.
      if (token.startsWith('plink_')) {
        const link = await api(`payment_links/${token}`); own(link,p);
        if (link.active) await tx.post('cancel-payment-link',`payment_links/${token}`,{active:'false',inactive_message:CANCELED_MESSAGE},api);
      }
      // Re-list after disabling the Payment Link to include sessions opened during the first read.
      current = await sessions(p);
      for (const s of current) {
        if (s.status !== 'open') continue;
        try { await tx.post(`cancel-session-${s.id}`,`checkout/sessions/${s.id}/expire`,{},api); }
        catch(error) {
          const fresh = await api(`checkout/sessions/${s.id}`); own(fresh,p);
          if (fresh.status !== 'expired' && fresh.status !== 'complete') throw error;
        }
      }
      current = await sessions(p);
      if (current.some(s=>s.status === 'complete' || s.payment_status === 'paid')) {
        p.cancellation.status='review'; await tx.save(p);
        result='Cancellation needs review — checkout completed while cancellation was running. Further checkout is blocked; existing payment and billing remain intact. Review Stripe before sending a replacement.';
      } else {
        requireMatch(current.every(s=>s.status === 'expired'), 'Some checkouts are not yet disabled. Retry this cancellation.');
        p.cancellation.status='canceled'; p.cancellation.completedAt=new Date(now()).toISOString(); await tx.save(p);
        result='Proposal canceled — old link and open checkouts disabled. You may create a replacement.';
      }
      await publish(p,result,tx);
    });
    if (field(activity,config.cancelFields.result) !== result) await close(`activity/custom/${activity.id}/`,activityFields(config.cancelFields,{result}));
  }
  return async payload => {
    const event=payload?.event;
    requireMatch(payload?.subscription_id===config.subscriptionId && event?.organization_id===config.organizationId,'Wrong Close organization or subscription.');
    if (!['created','updated'].includes(event.action) || event.object_type!=='activity.custom_activity' || !/^acti_[A-Za-z0-9]+$/.test(event.object_id||'')) return;
    let a;
    try { a=await close(`activity/custom/${event.object_id}/`); } catch(e) { if(e instanceof CloseRecordNotFound) return; throw e; }
    requireMatch(a.id===event.object_id && a.organization_id===config.organizationId && a.lead_id===event.lead_id,'Close activity identity mismatch.');
    if(a.custom_activity_type_id!==config.cancelType || a.status!=='published' || !Number.isFinite(Date.parse(a.date_created)) || Date.parse(a.date_created)<Date.parse(config.enabledAfter)) return;
    try { await cancel(a); }
    catch(e) {
      if (!(e instanceof ReviewRequired)) throw e;
      const result=`Review required: ${e.message}`;
      if(field(a,config.cancelFields.result)!==result) await close(`activity/custom/${a.id}/`,activityFields(config.cancelFields,{result}));
    }
  };
}
