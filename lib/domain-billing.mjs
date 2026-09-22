import { ReviewRequired, dollarsToCents, field } from './close.mjs';
import { idOf } from './stripe.mjs';

export const DOMAIN_TERMS = 'domain-annual-2026-09-22';
export function domainInput(activity, fields) {
  const name = String(fields.domainName ? field(activity, fields.domainName) || '' : '').trim().toLowerCase();
  const value = fields.domainAmount ? field(activity, fields.domainAmount) : null;
  const amount = value == null || value === '' ? 0 : dollarsToCents(value);
  if (!name && !amount) return { domainName: '', domainAmount: 0 };
  if (!/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name)) throw new ReviewRequired('Enter the domain name only, such as example.com, without https:// or a path.');
  if (amount < 50) throw new ReviewRequired('Enter a domain price of at least $0.50, or leave both domain fields blank. Stripe cannot collect smaller USD renewal payments.');
  return { domainName: name, domainAmount: amount };
}
export function anniversary(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) throw new ReviewRequired('Domain payment date requires review.');
  const date = new Date(timestamp * 1000), month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return Math.floor(date.getTime() / 1000);
}
export function domainTerms(p) {
  return p.domainAmount ? ` Domain registration for ${p.domainName}: $${(p.domainAmount / 100).toFixed(2)} USD today, then the same amount annually beginning one year after this payment until canceled. I authorize these annual charges to my saved card. Domain renewals and hosting are separate. Cancel future domain billing at contact@nolimitwebs.com before renewal. Price changes require separate approval.` : '';
}
export const dueNow = p => (p.paymentPlan === 'full_upfront' ? p.build : p.build / 2) + (p.domainAmount || 0);
export function domainMetadata(p) {
  return p.domainAmount ? { domain_name: p.domainName, domain_amount_cents: String(p.domainAmount), domain_authorization_version: DOMAIN_TERMS } : {};
}
export function domainBilling({ api, own, metadata, now }) {
  const meta = values => Object.fromEntries(Object.entries(values).map(([k,v]) => [`metadata[${k}]`, String(v)]));
  async function schedule(p, tx, invoice, methodId) {
    if (!p.domainAmount || p.domainSubscriptionId) return;
    if (!/^pm_[A-Za-z0-9]+$/.test(methodId || '')) throw new ReviewRequired('Saved domain payment method requires review.');
    if (invoice.status !== 'paid' || invoice.amount_paid !== dueNow(p) || idOf(invoice.customer) !== p.customerId ||
      invoice.metadata?.authorized_domain_amount_cents !== String(p.domainAmount) || invoice.metadata?.authorized_domain_name !== p.domainName ||
      invoice.metadata?.domain_authorization_version !== DOMAIN_TERMS) throw new ReviewRequired('Paid domain authorization requires review.');
    if (!p.domainRenewAt) {
      p.domainRenewAt = anniversary(invoice.status_transitions?.paid_at);
      p.domainMethodId = methodId;
      await tx.save(p);
    }
    if (p.domainRenewAt <= Math.floor(now()/1000)) throw new ReviewRequired('Domain renewal date has passed; review before scheduling.');
    const price = await tx.post('domain-annual-price', 'prices', { currency: 'usd', unit_amount: String(p.domainAmount),
      'recurring[interval]': 'year', 'product_data[name]': `Domain renewal — ${p.domainName}`, ...meta({ ...metadata(p), ...domainMetadata(p) }) }, api);
    const subscription = await tx.post('domain-subscription', 'subscriptions', {
      customer: p.customerId, 'items[0][price]': price.id, 'items[0][quantity]': '1',
      default_payment_method: p.domainMethodId, collection_method: 'charge_automatically',
      billing_cycle_anchor: String(p.domainRenewAt), proration_behavior: 'none',
      'payment_settings[payment_method_types][0]': 'card', 'payment_settings[save_default_payment_method]': 'on_subscription',
      'automatic_tax[enabled]': 'false', discounts: '', default_tax_rates: '',
      description: `Annual domain renewal — ${p.domainName}`,
      ...meta({ ...metadata(p), ...domainMetadata(p), billing_phase: 'domain_renewal', initial_invoice_id: invoice.id }),
    }, api);
    const saved = await api(`subscriptions/${subscription.id}`); own(saved, p);
    if (idOf(saved.customer) !== p.customerId || saved.billing_cycle_anchor !== p.domainRenewAt) throw new ReviewRequired('Domain renewal schedule requires review.');
    p.domainSubscriptionId = subscription.id; p.domainPriceId = price.id; await tx.save(p);
  }
  async function status(p) {
    if (!p.domainSubscriptionId) return '';
    const sub = await api(`subscriptions/${p.domainSubscriptionId}`); own(sub, p);
    if (idOf(sub.customer) !== p.customerId) throw new ReviewRequired('Domain subscription customer mismatch.');
    let text = ` Domain renewal ${sub.status}; $${(p.domainAmount/100).toFixed(2)}/year for ${p.domainName}.`;
    if (sub.cancel_at_period_end) text += ' Domain cancellation scheduled.';
    if (sub.pause_collection) text += ' Domain collection paused.';
    if (idOf(sub.latest_invoice)) {
      const invoice = await api(`invoices/${idOf(sub.latest_invoice)}`);
      if (idOf(invoice.customer) !== p.customerId || invoice.livemode !== sub.livemode) throw new ReviewRequired('Domain renewal invoice mismatch.');
      if (invoice.amount_due > 0) text += invoice.status === 'paid' ? ' Latest domain invoice paid.' : ` Domain invoice ${invoice.status}; review in Stripe.`;
    }
    return text;
  }
  return { schedule, status };
}
