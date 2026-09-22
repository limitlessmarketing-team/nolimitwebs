import { DOMAIN_TERMS } from './domain-billing.mjs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

// Runtime configuration. On Cloudflare Pages the secrets arrive on the
// request context (`context.env`), so each function calls configure(env)
// before touching Stripe. Anything else (tests, Node) falls back to process.env
let ENV = null;
export function configure(env) { ENV = env || null; }
export function envVar(name) {
  if (ENV && ENV[name] !== undefined) return ENV[name];
  return globalThis.process?.env?.[name];
}

export const FLOW = 'website_proposal_v1';
export const VERSION = '2026-08-26.dahlia';
export const TERMS = '2026-09-09';
export const FULL_TERMS = 'full-upfront-2026-09-22';
export const FULL_PLAN = 'full_upfront';
export const upfrontAmount = p => p.paymentPlan === FULL_PLAN ? p.build : p.build / 2;
export const idOf = value => typeof value === 'string' ? value : value?.id;

export function reply(data, status = 200) {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  } });
}

export async function stripe(path, params, key, fetcher = fetch, secret = envVar('STRIPE_SECRET_KEY')) {
  if (!secret) throw new Error('Stripe is not configured');
  const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Stripe-Version': VERSION,
      ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: params ? new URLSearchParams(params) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const data = await response.json();
  if (!response.ok) {
    // Do not return Stripe responses or customer data to browsers/logs.
    const error = new Error('Stripe request failed');
    error.status = response.status;
    error.code = data.error?.code;
    throw error;
  }
  return data;
}

export function expectedMode(value, mode = envVar('STRIPE_MODE')) {
  return typeof value === 'boolean' && value === (mode === 'live');
}

export function verifyEvent(raw, header, secret, now = Date.now()) {
  if (!secret || typeof header !== 'string') throw new Error('Invalid signature');
  const parts = header.split(',').map(part => part.split('='));
  const time = parts.find(([key]) => key === 't')?.[1];
  if (!/^\d+$/.test(time || '') || Math.abs(now / 1000 - Number(time)) > 300) {
    throw new Error('Expired signature');
  }
  const expected = createHmac('sha256', secret).update(`${time}.`).update(raw).digest();
  const valid = parts.some(([key, value]) => key === 'v1' && /^[a-f0-9]{64}$/.test(value || '') &&
    timingSafeEqual(expected, Buffer.from(value, 'hex')));
  if (!valid) throw new Error('Invalid signature');
  return JSON.parse(raw.toString('utf8'));
}

export async function readProposal(id, api = stripe, mode = envVar('STRIPE_MODE')) {
  if (!/^plink_[A-Za-z0-9]{12,100}$/.test(id || '')) throw new Error('Unavailable proposal');
  const link = await api(`payment_links/${id}`);
  const full = link.metadata?.payment_plan === FULL_PLAN;
  const termsVersion = full ? FULL_TERMS : TERMS;
  if ((link.metadata?.payment_plan && ![FULL_PLAN, 'deposit_50'].includes(link.metadata.payment_plan)) ||
      (full && !/^acti_[A-Za-z0-9]+$/.test(link.metadata.close_project_id || '')) ||
      link.metadata?.flow !== FLOW || link.metadata.authorization_version !== termsVersion || !expectedMode(link.livemode, mode)) throw new Error('Unavailable proposal');
  const hostingId = link.metadata.hosting_price_id;
  if (!/^price_[A-Za-z0-9]+$/.test(hostingId || '')) throw new Error('Invalid hosting price');
  const [lines, hosting] = await Promise.all([
    api(`payment_links/${id}/line_items?limit=2`), api(`prices/${hostingId}`),
  ]);
  const domainAmount = Number(link.metadata.domain_amount_cents || 0);
  const domainName = link.metadata.domain_name || '';
  const hasDomain = domainAmount > 0;
  const all = lines.data || [];
  const domainItem = hasDomain ? all.find(v => v.price?.metadata?.domain_authorization_version === DOMAIN_TERMS) : null;
  const item = hasDomain ? all.find(v => v !== domainItem) : all[0];
  const deposit = item?.price?.unit_amount ?? (hasDomain ? 0 : undefined);
  // Stripe's native monetary bindings require Decimal inputs. Enforce whole
  // dollar build prices here so rounding never changes the agreed deposit.
  const buildCents = Number(link.metadata.build_total_cents);
  const hostingCents = Number(link.metadata.hosting_monthly_cents);
  if (lines.has_more || all.length !== (hasDomain ? (buildCents > 0 ? 2 : 1) : 1) ||
      (item && (item.quantity !== 1 || item.price?.recurring || item.currency !== 'usd')) ||
      !Number.isSafeInteger(domainAmount) || domainAmount < 0 ||
      (hasDomain && (domainAmount < 50 || !domainName || link.metadata.domain_authorization_version !== DOMAIN_TERMS ||
        domainItem?.quantity !== 1 || domainItem?.currency !== 'usd' || domainItem?.price?.recurring || domainItem?.price?.unit_amount !== domainAmount ||
        domainItem?.price?.metadata?.domain_name !== domainName || domainItem?.price?.metadata?.domain_amount_cents !== String(domainAmount))) ||
      (!hasDomain && (domainName || link.metadata.domain_authorization_version)) ||
      !Number.isSafeInteger(deposit) || deposit < 0 || (!deposit && !hasDomain) ||
      !Number.isSafeInteger(hosting.unit_amount) || hosting.unit_amount < 0 ||
      !Number.isSafeInteger(buildCents) || buildCents % 100 !== 0 || (full ? buildCents : buildCents / 2) !== deposit ||
      !Number.isSafeInteger(hostingCents) || hostingCents !== hosting.unit_amount ||
      hosting.currency !== 'usd' || hosting.recurring?.interval !== 'month' ||
      hosting.recurring?.interval_count !== 1 || !expectedMode(hosting.livemode, mode) ||
      link.allow_promotion_codes || link.automatic_tax?.enabled ||
      link.restrictions?.completed_sessions?.limit !== 1 ||
      link.customer_creation !== 'always' || !link.invoice_creation?.enabled ||
      link.consent_collection?.terms_of_service !== 'required' ||
      link.payment_intent_data?.setup_future_usage !== 'off_session' ||
      link.payment_method_types?.length !== 1 || link.payment_method_types[0] !== 'card') {
    throw new Error('Proposal requires review');
  }
  const checkoutUrl = new URL(link.url);
  if (checkoutUrl.protocol !== 'https:' || checkoutUrl.hostname !== 'buy.stripe.com') throw new Error('Invalid checkout URL');
  return { link, hosting, public: {
    title: link.metadata.project_name || 'Your custom website',
    buildTotal: buildCents, deposit, balance: full ? 0 : deposit,
    domainAmount, domainName, totalDue: deposit + domainAmount,
    kind: buildCents === 0 && hasDomain ? 'hosting_domain_v1' : undefined,
    paymentPlan: full ? FULL_PLAN : 'deposit_50',
    monthlyHosting: hosting.unit_amount, currency: 'usd',
    active: link.active, checkoutUrl: link.active ? checkoutUrl.href : null,
    testMode: !link.livemode,
  } };
}

export async function completeDeposit(sessionId, api = stripe, mode = envVar('STRIPE_MODE')) {
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId || '')) throw new Error('Invalid session');
  const session = await api(`checkout/sessions/${sessionId}`);
  if (session.metadata?.flow !== FLOW) return { ignored: true };
  if (!expectedMode(session.livemode, mode)) throw new Error('Wrong Stripe mode');
  if (session.status !== 'complete' || session.payment_status !== 'paid') return { pending: true };
  if (session.mode !== 'payment' || session.consent?.terms_of_service !== 'accepted') throw new Error('Missing authorization');
  const { link, public: proposal, hosting } = await readProposal(idOf(session.payment_link), api, mode);
  if (session.metadata.hosting_price_id !== hosting.id || session.metadata.authorization_version !== link.metadata.authorization_version ||
      (session.metadata.payment_plan || 'deposit_50') !== proposal.paymentPlan ||
      session.metadata.build_total_cents !== link.metadata.build_total_cents ||
      session.metadata.hosting_monthly_cents !== link.metadata.hosting_monthly_cents ||
      (session.metadata.domain_amount_cents || '') !== (link.metadata.domain_amount_cents || '') ||
      (session.metadata.domain_name || '') !== (link.metadata.domain_name || '') ||
      (session.metadata.domain_authorization_version || '') !== (link.metadata.domain_authorization_version || '')) throw new Error('Proposal changed after checkout');
  const customerId = idOf(session.customer);
  const invoiceId = idOf(session.invoice);
  if (!customerId || !invoiceId || session.currency !== 'usd' || session.amount_total !== proposal.totalDue ||
      session.amount_subtotal !== proposal.totalDue || session.total_details?.amount_discount || session.total_details?.amount_tax) {
    throw new Error('Deposit requires review');
  }
  const invoice = await api(`invoices/${invoiceId}`);
  if (invoice.status !== 'paid' || idOf(invoice.customer) !== customerId ||
      invoice.subtotal_excluding_tax !== proposal.totalDue || invoice.amount_paid !== proposal.totalDue) {
    throw new Error('Invoice not ready');
  }
  // A redelivery must never reset a launched invoice or overwrite a replacement card.
  if (['ready', 'processing', 'completed', 'close_ready', 'close_processing', 'close_completed'].includes(invoice.metadata?.launch_status)) {
    if (invoice.metadata?.checkout_session_id !== session.id) throw new Error('Invoice mismatch');
    return { ready: true, invoiceId };
  }
  const intent = await api(`payment_intents/${idOf(session.payment_intent)}`);
  const method = await api(`payment_methods/${idOf(intent.payment_method)}`);
  if (intent.status !== 'succeeded' || intent.setup_future_usage !== 'off_session' ||
      idOf(intent.customer) !== customerId || idOf(method.customer) !== customerId || method.type !== 'card') {
    throw new Error('Saved payment method not ready');
  }
  await api(`customers/${customerId}`, {
    'invoice_settings[default_payment_method]': method.id,
  }, `proposal-default-card-${invoiceId}`);
  await api(`invoices/${invoiceId}`, {
    'metadata[hosting_price_id]': hosting.id,
    'metadata[checkout_session_id]': session.id,
    'metadata[payment_link_id]': link.id,
    'metadata[authorization_version]': link.metadata.authorization_version,
    'metadata[payment_plan]': proposal.paymentPlan,
    'metadata[authorization_accepted]': 'true',
    'metadata[authorized_build_total_cents]': String(proposal.buildTotal),
    'metadata[authorized_hosting_monthly_cents]': String(proposal.monthlyHosting),
    ...(proposal.domainAmount ? { 'metadata[authorized_domain_amount_cents]': String(proposal.domainAmount),
      'metadata[authorized_domain_name]': proposal.domainName, 'metadata[domain_authorization_version]': DOMAIN_TERMS } : {}),
    // Close-managed projects have their own launch lock. Keep the older native
    // workflow (which requires "ready") from also charging the same deposit.
    'metadata[launch_status]': link.metadata.close_project_id ? 'close_ready' : 'ready',
  }, `proposal-launch-ready-${invoiceId}`);
  return { ready: true, invoiceId };
}
