import { createBillingService } from '../../lib/close-billing.mjs';
import { hostingToken } from '../../lib/hosting-billing.mjs';
import { configure, readProposal, reply } from '../../lib/stripe.mjs';

export async function onRequest({ request, env }) {
  configure(env);
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (hostingToken(id)) return reply(await createBillingService(env).hostingProposal(id));
    const { public: proposal } = await readProposal(id);
    return reply(proposal);
  } catch {
    return reply({ error: 'This proposal is unavailable. Please contact our team for your current proposal link.' }, 404);
  }
}
