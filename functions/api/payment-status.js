import { FLOW, configure, expectedMode, idOf, reply, stripe } from '../../lib/stripe.mjs';

export async function onRequest({ request, env }) {
  configure(env);
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  const id = new URL(request.url).searchParams.get('session_id');
  if (!/^cs_(test_|live_)?[A-Za-z0-9]{12,200}$/.test(id || '')) return reply({ error: 'Unavailable payment' }, 404);
  try {
    const session = await stripe(`checkout/sessions/${id}`);
    if (session.metadata?.flow !== FLOW || !expectedMode(session.livemode)) throw new Error('Unavailable');
    const paid = session.status === 'complete' && session.payment_status === 'paid';
    let invoiceUrl = null;
    if (paid && session.invoice) {
      const invoice = await stripe(`invoices/${idOf(session.invoice)}`);
      // The session ID is a bearer capability: do not expose any other customer data.
      if (invoice.status === 'paid' && idOf(invoice.customer) === idOf(session.customer) &&
          /^https:\/\/invoice\.stripe\.com\//.test(invoice.hosted_invoice_url || '')) invoiceUrl = invoice.hosted_invoice_url;
    }
    return reply({ paid, amount: paid ? session.amount_total : null, invoiceUrl });
  } catch { return reply({ error: 'We could not verify this payment yet. Please check your Stripe receipt.' }, 404); }
}
