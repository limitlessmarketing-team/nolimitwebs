import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { completeDeposit, readProposal, verifyEvent, FLOW, TERMS } from '../lib/stripe.mjs';

const linkId = 'plink_1234567890123456';
const sessionId = 'cs_test_1234567890123456';
const metadata = { flow: FLOW, hosting_price_id: 'price_hosting', authorization_version: TERMS,
  build_total_cents: '200000', hosting_monthly_cents: '9900' };
function fixtures() {
  return {
    [`payment_links/${linkId}`]: { id: linkId, metadata, livemode: false, active: true,
      url: 'https://buy.stripe.com/test_example', allow_promotion_codes: false, automatic_tax: { enabled: false },
      restrictions: { completed_sessions: { limit: 1 } }, customer_creation: 'always', invoice_creation: { enabled: true },
      consent_collection: { terms_of_service: 'required' }, payment_intent_data: { setup_future_usage: 'off_session' }, payment_method_types: ['card'] },
    [`payment_links/${linkId}/line_items?limit=2`]: { data: [{ price: { unit_amount: 100000 }, quantity: 1, currency: 'usd' }], has_more: false },
    'prices/price_hosting': { id: 'price_hosting', unit_amount: 9900, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, livemode: false },
    [`checkout/sessions/${sessionId}`]: { id: sessionId, metadata, livemode: false, status: 'complete', payment_status: 'paid',
      mode: 'payment', consent: { terms_of_service: 'accepted' }, payment_link: linkId, customer: 'cus_client', invoice: 'in_deposit',
      payment_intent: 'pi_deposit', currency: 'usd', amount_total: 100000, amount_subtotal: 100000 },
    'invoices/in_deposit': { id: 'in_deposit', status: 'paid', customer: 'cus_client', subtotal_excluding_tax: 100000,
      amount_paid: 100000, metadata: { launch_status: 'awaiting_checkout' } },
    'payment_intents/pi_deposit': { id: 'pi_deposit', status: 'succeeded', setup_future_usage: 'off_session', customer: 'cus_client', payment_method: 'pm_saved' },
    'payment_methods/pm_saved': { id: 'pm_saved', customer: 'cus_client', type: 'card' },
  };
}
function mock(data) {
  const writes = [];
  return { writes, api: async (path, params, key) => {
    if (params) { writes.push({ path, params, key }); return {}; }
    assert.ok(data[path], `Unexpected read ${path}`); return structuredClone(data[path]);
  } };
}
test('the displayed prices come from Stripe; one deposit is exactly half the build', async () => {
  const { api } = mock(fixtures()); const { public: p } = await readProposal(linkId, api);
  assert.equal(p.buildTotal, 200000); assert.equal(p.deposit, 100000); assert.equal(p.balance, 100000); assert.equal(p.monthlyHosting, 9900);
  assert.equal(p.title, 'Your custom website'); assert.equal(p.testMode, true);
});
test('a closed link never returns a usable checkout URL', async () => {
  const data = fixtures(); data[`payment_links/${linkId}`].active = false;
  const { public: p } = await readProposal(linkId, mock(data).api);
  assert.equal(p.checkoutUrl, null); assert.equal(p.active, false);
});
for (const [name, mutate] of [
  ['unmarked link', d => { d[`payment_links/${linkId}`].metadata = {}; }],
  ['a rounded fractional-dollar build', d => { d[`payment_links/${linkId}`].metadata = { ...metadata, build_total_cents: '200000.1' }; }],
  ['a hosting price that differs from the agreement', d => { d[`payment_links/${linkId}`].metadata = { ...metadata, hosting_monthly_cents: '10000' }; }],
  ['unlimited link', d => { d[`payment_links/${linkId}`].restrictions.completed_sessions.limit = 2; }],
  ['recurring deposit', d => { d[`payment_links/${linkId}/line_items?limit=2`].data[0].price.recurring = { interval: 'month' }; }],
  ['quantity changes', d => { d[`payment_links/${linkId}/line_items?limit=2`].data[0].quantity = 2; }],
  ['another currency', d => { d['prices/price_hosting'].currency = 'eur'; }],
  ['annual hosting', d => { d['prices/price_hosting'].recurring.interval = 'year'; }],
  ['a live price in sandbox', d => { d['prices/price_hosting'].livemode = true; }],
  ['promotional discounts', d => { d[`payment_links/${linkId}`].allow_promotion_codes = true; }],
  ['an untrusted checkout host', d => { d[`payment_links/${linkId}`].url = 'https://example.com'; }],
]) test(`proposal rejects ${name}`, async () => { const data = fixtures(); mutate(data); await assert.rejects(readProposal(linkId, mock(data).api)); });

test('verified paid checkout prepares the saved card before allowing launch', async () => {
  const m = mock(fixtures()); const result = await completeDeposit(sessionId, m.api);
  assert.equal(result.ready, true); assert.equal(m.writes.length, 2);
  assert.equal(m.writes[0].path, 'customers/cus_client');
  assert.equal(m.writes[0].params['invoice_settings[default_payment_method]'], 'pm_saved');
  assert.equal(m.writes[1].params['metadata[launch_status]'], 'ready');
  assert.equal(m.writes[1].params['metadata[hosting_price_id]'], 'price_hosting');
  assert.ok(m.writes.every(w => w.key));
});
for (const state of ['ready', 'processing', 'completed']) test(`a duplicate event does not reset ${state} or replace a card`, async () => {
  const d = fixtures(); d['invoices/in_deposit'].metadata = { launch_status: state, checkout_session_id: sessionId };
  const m = mock(d); await completeDeposit(sessionId, m.api); assert.equal(m.writes.length, 0);
});
test('unpaid sessions make no changes', async () => {
  const d = fixtures(); d[`checkout/sessions/${sessionId}`].payment_status = 'unpaid';
  const m = mock(d); assert.equal((await completeDeposit(sessionId, m.api)).pending, true); assert.equal(m.writes.length, 0);
});
for (const [name, mutate] of [
  ['missing consent', d => { d[`checkout/sessions/${sessionId}`].consent = null; }],
  ['changed agreed pricing', d => { d[`checkout/sessions/${sessionId}`].metadata = { ...metadata, build_total_cents: '300000' }; }],
  ['wrong amount', d => { d[`checkout/sessions/${sessionId}`].amount_total = 1; }],
  ['discounted invoice', d => { d['invoices/in_deposit'].subtotal_excluding_tax = 99999; }],
  ['another customer’s card', d => { d['payment_methods/pm_saved'].customer = 'cus_other'; }],
  ['unsaved payment method', d => { d['payment_intents/pi_deposit'].setup_future_usage = null; }],
]) test(`deposit rejects ${name} without preparing launch`, async () => {
  const d = fixtures(); mutate(d); const m = mock(d);
  await assert.rejects(completeDeposit(sessionId, m.api)); assert.equal(m.writes.length, 0);
});
test('webhook signature requires original bytes, valid secret and recent timestamp', () => {
  const raw = Buffer.from('{"id":"evt_test"}'); const now = 1788979000000; const time = now / 1000;
  const digest = createHmac('sha256', 'secret').update(`${time}.`).update(raw).digest('hex');
  const header = `t=${time},v1=${digest}`;
  assert.equal(verifyEvent(raw, header, 'secret', now).id, 'evt_test');
  assert.throws(() => verifyEvent(Buffer.from('{}'), header, 'secret', now));
  assert.throws(() => verifyEvent(raw, header, 'wrong', now));
  assert.throws(() => verifyEvent(raw, header, 'secret', now + 301000));
  assert.throws(() => verifyEvent(raw, 'v1=x', 'secret', now));
});
