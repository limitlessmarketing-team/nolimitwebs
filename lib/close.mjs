import { createHmac, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';

export const LAUNCH_AUTHORIZATION = 'Website is live and signed billing authorization is on file';
export class ReviewRequired extends Error {}

export function verifyCloseEvent(raw, headers, secret, now = Date.now()) {
  const timestamp = headers.get('close-sig-timestamp');
  const signature = headers.get('close-sig-hash');
  if (!/^[a-f0-9]{64}$/i.test(secret || '') || !/^\d+$/.test(timestamp || '') ||
      Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/i.test(signature || '')) {
    throw new Error('Invalid Close signature');
  }
  const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update(timestamp).update(raw).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('Invalid Close signature');
  return JSON.parse(raw.toString('utf8'));
}

export function dollarsToCents(value, { minimum = 0, whole = false } = {}) {
  const text = String(value ?? '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new ReviewRequired('Enter prices in dollars with at most two decimal places.');
  const [dollars, fraction = ''] = text.split('.');
  const cents = Number(dollars) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents < minimum || cents > 99999999 || (whole && cents % 100)) {
    throw new ReviewRequired(whole ? 'Website build price must be at least $1,000 in whole dollars.' : 'Monthly hosting must be at least $50.');
  }
  return cents;
}

export function createCloseClient(env, fetcher = fetch) {
  if (!env.CLOSE_API_KEY) throw new Error('Close is not configured');
  return async (path, params) => {
    // No caller-controlled hosts, arbitrary API paths, or contact messaging endpoints.
    if (!/^activity\/custom\/acti_[A-Za-z0-9]+\/$/.test(path)) throw new Error('Invalid Close path');
    const response = await fetcher(`https://api.close.com/api/v1/${path}`, {
      method: params ? 'PUT' : 'GET',
      headers: { Authorization: `Basic ${Buffer.from(`${env.CLOSE_API_KEY}:`).toString('base64')}`,
        ...(params ? { 'Content-Type': 'application/json' } : {}) },
      body: params ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) { const error = new Error('Close request failed'); error.status = response.status; throw error; }
    return response.json();
  };
}

export function billingConfig(env) {
  if (env.CLOSE_BILLING_ENABLED !== 'true') return null;
  const config = JSON.parse(env.CLOSE_BILLING_CONFIG || '{}');
  if (!['test', 'live'].includes(env.STRIPE_MODE) || config.mode !== env.STRIPE_MODE ||
      !/^orga_[A-Za-z0-9]+$/.test(config.organizationId || '') ||
      !/^whsub_[A-Za-z0-9]+$/.test(config.subscriptionId || '') ||
      !/^actitype_[A-Za-z0-9]+$/.test(config.proposalType || '') ||
      !/^actitype_[A-Za-z0-9]+$/.test(config.launchType || '') || config.proposalType === config.launchType ||
      !Number.isFinite(Date.parse(config.enabledAfter))) throw new Error('Invalid Close billing configuration');
  for (const name of ['project', 'build', 'hosting', 'status', 'link', 'deposit', 'final', 'subscription']) {
    if (!/^cf_[A-Za-z0-9]+$/.test(config.proposalFields?.[name] || '')) throw new Error('Missing proposal field');
  }
  for (const name of ['invoice', 'authorization', 'result']) {
    if (!/^cf_[A-Za-z0-9]+$/.test(config.launchFields?.[name] || '')) throw new Error('Missing launch field');
  }
  return { ...config, origin: config.mode === 'live' ? 'https://nolimitwebs.com' : 'https://stripe-sandbox.nolimitwebs.pages.dev' };
}

export const field = (activity, id) => activity[`custom.${id}`];
export function activityFields(ids, values) {
  return Object.fromEntries(Object.entries(values).map(([name, value]) => [`custom.${ids[name]}`, value]));
}
