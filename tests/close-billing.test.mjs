import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { BillingStore } from '../lib/billing-store.mjs';
import { createBillingService } from '../lib/close-billing.mjs';
import { dollarsToCents, verifyCloseEvent, LAUNCH_AUTHORIZATION, ReviewRequired } from '../lib/close.mjs';
import { onRequest } from '../functions/api/close-webhook.js';

const clock = Date.parse('2026-09-11T18:00:00Z');
const proposalId = 'acti_project1', launchId = 'acti_launch1', leadId = 'lead_client1';
const config = { mode: 'test', organizationId: 'orga_company', subscriptionId: 'whsub_billing',
  proposalType: 'actitype_proposal', launchType: 'actitype_launch', enabledAfter: '2026-09-11T00:00:00Z',
  proposalFields: Object.fromEntries(['project', 'build', 'hosting', 'status', 'link', 'deposit', 'final', 'subscription'].map(n => [n, `cf_${n}`])),
  launchFields: { invoice: 'cf_invoice', authorization: 'cf_authorization', result: 'cf_result' } };
const env = { STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'rk_test_fake', CLOSE_BILLING_ENABLED: 'true', CLOSE_BILLING_CONFIG: JSON.stringify(config) };

// Execute the actual migration and SQL against SQLite, not a stubbed store.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_close_billing.sql', import.meta.url), 'utf8'));
  return { prepare(sql) { return { bind(...values) { return {
    async first() { return sqlite.prepare(sql).get(...values) || null; },
    async run() { return { meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
  }; } }; } };
}
function metadata(params, prefix = 'metadata') {
  const entries = Object.entries(params).filter(([k]) => k.startsWith(`${prefix}[`));
  return Object.fromEntries(entries.map(([k, v]) => [k.slice(prefix.length + 1, -1), v]));
}
function fixture(options = {}) {
  const data = {}, writes = [], closeWrites = [], receipts = new Map();
  const activities = {
    [proposalId]: { id: proposalId, lead_id: leadId, organization_id: config.organizationId, status: 'published', date_created: '2026-09-11T17:00:00Z',
      custom_activity_type_id: config.proposalType, 'custom.cf_project': 'Example website', 'custom.cf_build': 3500, 'custom.cf_hosting': 149 },
    [launchId]: { id: launchId, lead_id: leadId, organization_id: config.organizationId, status: 'published', date_created: '2026-09-11T18:00:00Z',
      custom_activity_type_id: config.launchType, 'custom.cf_invoice': 'in_deposit', 'custom.cf_authorization': LAUNCH_AUTHORIZATION },
  };
  const close = async (path, params) => {
    const id = path.split('/')[2]; assert.ok(activities[id], `Unknown Close activity: ${path}`);
    if (params) { closeWrites.push({ path, params }); Object.assign(activities[id], params); }
    return structuredClone(activities[id]);
  };
  let declined = false, sequence = 0;
  const api = async (path, params, key) => {
    if (!params) { assert.ok(data[path], `Unknown Stripe read: ${path}`); return structuredClone(data[path]); }
    if (receipts.has(key)) return structuredClone(receipts.get(key));
    writes.push({ path, params: structuredClone(params), key });
    assert.ok(key, `Missing idempotency key: ${path}`);
    let result;
    if (path === 'prices') {
      result = { id: `price_${++sequence}`, livemode: false, active: true, currency: 'usd', unit_amount: Number(params.unit_amount),
        recurring: params['recurring[interval]'] ? { interval: 'month', interval_count: 1 } : null };
      data[`prices/${result.id}`] = result;
    } else if (path === 'payment_links') {
      result = { id: 'plink_1234567890123456', livemode: false, active: true, metadata: metadata(params), url: 'https://buy.stripe.com/test_example',
        restrictions: { completed_sessions: { limit: 1 } }, customer_creation: 'always', invoice_creation: { enabled: true },
        consent_collection: { terms_of_service: 'required' }, payment_intent_data: { setup_future_usage: 'off_session' }, payment_method_types: ['card'] };
      data[`payment_links/${result.id}`] = result;
      data[`payment_links/${result.id}/line_items?limit=2`] = { has_more: false,
        data: [{ currency: 'usd', quantity: 1, price: data[`prices/${params['line_items[0][price]']}`] }] };
    } else if (path === 'invoices') {
      result = { id: 'in_final', livemode: false, status: 'draft', customer: params.customer, metadata: metadata(params), currency: 'usd', total: 0, subtotal: 0 };
      data['invoices/in_final'] = result;
    } else if (path === 'invoiceitems') {
      data[`invoices/${params.invoice}`].total = Number(params.amount); data[`invoices/${params.invoice}`].subtotal = Number(params.amount);
      result = { id: 'ii_balance' };
    } else if (path.endsWith('/finalize')) {
      result = data[path.replace('/finalize', '')]; result.status = 'open'; result.amount_remaining = result.total;
    } else if (path.endsWith('/pay')) {
      if (declined) { const error = new Error('Declined'); error.status = 402; throw error; }
      result = data[path.replace('/pay', '')]; result.status = 'paid';
    } else if (path === 'subscriptions') {
      result = { id: 'sub_hosting', livemode: false, customer: params.customer, metadata: metadata(params), status: 'trialing',
        trial_end: Number(params.trial_end), latest_invoice: 'in_trial' };
      data['subscriptions/sub_hosting'] = result;
      data['invoices/in_trial'] = { id: 'in_trial', livemode: false, customer: params.customer, status: 'paid', amount_due: 0 };
    } else if (path.startsWith('invoices/')) {
      result = data[path]; assert.ok(result); Object.assign(result.metadata, metadata(params));
    } else if (path.startsWith('customers/')) {
      result = data[path]; result.invoice_settings.default_payment_method = params['invoice_settings[default_payment_method]'];
    } else assert.fail(`Unexpected Stripe write ${path}`);
    receipts.set(key, structuredClone(result));
    if (options.loseResponseFor === path) { options.loseResponseFor = null; throw new Error('Response lost after Stripe committed'); }
    return structuredClone(result);
  };
  const store = new BillingStore(database(), 'test', () => clock);
  const service = createBillingService(env, { stripe: api, close, store, now: () => clock });
  const payload = id => ({ subscription_id: config.subscriptionId, event: { id: `ev_${id}`, object_id: id,
    organization_id: config.organizationId, lead_id: activities[id].lead_id, object_type: 'activity.custom_activity', action: 'created' } });
  const deposit = async () => {
    const p = await store.get(proposalId), link = data[`payment_links/${p.linkId}`];
    const md = { close_project_id: p.id, close_lead_id: p.leadId, close_organization_id: config.organizationId };
    data['checkout/sessions/cs_test_paid'] = { id: 'cs_test_paid', livemode: false, metadata: structuredClone(link.metadata), status: 'complete', payment_status: 'paid',
      mode: 'payment', consent: { terms_of_service: 'accepted' }, payment_link: p.linkId, customer: 'cus_client', invoice: 'in_deposit',
      payment_intent: 'pi_deposit', currency: 'usd', amount_total: 175000, amount_subtotal: 175000 };
    data['invoices/in_deposit'] = { id: 'in_deposit', livemode: false, customer: 'cus_client', status: 'paid', currency: 'usd', amount_paid: 175000,
      subtotal_excluding_tax: 175000, metadata: { ...md, launch_status: 'awaiting_checkout' } };
    data['payment_intents/pi_deposit'] = { id: 'pi_deposit', status: 'succeeded', setup_future_usage: 'off_session', customer: 'cus_client', payment_method: 'pm_card', amount_received: 175000 };
    data['payment_intents/pi_deposit?expand[]=latest_charge'] = { ...data['payment_intents/pi_deposit'], latest_charge: { amount_refunded: 0, disputed: false, refunded: false } };
    data['payment_methods/pm_card'] = { id: 'pm_card', customer: 'cus_client', type: 'card' };
    data['customers/cus_client'] = { id: 'cus_client', livemode: false, balance: 0, invoice_settings: { default_payment_method: 'pm_card' } };
    await service.onStripe({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_paid' } } });
  };
  return { data, writes, closeWrites, activities, store, service, payload, deposit, decline() { declined = true; } };
}

test('dollar inputs convert exactly without floating-point rounding', () => {
  assert.equal(dollarsToCents(3500), 350000); assert.equal(dollarsToCents('149.99'), 14999);
  for (const value of ['', null, -5, '10.001', '1e4', '1,000', 'NaN', Infinity, '999999999999']) assert.throws(() => dollarsToCents(value));
  assert.throws(() => dollarsToCents('1000.50', { whole: true }));
});
test('Close signatures use hex key, timestamp concatenation, fresh original bytes', () => {
  const raw = Buffer.from('{"event":{"id":"ev_test"}}'), key = 'ab'.repeat(32), timestamp = String(clock / 1000);
  const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(timestamp).update(raw).digest('hex');
  const headers = new Headers({ 'close-sig-timestamp': timestamp, 'close-sig-hash': signature });
  assert.equal(verifyCloseEvent(raw, headers, key, clock).event.id, 'ev_test');
  assert.throws(() => verifyCloseEvent(Buffer.from('{}'), headers, key, clock));
  assert.throws(() => verifyCloseEvent(raw, headers, key, clock + 301000));
  assert.throws(() => verifyCloseEvent(raw, headers, 'bad', clock));
});
test('Close endpoint fails closed before credentials and rejects unsigned requests', async () => {
  assert.equal((await onRequest({ request: new Request('https://example.com'), env: {} })).status, 405);
  assert.equal((await onRequest({ request: new Request('https://example.com', { method: 'POST' }), env: {} })).status, 503);
  assert.equal((await onRequest({ request: new Request('https://example.com', { method: 'POST', body: '{}' }),
    env: { ...env, CLOSE_WEBHOOK_SECRET: 'ab'.repeat(32), CLOSE_API_KEY: 'fake', CLOSE_BILLING_DB: {} } })).status, 400);
  assert.throws(() => createBillingService({ ...env, STRIPE_SECRET_KEY: 'rk_live_fake' }));
});
test('proposal, saved deposit, launch and indefinite monthly hosting retain agreed amounts', async () => {
  const f = fixture(); await f.service.onClose(f.payload(proposalId));
  assert.match(f.activities[proposalId]['custom.cf_link'], /^https:\/\/stripe-sandbox.nolimitwebs.pages.dev\/proposal\/#plink_/);
  assert.equal(f.writes.find(w => w.path === 'payment_links').params['payment_intent_data[setup_future_usage]'], 'off_session');
  await f.deposit(); assert.equal(f.data['invoices/in_deposit'].metadata.launch_status, 'close_ready');
  await f.service.onClose(f.payload(launchId));
  const subscription = f.writes.find(w => w.path === 'subscriptions');
  assert.equal(Number(subscription.params.trial_end), clock / 1000 + 30 * 86400);
  assert.equal(subscription.params.cancel_at, undefined); assert.equal(subscription.params.cancel_at_period_end, undefined);
  assert.equal(f.writes.find(w => w.path === 'invoiceitems').params.amount, '175000');
  assert.equal(f.data['invoices/in_deposit'].metadata.launch_status, 'close_completed');
  assert.match(f.activities[proposalId]['custom.cf_status'], /Final balance paid.*Hosting starts 2026-10-11/);
  const counts = [f.writes.length, f.closeWrites.length];
  await f.service.onClose(f.payload(proposalId)); await f.service.onClose(f.payload(launchId));
  await f.service.onStripe({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_paid' } } });
  assert.deepEqual([f.writes.length, f.closeWrites.length], counts, 'duplicates must make no Stripe or Close writes');
});
test('different launch activity for same deposit does not duplicate collection', async () => {
  const f = fixture(); await f.service.onClose(f.payload(proposalId)); await f.deposit(); await f.service.onClose(f.payload(launchId));
  f.activities.acti_launch2 = { ...f.activities[launchId], id: 'acti_launch2', 'custom.cf_result': null };
  const count = f.writes.length; await f.service.onClose(f.payload('acti_launch2')); assert.equal(f.writes.length, count);
});
test('lost subscription response resumes after final payment without charging twice or moving hosting date', async () => {
  const f = fixture({ loseResponseFor: 'subscriptions' });
  await f.service.onClose(f.payload(proposalId)); await f.deposit();
  await assert.rejects(f.service.onClose(f.payload(launchId)), /Response lost/);
  assert.equal(f.data['invoices/in_final'].status, 'paid');
  await f.service.onClose(f.payload(launchId));
  assert.equal(f.writes.filter(w => w.path === 'subscriptions').length, 1);
  assert.equal(f.writes.filter(w => w.path.endsWith('/pay')).length, 1);
  assert.equal(f.data['subscriptions/sub_hosting'].trial_end, clock / 1000 + 30 * 86400);
  assert.equal((await f.store.get(proposalId)).stage, 'launched');
});
test('lost payment link response resumes the same proposal without making a replacement link', async () => {
  const f = fixture({ loseResponseFor: 'payment_links' });
  await assert.rejects(f.service.onClose(f.payload(proposalId)), /Response lost/);
  await f.service.onClose(f.payload(proposalId));
  assert.equal(f.writes.filter(w => w.path === 'payment_links').length, 1);
  assert.match(f.activities[proposalId]['custom.cf_link'], /plink_/);
});
test('drafts, old activities and other organizations never create bills', async () => {
  for (const change of [{ status: 'draft' }, { date_created: '2026-01-01' }, { date_created: 'invalid' }, { custom_activity_type_id: 'actitype_unrelated' }]) {
    const f = fixture(); Object.assign(f.activities[proposalId], change); await f.service.onClose(f.payload(proposalId)); assert.equal(f.writes.length, 0);
  }
  const f = fixture(), event = f.payload(proposalId); event.event.organization_id = 'orga_other';
  await assert.rejects(f.service.onClose(event)); assert.equal(f.writes.length, 0);
});
test('editing proposal pricing after creation cannot change what client agreed to', async () => {
  const f = fixture(); await f.service.onClose(f.payload(proposalId)); const count = f.writes.length;
  f.activities[proposalId]['custom.cf_build'] = 4500; await f.service.onClose(f.payload(proposalId));
  assert.equal(f.writes.length, count); assert.match(f.activities[proposalId]['custom.cf_status'], /already locked/);
});
for (const [name, change] of [
  ['another client', f => { f.activities[launchId].lead_id = 'lead_other'; }],
  ['missing launch authorization', f => { f.activities[launchId]['custom.cf_authorization'] = 'Yes'; }],
  ['refunded deposit', f => { f.data['payment_intents/pi_deposit?expand[]=latest_charge'].latest_charge.amount_refunded = 100; }],
  ['disputed deposit', f => { f.data['payment_intents/pi_deposit?expand[]=latest_charge'].latest_charge.disputed = true; }],
  ['different authorized hosting', f => { f.data['invoices/in_deposit'].metadata.authorized_hosting_monthly_cents = '29900'; }],
  ['unpaid deposit', f => { f.data['invoices/in_deposit'].status = 'open'; }],
  ['another customer card', f => { f.data['payment_methods/pm_card'].customer = 'cus_other'; }],
  ['customer credit balance', f => { f.data['customers/cus_client'].balance = -100; }],
  ['already used native workflow', f => { f.data['invoices/in_deposit'].metadata.launch_status = 'completed'; }],
]) test(`launch blocks ${name} before any charge`, async () => {
  const f = fixture(); await f.service.onClose(f.payload(proposalId)); await f.deposit(); change(f); const count = f.writes.length;
  await f.service.onClose(f.payload(launchId)); assert.equal(f.writes.length, count); assert.match(f.activities[launchId]['custom.cf_result'], /Review required/);
});
test('decline preserves one unpaid invoice and still schedules hosting from launch', async () => {
  const f = fixture(); await f.service.onClose(f.payload(proposalId)); await f.deposit(); f.decline(); await f.service.onClose(f.payload(launchId));
  assert.match(f.activities[proposalId]['custom.cf_status'], /Final balance open/);
  assert.equal(f.writes.filter(w => w.path.endsWith('/pay')).length, 1);
  await f.service.onClose(f.payload(launchId)); assert.equal(f.writes.filter(w => w.path.endsWith('/pay')).length, 1);
});
test('out-of-order hosting notifications read current state and show failures/cancellation', async () => {
  const f = fixture(); await f.service.onClose(f.payload(proposalId)); await f.deposit(); await f.service.onClose(f.payload(launchId));
  f.data['subscriptions/sub_hosting'].status = 'past_due';
  Object.assign(f.data['invoices/in_trial'], { status: 'open', amount_due: 14900 });
  await f.service.onStripe({ type: 'customer.subscription.updated', data: { object: { id: 'sub_hosting', status: 'active' } } });
  assert.match(f.activities[proposalId]['custom.cf_status'], /Hosting past_due.*payment needs attention/);
  f.data['subscriptions/sub_hosting'].status = 'canceled';
  await f.service.onStripe({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_hosting' } } });
  assert.match(f.activities[proposalId]['custom.cf_status'], /Hosting canceled/);
});
test('D1 lock excludes concurrent processing and durable receipts survive retries', async () => {
  const store = new BillingStore(database(), 'test', () => clock); await store.create({ id: proposalId, leadId });
  let count = 0;
  await store.withLock(proposalId, async (p, tx) => {
    await assert.rejects(store.withLock(proposalId, () => {}), /busy/);
    const api = async () => { count++; return { id: 'in_once', client_secret: 'must-not-store' }; };
    await tx.post('final-invoice', 'invoices', { customer: 'cus_a' }, api);
    await tx.post('final-invoice', 'invoices', { customer: 'cus_a' }, api);
    assert.equal(count, 1);
    await assert.rejects(tx.post('final-invoice', 'invoices', { customer: 'cus_b' }, api), ReviewRequired);
  });
});
test('an uncertain Stripe write older than 23 hours requires reconciliation, never another charge', async () => {
  let time = clock; const store = new BillingStore(database(), 'test', () => time); await store.create({ id: proposalId, leadId });
  let count = 0; const api = async () => { count++; throw new Error('Lost response after Stripe accepted request'); };
  await assert.rejects(store.withLock(proposalId, async (p, tx) => tx.post('final-invoice', 'invoices', {}, api)));
  time += 24 * 3600000;
  await assert.rejects(store.withLock(proposalId, async (p, tx) => tx.post('final-invoice', 'invoices', {}, api)), ReviewRequired);
  assert.equal(count, 1);
});
