import { Buffer } from 'node:buffer';
import { completeDeposit, configure, envVar, expectedMode, reply, verifyEvent } from '../../lib/stripe.mjs';
import { createBillingService } from '../../lib/close-billing.mjs';

export async function onRequest({ request, env }) {
  configure(env);
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const secret = envVar('STRIPE_WEBHOOK_SECRET');
  if (!secret) return reply({ error: 'Not configured' }, 503);
  let event;
  try {
    if (Number(request.headers.get('content-length')) > 1048576) return reply({ error: 'Too large' }, 413);
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > 1048576) return reply({ error: 'Too large' }, 413);
    event = verifyEvent(raw, request.headers.get('stripe-signature'), secret);
  } catch { return reply({ error: 'Invalid signature' }, 400); }
  if (!expectedMode(event.livemode)) return reply({ error: 'Wrong mode' }, 400);
  try {
    if (['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      await completeDeposit(event.data.object.id);
    }
    // Disabled until the native Close forms, secrets and database are ready.
    // Existing website checkout continues to work without a Close connection.
    const billing = createBillingService(env);
    if (billing) await billing.onStripe(event);
    return reply({ received: true });
  } catch {
    // A non-2xx response asks Stripe to retry; never acknowledge incomplete setup.
    console.error('Deposit setup needs retry', { eventId: event.id });
    return reply({ error: 'Setup pending; retry delivery' }, 500);
  }
}
