import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalCancellation, CANCEL_AUTHORIZATION } from '../lib/cancel-proposal.mjs';

const config={ mode:'test',organizationId:'orga_one',subscriptionId:'whsub_one',origin:'https://stripe-sandbox.nolimitwebs.pages.dev',enabledAfter:'2026-09-01',cancelType:'actitype_cancel',cancelFields:{proposal:'cf_link',authorization:'cf_auth',result:'cf_result'} };
function fixture({hosting=false,accepted=false,race=false,fail=false,pages=false}={}) {
  const p={id:'acti_proposal',leadId:'lead_one',linkId:hosting?'host_'+'a'.repeat(64):'plink_1234567890123456',...(hosting?{setupSessionId:'cs_test_one'}:{}),...(accepted?{depositId:'in_paid'}:{})};
  const md={close_project_id:p.id,close_lead_id:p.leadId,close_organization_id:config.organizationId};
  const activity={id:'acti_cancel',organization_id:config.organizationId,lead_id:p.leadId,custom_activity_type_id:config.cancelType,status:'published',date_created:'2026-09-23', 'custom.cf_link':config.origin+'/proposal/#'+p.linkId,'custom.cf_auth':CANCEL_AUTHORIZATION};
  const link={id:p.linkId,active:true,metadata:md,livemode:false};
  const sessions=[{id:'cs_test_one',status:'open',payment_status:'unpaid',metadata:md,livemode:false,payment_link:p.linkId}];
  if(pages) sessions.push({...sessions[0],id:'cs_test_two'});
  const writes=[], messages=[];
  const api=async(path,params)=>{
    if(params){
      writes.push(path);
      if(path.startsWith('payment_links/')) {link.active=false;return link;}
      const s=sessions.find(x=>path===`checkout/sessions/${x.id}/expire`);
      assert.ok(s,'Cancellation must only disable links or expire sessions');
      if(fail) {fail=false;throw new Error('network timeout');}
      if(race) {s.status='complete';s.payment_status='paid';throw new Error('already completed');}
      s.status='expired';return s;
    }
    if(path.startsWith('payment_links/')) return structuredClone(link);
    if(path.startsWith('checkout/sessions?')) return {data:structuredClone(pages ? [sessions[path.includes('starting_after')?1:0]] : sessions),has_more:pages&&!path.includes('starting_after')};
    const s=sessions.find(x=>path===`checkout/sessions/${x.id}`);assert.ok(s,path);return structuredClone(s);
  };
  const store={findHostingToken:async token=>token===p.linkId?p:null,withLock:async(id,fn)=>{assert.equal(id,p.id);return fn(p,{save:async()=>{},post:async(step,path,params)=>api(path,params)});}};
  const close=async(path,params)=>{assert.equal(path,'activity/custom/acti_cancel/');if(params)Object.assign(activity,params);return structuredClone(activity);};
  const run=proposalCancellation({config,api,close,store,now:()=>Date.parse('2026-09-23'),publish:async(p,msg)=>messages.push(msg)});
  const payload={subscription_id:config.subscriptionId,event:{organization_id:config.organizationId,object_id:activity.id,lead_id:p.leadId,object_type:'activity.custom_activity',action:'created'}};
  return {p,link,sessions,writes,activity,messages,run:()=>run(payload),payload};
}
for(const hosting of [true,false]) test(`cancels ${hosting?'card setup':'payment link'} once and handles repeated delivery`,async()=>{
  const f=fixture({hosting});await f.run();assert.equal(f.p.cancellation.status,'canceled');assert.equal(f.sessions[0].status,'expired');if(!hosting)assert.equal(f.link.active,false);
  const n=f.writes.length;await f.run();assert.equal(f.writes.length,n);assert.match(f.activity['custom.cf_result'],/Proposal canceled/);
});
test('checks every page of sessions',async()=>{const f=fixture({pages:true});await f.run();assert.ok(f.sessions.every(s=>s.status==='expired'));});
test('refuses an accepted project without mutating Stripe',async()=>{const f=fixture({accepted:true});await f.run();assert.equal(f.writes.length,0);assert.match(f.activity['custom.cf_result'],/already accepted/);});
test('detects completed checkout even before its webhook arrives',async()=>{const f=fixture();f.sessions[0].status='complete';await f.run();assert.equal(f.writes.length,0);assert.match(f.activity['custom.cf_result'],/already completed/);});
test('completion race reports review, preserves paid session and never cancels billing',async()=>{const f=fixture({race:true});await f.run();assert.equal(f.p.cancellation.status,'review');assert.equal(f.sessions[0].status,'complete');assert.match(f.activity['custom.cf_result'],/needs review/);});
test('interrupted cancellation remains blocked and completes on retry',async()=>{const f=fixture({fail:true});await assert.rejects(f.run(),/network timeout/);assert.equal(f.p.cancellation.status,'canceling');assert.equal(f.link.active,false);await f.run();assert.equal(f.p.cancellation.status,'canceled');});
for(const [label,change] of [
  ['wrong lead',f=>{f.activity.lead_id='lead_other';f.payload.event.lead_id='lead_other';}],
  ['wrong mode link',f=>f.activity['custom.cf_link']=f.activity['custom.cf_link'].replace(config.origin,'https://nolimitwebs.com')],
  ['missing confirmation',f=>f.activity['custom.cf_auth']=''],
  ['draft',f=>f.activity.status='draft'],
  ['foreign Stripe object',f=>f.sessions[0].metadata.close_project_id='acti_other']
]) test('rejects '+label,async()=>{const f=fixture();change(f);await f.run();assert.equal(f.writes.length,0);assert.equal(f.p.cancellation,undefined);});
