import test from 'node:test';
import assert from 'node:assert/strict';
import { retryBilling } from '../lib/billing-retry.mjs';
test('transient checkout overlap retries with bounded backoff', async () => {
 const delays=[];let calls=0;
 assert.equal(await retryBilling(async()=>{if(++calls<4)throw new Error('Billing project busy; retry');return 'paid';},async ms=>delays.push(ms)), 'paid');
 assert.deepEqual(delays,[1000,2000,3000]);
});
test('permanent mismatches never retry and persistent overlap fails for Stripe redelivery',async()=>{
 let calls=0; await assert.rejects(retryBilling(async()=>{calls++;throw new Error('Invoice mismatch');},async()=>{}),/Invoice mismatch/);assert.equal(calls,1);
 calls=0;await assert.rejects(retryBilling(async()=>{calls++;throw Object.assign(new Error('Stripe request failed'),{code:'idempotency_key_in_use'});},async()=>{}),/Stripe request failed/);assert.equal(calls,4);
});
