import { BillingStore } from '../../lib/billing-store.mjs';
import { cancellationBlocks, CANCELED_MESSAGE } from '../../lib/cancel-proposal.mjs';
import { createBillingService } from '../../lib/close-billing.mjs';
import { hostingToken } from '../../lib/hosting-billing.mjs';
import { configure, readProposal, reply } from '../../lib/stripe.mjs';

export async function onRequest({ request, env }) {
  configure(env);
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  try {
    const id = new URL(request.url).searchParams.get('id');
    if (env.CLOSE_BILLING_DB && (hostingToken(id) || /^plink_[A-Za-z0-9]{12,100}$/.test(id || ''))) {
      const p = await new BillingStore(env.CLOSE_BILLING_DB,env.STRIPE_MODE).findHostingToken(id);
      if (cancellationBlocks(p)) return reply({ error: CANCELED_MESSAGE },410);
    }
    if (hostingToken(id)) return reply(await createBillingService(env).hostingProposal(id));
    const { public: proposal } = await readProposal(id);
    return reply(proposal);
  } catch {
    return reply({ error: 'This proposal is unavailable. Please contact our team for your current proposal link.' }, 404);
  }
}
