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
export const idOf = value => typeof value === 'string' ? value : value?.id;

export function reply(data, status = 200) {
  return Response.json(data, { status, headers: {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
  } });
}

export async function stripe(path, params, key, fetcher = fetch) {
  if (!envVar('STRIPE_SECRET_KEY')) throw new Error('Stripe is not configured');
  const response = await fetcher(`https://api.stripe.com/v1/${path}`, {
    method: params ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${envVar('STRIPE_SECRET_KEY')}`,
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

export function expectedMode(value) {
  return typeof value === 'boolean' && value === (envVar('STRIPE_MODE') === 'live');
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

export async function readProposal(id, api = stripe) {
  if (!/^plink_[A-Za-z0-9]{12,100}$/.test(id || '')) throw new Error('Unavailable proposal');
  const link = await api(`payment_links/${id}`);
  if (link.metadata?.flow !== FLOW || link.metadata.authorization_version !== TERMS || !expectedMode(link.livemode)) throw new Error('Unavailable proposal');
  const hostingId = link.metadata.hosting_price_id;
  if (!/^price_[A-Za-z0-9]+$/.test(hostingId || '')) throw new Error('Invalid hosting price');
  const [lines, hosting] = await Promise.all([
    api(`payment_links/${id}/line_items?limit=2`), api(`prices/${hostingId}`),
  ]);
  const item = lines.data?.[0];
  const deposit = item?.price?.unit_amount;
  // Stripe's native monetary bindings require Decimal inputs. Enforce whole
  // dollar build prices here so rounding never changes the agreed deposit.
  const buildCents = Number(link.metadata.build_total_cents);
  const hostingCents = Number(link.metadata.hosting_monthly_cents);
  if (lines.has_more || lines.data?.length !== 1 || item?.quantity !== 1 ||
      item?.price?.recurring || item?.currency !== 'usd' ||
      !Number.isSafeInteger(deposit) || deposit < 50000 ||
      !Number.isSafeInteger(hosting.unit_amount) || hosting.unit_amount < 5000 ||
      !Number.isSafeInteger(buildCents) || buildCents % 100 !== 0 || buildCents / 2 !== deposit ||
      !Number.isSafeInteger(hostingCents) || hostingCents !== hosting.unit_amount ||
      hosting.currency !== 'usd' || hosting.recurring?.interval !== 'month' ||
      hosting.recurring?.interval_count !== 1 || !expectedMode(hosting.livemode) ||
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
    buildTotal: deposit * 2, deposit, balance: deposit,
    monthlyHosting: hosting.unit_amount, currency: 'usd',
    active: link.active, checkoutUrl: link.active ? checkoutUrl.href : null,
    testMode: !link.livemode,
  } };
}

export async function completeDeposit(sessionId, api = stripe) {
  if (!/^cs_(test_|live_)?[A-Za-z0-9]+$/.test(sessionId || '')) throw new Error('Invalid session');
  const session = await api(`checkout/sessions/${sessionId}`);
  if (session.metadata?.flow !== FLOW) return { ignored: true };
  if (!expectedMode(session.livemode)) throw new Error('Wrong Stripe mode');
  if (session.status !== 'complete' || session.payment_status !== 'paid') return { pending: true };
  if (session.mode !== 'payment' || session.consent?.terms_of_service !== 'accepted') throw new Error('Missing authorization');
  const { link, public: proposal, hosting } = await readProposal(idOf(session.payment_link), api);
  if (session.metadata.hosting_price_id !== hosting.id || session.metadata.authorization_version !== TERMS ||
      session.metadata.build_total_cents !== link.metadata.build_total_cents ||
      session.metadata.hosting_monthly_cents !== link.metadata.hosting_monthly_cents) throw new Error('Proposal changed after checkout');
  const customerId = idOf(session.customer);
  const invoiceId = idOf(session.invoice);
  if (!customerId || !invoiceId || session.currency !== 'usd' || session.amount_total !== proposal.deposit ||
      session.amount_subtotal !== proposal.deposit || session.total_details?.amount_discount || session.total_details?.amount_tax) {
    throw new Error('Deposit requires review');
  }
  const invoice = await api(`invoices/${invoiceId}`);
  if (invoice.status !== 'paid' || idOf(invoice.customer) !== customerId ||
      invoice.subtotal_excluding_tax !== proposal.deposit || invoice.amount_paid !== proposal.deposit) {
    throw new Error('Invoice not ready');
  }
  // A redelivery must never reset a launched invoice or overwrite a replacement card.
  if (['ready', 'processing', 'completed'].includes(invoice.metadata?.launch_status)) {
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
    'metadata[authorization_version]': TERMS,
    'metadata[authorization_accepted]': 'true',
    'metadata[authorized_build_total_cents]': String(proposal.buildTotal),
    'metadata[authorized_hosting_monthly_cents]': String(proposal.monthlyHosting),
    'metadata[launch_status]': 'ready',
  }, `proposal-launch-ready-${invoiceId}`);
  return { ready: true, invoiceId };
}
