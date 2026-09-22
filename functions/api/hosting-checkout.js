import { createBillingService } from '../../lib/close-billing.mjs';
import { billingConfig } from '../../lib/close.mjs';
import { reply } from '../../lib/stripe.mjs';
import { hostingToken } from '../../lib/hosting-billing.mjs';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  try {
    const config = billingConfig(env);
    if (!config || request.headers.get('origin') !== config.origin ||
        request.headers.get('content-type') !== 'application/json') return reply({ error: 'Invalid request' }, 403);
    if (Number(request.headers.get('content-length')) > 1024) return reply({ error: 'Too large' }, 413);
    const raw = await request.text();
    if (raw.length > 1024) return reply({ error: 'Too large' }, 413);
    const { id } = JSON.parse(raw);
    if (!hostingToken(id)) return reply({ error: 'Unavailable proposal' }, 404);
    return reply(await createBillingService(env).hostingCheckout(id));
  } catch {
    return reply({ error: 'Card setup is unavailable or already completed. Refresh your proposal or contact our team.' }, 409);
  }
}
