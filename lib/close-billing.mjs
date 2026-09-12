import { FLOW, TERMS, idOf, expectedMode, readProposal, completeDeposit, stripe } from './stripe.mjs';
import { activityFields, billingConfig, createCloseClient, dollarsToCents, field, LAUNCH_AUTHORIZATION, ReviewRequired } from './close.mjs';
import { BillingStore } from './billing-store.mjs';

const FOOTER = 'Thank you for choosing Limitless Marketing Group. nolimitwebs.com | contact@nolimitwebs.com';
const meta = (values, prefix = 'metadata') => Object.fromEntries(Object.entries(values).map(([k, v]) => [`${prefix}[${k}]`, String(v)]));
const validId = (prefix, value) => new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value || '');
const activityPath = id => `activity/custom/${id}/`;
const requireMatch = (condition, message) => { if (!condition) throw new ReviewRequired(message); };

export function createBillingService(env, dependencies = {}) {
  const config = billingConfig(env);
  if (!config) return null;
  if (!new RegExp(`^(?:rk|sk)_${config.mode}_`).test(env.STRIPE_SECRET_KEY || '')) throw new Error('Stripe key mode mismatch');
  const api = dependencies.stripe || ((path, params, key) => stripe(path, params, key, fetch, env.STRIPE_SECRET_KEY));
  const close = dependencies.close || createCloseClient(env);
  const store = dependencies.store || new BillingStore(env.CLOSE_BILLING_DB, config.mode);
  const now = dependencies.now || (() => Date.now());
  const proposalFields = config.proposalFields;
  const launchFields = config.launchFields;
  const metadata = p => ({ close_project_id: p.id, close_lead_id: p.leadId, close_organization_id: config.organizationId });
  const modeCheck = object => requireMatch(expectedMode(object.livemode, config.mode), 'Stripe mode mismatch.');
  const own = (object, p) => {
    modeCheck(object);
    requireMatch(object.metadata?.close_project_id === p.id && object.metadata?.close_lead_id === p.leadId &&
      object.metadata?.close_organization_id === config.organizationId, 'Stripe record does not match this Close project.');
  };

  async function publish(p, message) {
    // PUT existing activities only. No emails, SMS, tasks, or duplicate notes.
    const current = await close(activityPath(p.id));
    requireMatch(current.lead_id === p.leadId && current.organization_id === config.organizationId &&
      current.custom_activity_type_id === config.proposalType, 'Close project was moved or changed.');
    const values = activityFields(proposalFields, {
      status: message, link: p.linkId ? `${config.origin}/proposal/#${p.linkId}` : null,
      deposit: p.depositId || null, final: p.finalId || null, subscription: p.subscriptionId || null,
    });
    const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => (current[key] ?? null) !== value));
    if (Object.keys(changed).length) await close(activityPath(p.id), changed);
  }

  async function createProposal(activity) {
    const title = String(field(activity, proposalFields.project) || '').trim();
    requireMatch(title.length > 0 && title.length <= 120 && !/[\r\n\u0000-\u001f]/.test(title), 'Enter a project name of 1–120 characters.');
    const build = dollarsToCents(field(activity, proposalFields.build), { minimum: 100000, whole: true });
    const hosting = dollarsToCents(field(activity, proposalFields.hosting), { minimum: 5000 });
    await store.create({ id: activity.id, leadId: activity.lead_id, title, build, hosting, stage: 'creating' });
    await store.withLock(activity.id, async (p, tx) => {
      requireMatch(p.leadId === activity.lead_id && p.title === title && p.build === build && p.hosting === hosting,
        'This proposal is already locked to its original prices. Create a new proposal after deactivating the old payment link in Stripe.');
      if (p.linkId) return refresh(p, tx); // Retry a failed Close update without creating another link.
      const hostingPrice = await tx.post('hosting-price', 'prices', {
        currency: 'usd', unit_amount: String(p.hosting), 'recurring[interval]': 'month',
        'product_data[name]': `${p.title} — monthly website hosting`, ...meta(metadata(p)),
      }, api);
      const depositPrice = await tx.post('deposit-price', 'prices', {
        currency: 'usd', unit_amount: String(p.build / 2), 'product_data[name]': `${p.title} — 50% website deposit`, ...meta(metadata(p)),
      }, api);
      p.hostingPriceId = hostingPrice.id;
      const terms = `I authorize the deposit shown above, saving my card, an equal final build payment when my website goes live, and the monthly hosting amount shown in my proposal starting 30 days after launch until canceled. Changes require separate approval. Cancel future hosting renewals at contact@nolimitwebs.com before the next renewal. I accept the [billing terms](${config.origin}/billing-terms/).`;
      const link = await tx.post('payment-link', 'payment_links', {
        'line_items[0][price]': depositPrice.id, 'line_items[0][quantity]': '1', customer_creation: 'always',
        'payment_method_types[0]': 'card', 'payment_intent_data[setup_future_usage]': 'off_session',
        'restrictions[completed_sessions][limit]': '1', 'consent_collection[terms_of_service]': 'required',
        'custom_text[terms_of_service_acceptance][message]': terms,
        'invoice_creation[enabled]': 'true', 'invoice_creation[invoice_data][description]': 'Website build — 50% deposit',
        'invoice_creation[invoice_data][footer]': FOOTER,
        'after_completion[type]': 'redirect',
        'after_completion[redirect][url]': `${config.origin}/payment-complete/#session_id={CHECKOUT_SESSION_ID}`,
        ...meta({ flow: FLOW, authorization_version: TERMS, project_name: p.title, hosting_price_id: p.hostingPriceId,
          build_total_cents: p.build, hosting_monthly_cents: p.hosting, ...metadata(p) }),
        ...meta({ ...metadata(p), hosting_price_id: p.hostingPriceId, launch_status: 'awaiting_checkout' }, 'invoice_creation[invoice_data][metadata]'),
      }, api);
      const { public: proposal } = await readProposal(link.id, api, config.mode);
      requireMatch(proposal.buildTotal === p.build && proposal.monthlyHosting === p.hosting, 'Created proposal needs review.');
      p.linkId = link.id; p.stage = 'awaiting_deposit'; await tx.save(p);
      await publish(p, 'Proposal ready — copy the proposal link and send it to the client.');
    });
  }

  async function recordDeposit(sessionId) {
    const session = await api(`checkout/sessions/${sessionId}`);
    const projectId = session.metadata?.close_project_id;
    if (!validId('acti', projectId)) return;
    const existing = await store.get(projectId);
    if (!existing) throw new Error('Close project not yet available; retry');
    await store.withLock(projectId, async (p, tx) => {
      own(session, p);
      requireMatch(idOf(session.payment_link) === p.linkId, 'Payment link does not match this project.');
      const result = await completeDeposit(sessionId, api, config.mode);
      if (!result.ready) return;
      requireMatch(!p.depositId || p.depositId === result.invoiceId, 'More than one deposit needs review.');
      const invoice = await api(`invoices/${result.invoiceId}`); own(invoice, p);
      p.depositId = invoice.id; p.customerId = idOf(invoice.customer); p.sessionId = sessionId;
      if (p.stage === 'awaiting_deposit') p.stage = 'deposit_paid';
      await tx.save(p);
      await refresh(p, tx);
    });
  }

  async function validateLaunch(p) {
    const invoice = await api(`invoices/${p.depositId}`); own(invoice, p);
    requireMatch(invoice.status === 'paid' && idOf(invoice.customer) === p.customerId && invoice.currency === 'usd' &&
      invoice.amount_paid === p.build / 2 && invoice.subtotal_excluding_tax === p.build / 2 &&
      !invoice.post_payment_credit_notes_amount && !invoice.pre_payment_credit_notes_amount &&
      invoice.metadata.authorization_accepted === 'true' && invoice.metadata.authorization_version === TERMS &&
      invoice.metadata.authorized_build_total_cents === String(p.build) &&
      invoice.metadata.authorized_hosting_monthly_cents === String(p.hosting) &&
      invoice.metadata.hosting_price_id === p.hostingPriceId &&
      ['close_ready', 'close_processing', 'close_completed'].includes(invoice.metadata.launch_status), 'Paid deposit or billing authorization needs review.');
    const session = await api(`checkout/sessions/${p.sessionId}`); own(session, p);
    requireMatch(idOf(session.invoice) === p.depositId && idOf(session.customer) === p.customerId, 'Deposit session mismatch.');
    const intent = await api(`payment_intents/${idOf(session.payment_intent)}?expand[]=latest_charge`);
    const charge = intent.latest_charge;
    requireMatch(intent.status === 'succeeded' && idOf(intent.customer) === p.customerId && intent.amount_received === p.build / 2 &&
      charge && typeof charge === 'object' && !charge.refunded && !charge.disputed && charge.amount_refunded === 0,
      'The deposit was refunded, disputed, or requires payment review.');
    const customer = await api(`customers/${p.customerId}`); modeCheck(customer);
    const methodId = idOf(customer.invoice_settings?.default_payment_method);
    requireMatch(validId('pm', methodId) && !customer.deleted && !customer.balance, 'Customer card or credit balance needs review in Stripe.');
    const method = await api(`payment_methods/${methodId}`);
    requireMatch(method.type === 'card' && idOf(method.customer) === p.customerId, 'The saved card does not belong to this client.');
    const price = await api(`prices/${p.hostingPriceId}`); modeCheck(price);
    requireMatch(price.active && price.currency === 'usd' && price.unit_amount === p.hosting &&
      price.recurring?.interval === 'month' && price.recurring.interval_count === 1, 'The agreed hosting price needs review.');
    return methodId;
  }

  async function launch(activity) {
    const invoiceId = field(activity, launchFields.invoice);
    requireMatch(validId('in', invoiceId), 'Copy the paid deposit invoice ID from the proposal activity.');
    requireMatch(field(activity, launchFields.authorization) === LAUNCH_AUTHORIZATION, 'Confirm the website is live and signed billing authorization is on file.');
    const projectId = await store.findDeposit(invoiceId);
    requireMatch(projectId, 'This deposit is not a Close-managed project. Use its original Stripe launch workflow.');
    await store.withLock(projectId, async (p, tx) => {
      requireMatch(p.leadId === activity.lead_id, 'This deposit belongs to a different Close client.');
      if (p.stage !== 'launched') {
        const methodId = await validateLaunch(p);
        if (!p.launchAt) {
          // Freeze the launch instant and card once; retries cannot move the
          // first hosting date or change a previous Stripe request's inputs.
          p.launchAt = Math.floor(now() / 1000); p.launchActivityId = activity.id; p.methodId = methodId;
          p.stage = 'launching'; await tx.save(p);
        }
        await tx.post('claim-launch', `invoices/${p.depositId}`, meta({ launch_status: 'close_processing', close_launch_activity_id: p.launchActivityId }), api);
        const final = await tx.post('final-invoice', 'invoices', {
          customer: p.customerId, currency: 'usd', auto_advance: 'false', collection_method: 'charge_automatically',
          default_payment_method: p.methodId, pending_invoice_items_behavior: 'exclude', discounts: '',
          'automatic_tax[enabled]': 'false', 'payment_settings[payment_method_types][0]': 'card',
          description: `${p.title} — final 50% website build balance`, footer: FOOTER,
          ...meta({ ...metadata(p), deposit_invoice_id: p.depositId, billing_phase: 'final_balance' }),
        }, api);
        p.finalId = final.id; await tx.save(p);
        await tx.post('final-item', 'invoiceitems', {
          customer: p.customerId, invoice: p.finalId, currency: 'usd', amount: String(p.build / 2),
          discountable: 'false', description: `${p.title} — final 50% website build balance`,
        }, api);
        const draft = await api(`invoices/${p.finalId}`); own(draft, p);
        requireMatch(idOf(draft.customer) === p.customerId && draft.total === p.build / 2 && draft.subtotal === p.build / 2 &&
          draft.currency === 'usd' && !draft.total_discount_amounts?.length && !draft.total_taxes?.length &&
          !draft.starting_balance && ['draft', 'open', 'paid'].includes(draft.status), 'Final invoice amount changed; review before collection.');
        if (draft.status === 'draft') await tx.post('final-finalize', `invoices/${p.finalId}/finalize`, { auto_advance: 'false' }, api);
        // This attempt happens once. A decline stays visible in Close and can
        // be recovered on the same invoice in Stripe.
        const payable = await api(`invoices/${p.finalId}`); own(payable, p);
        if (payable.status !== 'paid') {
          requireMatch(payable.status === 'open' && payable.amount_remaining === p.build / 2 && payable.total === p.build / 2,
            'Final invoice balance changed; review before collection.');
          await tx.post('final-pay', `invoices/${p.finalId}/pay`, { off_session: 'true', payment_method: p.methodId }, api);
        }
        requireMatch(p.launchAt + 30 * 86400 > Math.floor(now() / 1000), 'Hosting start date has passed. Review the interrupted launch in Stripe.');
        const subscription = await tx.post('hosting-subscription', 'subscriptions', {
          customer: p.customerId, 'items[0][price]': p.hostingPriceId, 'items[0][quantity]': '1',
          default_payment_method: p.methodId, collection_method: 'charge_automatically',
          trial_end: String(p.launchAt + 30 * 86400), 'trial_settings[end_behavior][missing_payment_method]': 'pause',
          'payment_settings[payment_method_types][0]': 'card', 'payment_settings[save_default_payment_method]': 'on_subscription',
          'automatic_tax[enabled]': 'false', discounts: '', description: `${p.title} — monthly website hosting`,
          ...meta({ ...metadata(p), deposit_invoice_id: p.depositId, billing_phase: 'hosting' }),
        }, api);
        p.subscriptionId = subscription.id; await tx.save(p);
        await tx.post('complete-launch', `invoices/${p.depositId}`, meta({ launch_status: 'close_completed',
          final_invoice_id: p.finalId, hosting_subscription_id: p.subscriptionId }), api);
        p.stage = 'launched'; await tx.save(p);
      }
      await refresh(p, tx);
      const result = `Launch recorded. Final invoice: ${p.finalId}. Hosting subscription: ${p.subscriptionId}. See the proposal activity for current payment status.`;
      if (field(activity, launchFields.result) !== result) await close(activityPath(activity.id), activityFields(launchFields, { result }));
    });
  }

  async function refresh(p, tx) {
    let message = p.depositId ? 'Deposit paid — ready for website launch.' : 'Proposal ready — awaiting deposit.';
    if (p.finalId) {
      const invoice = await api(`invoices/${p.finalId}`); own(invoice, p);
      message = invoice.status === 'paid' ? 'Final balance paid.' : `Final balance ${invoice.status} — review payment in Stripe.`;
    }
    if (p.subscriptionId) {
      const subscription = await api(`subscriptions/${p.subscriptionId}`); own(subscription, p);
      let hosting = `Hosting ${subscription.status}`;
      if (subscription.status === 'trialing') hosting = `Hosting starts ${new Date(subscription.trial_end * 1000).toISOString().slice(0, 10)}`;
      if (subscription.cancel_at_period_end) hosting += ' — cancellation scheduled';
      if (subscription.pause_collection) hosting += ' — collection paused';
      if (idOf(subscription.latest_invoice)) {
        const invoice = await api(`invoices/${idOf(subscription.latest_invoice)}`); modeCheck(invoice);
        requireMatch(idOf(invoice.customer) === p.customerId, 'Hosting invoice mismatch.');
        if (invoice.amount_due > 0) hosting += invoice.status === 'paid' ? ' — latest invoice paid' : ` — latest invoice ${invoice.status}, payment needs attention`;
      }
      message += ` ${hosting}.`;
    }
    if (p.review) message = `Review required: ${p.review}`;
    await publish(p, message);
  }

  async function onClose(payload) {
    const event = payload?.event;
    requireMatch(payload?.subscription_id === config.subscriptionId && event?.organization_id === config.organizationId, 'Wrong Close organization or subscription.');
    if (!['created', 'updated'].includes(event.action) || event.object_type !== 'activity.custom_activity' || !validId('acti', event.object_id)) return;
    // Re-fetch the authoritative activity: webhook updates may arrive late or
    // out of order, and drafts must never trigger billing.
    const activity = await close(activityPath(event.object_id));
    requireMatch(activity.id === event.object_id && activity.organization_id === config.organizationId &&
      validId('lead', activity.lead_id) && activity.lead_id === event.lead_id, 'Close activity identity mismatch.');
    if (activity.status !== 'published' || !Number.isFinite(Date.parse(activity.date_created)) || Date.parse(activity.date_created) < Date.parse(config.enabledAfter) ||
        ![config.proposalType, config.launchType].includes(activity.custom_activity_type_id)) return;
    try {
      if (activity.custom_activity_type_id === config.proposalType) await createProposal(activity);
      else await launch(activity);
    } catch (error) {
      if (!(error instanceof ReviewRequired)) throw error;
      const output = activity.custom_activity_type_id === config.proposalType ? proposalFields.status : launchFields.result;
      const message = `Review required: ${error.message}`;
      if (activity[`custom.${output}`] !== message) await close(activityPath(activity.id), { [`custom.${output}`]: message });
    }
  }

  async function onStripe(event) {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      return recordDeposit(event.data.object.id);
    }
    let object;
    if (event.type.startsWith('invoice.')) object = await api(`invoices/${event.data.object.id}`);
    else if (event.type.startsWith('customer.subscription.')) object = await api(`subscriptions/${event.data.object.id}`);
    else return;
    let projectId = object.metadata?.close_project_id;
    const subscriptionId = idOf(object.parent?.subscription_details?.subscription) || idOf(object.subscription);
    if (!projectId && subscriptionId) {
      const subscription = await api(`subscriptions/${subscriptionId}`);
      projectId = subscription.metadata?.close_project_id;
    }
    if (!validId('acti', projectId)) return;
    if (!await store.get(projectId)) throw new Error('Close project not yet available; retry');
    await store.withLock(projectId, async (p, tx) => {
      modeCheck(object);
      requireMatch(idOf(object.customer) === p.customerId &&
        (object.id === p.depositId || object.id === p.finalId || object.id === p.subscriptionId || subscriptionId === p.subscriptionId),
        'Payment notification does not match this project.');
      await refresh(p, tx);
    });
  }
  return { onClose, onStripe };
}
