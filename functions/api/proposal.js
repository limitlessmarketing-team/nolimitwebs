import { configure, readProposal, reply } from '../../lib/stripe.mjs';

export async function onRequest({ request, env }) {
  configure(env);
  if (request.method !== 'GET') return reply({ error: 'Method not allowed' }, 405);
  try {
    const { public: proposal } = await readProposal(new URL(request.url).searchParams.get('id'));
    return reply(proposal);
  } catch {
    return reply({ error: 'This proposal is unavailable. Please contact our team for your current proposal link.' }, 404);
  }
}
