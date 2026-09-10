import { configure, envVar, reply, stripe } from '../../lib/stripe.mjs';

// Configuration check: confirms the Stripe key on this deployment authenticates
// and is in the expected mode. Reveals nothing about keys or customers.
export async function onRequest({ request, env }) {
  configure(env);
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  const mode = envVar('STRIPE_MODE') === 'live' ? 'live' : 'test';
  const out = { mode, secretKey: !!envVar('STRIPE_SECRET_KEY'), webhookSecret: !!envVar('STRIPE_WEBHOOK_SECRET'), stripe: 'unchecked' };
  if (!out.secretKey) { out.stripe = 'missing'; return reply(out); }
  try {
    const list = await stripe('payment_links?limit=1');
    out.stripe = (list.data?.[0] ? (list.data[0].livemode ? 'live' : 'test') === mode : true) ? 'ok' : 'mode-mismatch';
  } catch (error) {
    out.stripe = error.status === 401 ? 'invalid-key' : error.status === 403 ? 'key-lacks-permission' : 'error';
  }
  return reply(out);
}
