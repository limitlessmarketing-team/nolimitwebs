import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadHandler } from '../supabase/functions/submit-lead/handler.mjs';
const env = { TURNSTILE_SECRET_KEY: 'test-only', SUPABASE_SERVICE_ROLE_KEY: 'server-only', SUPABASE_URL: 'https://example.supabase.co' };
const data = { name: 'Test', email: 'test@example.com', token: 'token' };
function request(body=data, origin='https://nolimitwebs.com') { return new Request('https://example/submit', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
function fixture(verification={success:true,hostname:'nolimitwebs.com',action:'quote_request'}, saved=true) {
 const calls=[];
 const handler=createLeadHandler(env,async (url, options)=>{ calls.push({url,options}); return Response.json(url.includes('siteverify')? verification : saved); });
 return {handler,calls};
}
test('rejects unapproved origins without contacting providers',async()=>{const f=fixture();assert.equal((await f.handler(request(data,'https://attacker.example'))).status,403);assert.equal(f.calls.length,0);});
test('rejects missing token, oversized and malformed fields before verification',async()=>{for(const body of [{...data,token:''},{...data,name:'x'.repeat(201)},{...data,email:'invalid'},{...data,message:'x'.repeat(18000)}]) { const f=fixture(); assert.ok((await f.handler(request(body))).status>=400);assert.equal(f.calls.length,0); }});
test('failed, reused, wrong-host and wrong-action tokens cannot write leads',async()=>{for(const v of [{success:false},{success:true,hostname:'attacker.example',action:'quote_request'},{success:true,hostname:'nolimitwebs.com',action:'other'}]){const f=fixture(v);assert.equal((await f.handler(request())).status,403);assert.equal(f.calls.length,1);}});
test('valid request passes only whitelisted fields and hashed contact to server RPC',async()=>{const f=fixture();const r=await f.handler(request({...data,id:'override',source:'override',role:'admin'}));assert.equal(r.status,200);const sent=JSON.parse(f.calls[1].options.body);assert.equal(sent.lead_data.id,undefined);assert.equal(sent.lead_data.role,undefined);assert.match(sent.contact_hash,/^[a-f0-9]{64}$/);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{ok:true});});
test('database rate-limit rejection propagates without exposing data',async()=>{const f=fixture(undefined,false);assert.equal((await f.handler(request())).status,429);});
test('sandbox verification never writes production leads',async()=>{const f=fixture({success:true,hostname:'stripe-sandbox.nolimitwebs.pages.dev',action:'quote_request'});assert.equal((await f.handler(request(data,'https://stripe-sandbox.nolimitwebs.pages.dev'))).status,200);assert.equal(f.calls.length,1);});
test('provider failure fails closed without leaking secrets',async()=>{const handler=createLeadHandler(env,async()=>{throw Error('server-only');});const r=await handler(request());assert.equal(r.status,503);assert.ok(!(await r.text()).includes('server-only'));});

test("www website validates and saves normally",async()=>{const f=fixture({success:true,hostname:"www.nolimitwebs.com",action:"quote_request"});assert.equal((await f.handler(request(data,"https://www.nolimitwebs.com"))).status,200);assert.equal(f.calls.length,2);});
