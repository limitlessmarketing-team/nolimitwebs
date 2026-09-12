import { Buffer } from 'node:buffer';
import { reply } from '../../lib/stripe.mjs';
import { verifyCloseEvent, billingConfig } from '../../lib/close.mjs';
import { createBillingService } from '../../lib/close-billing.mjs';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  let config;
  try { config = billingConfig(env); } catch { return reply({ error: 'Not configured' }, 503); }
  if (!config || !env.CLOSE_WEBHOOK_SECRET || !env.CLOSE_BILLING_DB || !env.CLOSE_API_KEY) return reply({ error: 'Not enabled' }, 503);
  let payload;
  try {
    if (Number(request.headers.get('content-length')) > 1048576) return reply({ error: 'Too large' }, 413);
    const raw = Buffer.from(await request.arrayBuffer());
    if (raw.length > 1048576) return reply({ error: 'Too large' }, 413);
    payload = verifyCloseEvent(raw, request.headers, env.CLOSE_WEBHOOK_SECRET);
    if (payload.subscription_id !== config.subscriptionId || payload.event?.organization_id !== config.organizationId) throw new Error('Wrong account');
  } catch { return reply({ error: 'Invalid notification' }, 400); }
  try {
    await createBillingService(env).onClose(payload);
    return reply({ received: true });
  } catch {
    console.error('Close billing delivery needs retry');
    return reply({ error: 'Processing pending; retry delivery' }, 503);
  }
}
