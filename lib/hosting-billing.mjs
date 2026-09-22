import { randomBytes } from 'node:crypto';
import { idOf, expectedMode } from './stripe.mjs';
import { ReviewRequired } from './close.mjs';

export const HOSTING_FLOW = 'hosting_only_v1';
export const HOSTING_TERMS = 'hosting-at-launch-2026-09-22';
export const hostingToken = value => /^host_[a-f0-9]{64}$/.test(value || '');
const requireMatch = (ok, message) => { if (!ok) throw new ReviewRequired(message); };
const meta = (values, prefix = 'metadata') => Object.fromEntries(Object.entries(values).map(([k,v]) => [`${prefix}[${k}]`, String(v)]));

export function hostingBilling({ api, store, config, own, metadata, publish, refresh, now }) {
  const auth = p => ({ ...metadata(p), flow: HOSTING_FLOW, authorization_version: HOSTING_TERMS,
    hosting_price_id: p.hostingPriceId, hosting_monthly_cents: String(p.hosting), build_total_cents: '0' });
  async function price(p) {
    const v = await api(`prices/${p.hostingPriceId}`); own(v, p);
    requireMatch(v.active && v.currency === 'usd' && v.unit_amount === p.hosting && v.recurring?.interval === 'month' &&
      v.recurring.interval_count === 1, 'The agreed hosting price needs review.');
  }
  async function create(p, tx) {
    p.kind = HOSTING_FLOW;
    if (!p.hostingPriceId) {
      const v = await tx.post('hosting-price', 'prices', { currency: 'usd', unit_amount: String(p.hosting),
        'recurring[interval]': 'month', 'product_data[name]': `${p.title} — monthly website hosting`, ...meta(metadata(p)) }, api);
      p.hostingPriceId = v.id;
    }
    await price(p);
    p.linkId ||= `host_${randomBytes(32).toString('hex')}`;
    p.stage = 'awaiting_setup'; await tx.save(p);
    await publish(p, 'Hosting proposal ready — copy the proposal link and send it to the client. Nothing due today.', tx);
  }
  async function publicProposal(token) {
    requireMatch(hostingToken(token), 'Unavailable proposal.');
    const p = await store.findHostingToken(token);
    requireMatch(p?.kind === HOSTING_FLOW && !p.review, 'Unavailable proposal.');
    // Verify source existence without publishing side effects from a public read.
    await config.checkActivity(p);
    await price(p);
    return { kind: HOSTING_FLOW, title: p.title, buildTotal: 0, deposit: 0, balance: 0, monthlyHosting: p.hosting,
      currency: 'usd', testMode: config.mode === 'test', active: !p.setupAccepted && p.stage === 'awaiting_setup', checkoutUrl: null };
  }
  async function checkout(token) {
    requireMatch(hostingToken(token), 'Unavailable proposal.');
    const existing = await store.findHostingToken(token);
    requireMatch(existing?.kind === HOSTING_FLOW, 'Unavailable proposal.');
    return store.withLock(existing.id, async (p, tx) => {
      await config.checkActivity(p);
      requireMatch(!p.review && p.stage === 'awaiting_setup' && !p.setupAccepted, 'This proposal is already accepted or unavailable.');
      await price(p);
      if (!p.customerId) {
        const customer = await tx.post('hosting-customer', 'customers', { description: `${p.title} — hosting signup`, ...meta(metadata(p)) }, api);
        p.customerId = customer.id; await tx.save(p);
      }
      const customer = await api(`customers/${p.customerId}`); own(customer, p);
      requireMatch(!customer.deleted, 'Customer requires review.');
      let session;
      if (p.setupSessionId) {
        session = await api(`checkout/sessions/${p.setupSessionId}`); own(session, p);
        if (session.status === 'complete') { await accept(p, tx, session); throw new ReviewRequired('Card already saved. No payment is due today.'); }
        if (session.status !== 'expired') return sessionUrl(session);
        p.setupAttempt = (p.setupAttempt || 0) + 1;
        p.setupSessionId = null; await tx.save(p);
      }
      const terms = `Nothing due today. Website build included. I authorize saving my card and charging $${(p.hosting / 100).toFixed(2)} USD monthly, first charged when my website launches, then monthly until canceled. Changes require separate approval. Cancel future renewals at contact@nolimitwebs.com. I accept the [hosting billing terms](${config.origin}/hosting-terms/).`;
      const receipt = await tx.post(`hosting-setup-${p.setupAttempt || 0}`, 'checkout/sessions', {
        mode: 'setup', customer: p.customerId, currency: 'usd', 'payment_method_types[0]': 'card',
        'consent_collection[terms_of_service]': 'required', 'custom_text[terms_of_service_acceptance][message]': terms,
        'custom_text[submit][message]': `${p.title}: website build included. Nothing due today. $${(p.hosting / 100).toFixed(2)} USD/month beginning at launch.`,
        'setup_intent_data[description]': `${p.title} — authorize monthly hosting at launch`,
        success_url: `${config.origin}/payment-complete/#session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.origin}/proposal/#${p.linkId}`,
        ...meta(auth(p)), ...meta(auth(p), 'setup_intent_data[metadata]'),
      }, api);
      p.setupSessionId = receipt.id; await tx.save(p);
      session = await api(`checkout/sessions/${receipt.id}`); own(session, p);
      return sessionUrl(session);
    });
  }
  function sessionUrl(session) {
    requireMatch(session.mode === 'setup' && session.status === 'open', 'Card setup session is unavailable.');
    const url = new URL(session.url);
    requireMatch(url.protocol === 'https:' && url.hostname === 'checkout.stripe.com', 'Invalid checkout URL.');
    return { checkoutUrl: url.href };
  }
  async function verify(p, session) {
    own(session, p);
    requireMatch(session.id === p.setupSessionId && session.status === 'complete' && session.mode === 'setup' &&
      idOf(session.customer) === p.customerId && session.consent?.terms_of_service === 'accepted' &&
      !session.payment_intent && !session.subscription && !session.invoice && !session.amount_total,
      'Card setup or billing authorization needs review.');
    for (const [key, value] of Object.entries(auth(p))) requireMatch(session.metadata?.[key] === value, 'Hosting agreement changed.');
    requireMatch(/^seti_[A-Za-z0-9]+$/.test(idOf(session.setup_intent) || ''), 'Card setup is missing.');
    const intent = await api(`setup_intents/${idOf(session.setup_intent)}`); own(intent, p);
    for (const [key, value] of Object.entries(auth(p))) requireMatch(intent.metadata?.[key] === value, 'Saved-card agreement changed.');
    requireMatch(intent.status === 'succeeded' && intent.usage === 'off_session' && idOf(intent.customer) === p.customerId,
      'Card setup is not complete.');
    const method = await api(`payment_methods/${idOf(intent.payment_method)}`);
    requireMatch(expectedMode(method.livemode, config.mode) && method.type === 'card' && idOf(method.customer) === p.customerId,
      'Saved card does not belong to this client.');
    await price(p);
    return method.id;
  }
  async function accept(p, tx, session) {
    const methodId = await verify(p, session);
    if (!p.setupAccepted) {
      await tx.post('hosting-default-card', `customers/${p.customerId}`, { 'invoice_settings[default_payment_method]': methodId }, api);
      p.setupAccepted = true; p.setupMethodId = methodId; p.setupAcceptedAt = Math.floor(now() / 1000);
      p.authorizationVersion = HOSTING_TERMS; p.stage = 'card_saved'; await tx.save(p);
    }
    await refresh(p, tx);
  }
  async function record(session) {
    const p = await store.get(session.metadata?.close_project_id);
    requireMatch(p?.kind === HOSTING_FLOW, 'Unknown hosting project.');
    return store.withLock(p.id, async (locked, tx) => {
      if (session.status !== 'complete') return;
      await accept(locked, tx, session);
    });
  }
  async function launch(p, tx, activity) {
    requireMatch(p.setupAccepted && p.authorizationVersion === HOSTING_TERMS && p.setupSessionId, 'Client must accept the hosting proposal and save their card before launch.');
    if (p.stage === 'launched') return refresh(p, tx);
    await config.checkActivity(p);
    const session = await api(`checkout/sessions/${p.setupSessionId}`);
    await verify(p, session);
    const customer = await api(`customers/${p.customerId}`); own(customer, p);
    const methodId = idOf(customer.invoice_settings?.default_payment_method);
    requireMatch(!customer.deleted && !customer.balance && !customer.discount && !customer.discounts?.length &&
      !customer.invoice_settings?.default_tax_rates?.length && /^pm_[A-Za-z0-9]+$/.test(methodId || ''), 'Customer billing settings need review.');
    const method = await api(`payment_methods/${methodId}`);
    requireMatch(expectedMode(method.livemode, config.mode) && method.type === 'card' && idOf(method.customer) === p.customerId, 'Saved card needs review.');
    // Reuse a single subscription and its first invoice even on a decline or timeout.
    if (!p.launchAt) { p.launchAt = Math.floor(now() / 1000); p.launchActivityId = activity.id; p.methodId = methodId; p.stage = 'launching'; await tx.save(p); }
    const subscription = await tx.post('hosting-subscription', 'subscriptions', {
      customer: p.customerId, 'items[0][price]': p.hostingPriceId, 'items[0][quantity]': '1',
      default_payment_method: p.methodId, collection_method: 'charge_automatically',
      payment_behavior: 'allow_incomplete', off_session: 'true',
      'payment_settings[payment_method_types][0]': 'card', 'payment_settings[save_default_payment_method]': 'on_subscription',
      'automatic_tax[enabled]': 'false', discounts: '', default_tax_rates: '',
      description: `${p.title} — monthly website hosting`, ...meta({ ...auth(p), billing_phase: 'hosting' }),
    }, api);
    p.subscriptionId = subscription.id; p.stage = 'launched'; await tx.save(p);
    await refresh(p, tx);
  }
  return { create, publicProposal, checkout, record, launch };
}
