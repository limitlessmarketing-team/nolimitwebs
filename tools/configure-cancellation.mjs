// Operator-only setup; `api` is supplied by a local, temporary-key session.
// Prepare hidden forms first. Activate only after deploying this mode's config.
import { readFile, writeFile } from 'node:fs/promises';
import { CANCEL_AUTHORIZATION } from '../lib/cancel-proposal.mjs';
export async function configureCancellation(api, root, mode, activate=false) {
 const text=await readFile(root+'/wrangler.toml','utf8');
 const config=[...text.matchAll(/CLOSE_BILLING_CONFIG = '(.*?)'/g)].map(m=>JSON.parse(m[1])).find(c=>c.mode===mode);
 if(!config)throw new Error('Missing mode');
 const name=(mode==='test'?'(sandbox) ':'')+'3. Cancel proposal — unpaid only';
 const all=await api('custom_activity/');if(all.has_more)throw new Error('Review pagination');
 const matches=all.data.filter(t=>t.name===name);if(matches.length>1)throw new Error('Duplicate action');
 const template=await api(`custom_activity/${config.paths[0].launchType}/`);
 if(template.organization_id!==config.organizationId)throw new Error('Wrong organization');
 const type=matches[0]||await api('custom_activity/',{name,description:'Withdraw an unpaid proposal on this lead. Wait for a successful cancellation result before sending a replacement. Does not refund payments or cancel subscriptions.',api_create_only:true,editable_with_roles:template.editable_with_roles});
 const current=await api(`custom_activity/${type.id}/`);config.cancelType=type.id;config.cancelFields={};
 for(const [key,label,description] of [
  ['proposal','Proposal link to cancel','Paste the exact old nolimitwebs proposal URL from this lead. Sandbox actions require a sandbox proposal link.'],
  ['authorization','Confirm cancellation',`Type exactly: ${CANCEL_AUTHORIZATION}`],
  ['result','Cancellation result','Filled automatically. Leave blank. Wait for Proposal canceled before creating a replacement. If review is required, inspect Stripe first.']]){
  const found=current.fields.filter(f=>f.name===label);if(found.length>1)throw new Error('Duplicate field');
  const f=found[0]||await api('custom_field/activity/',{custom_activity_type_id:type.id,name:label,type:'text',required:key!=='result',accepts_multiple_values:false,description,editable_with_roles:template.fields[0].editable_with_roles});
  config.cancelFields[key]=f.id;
 }
 if(activate){
  const hook=await api(`webhook/${config.subscriptionId}/`);
  const origin=mode==='test'?'https://stripe-sandbox.nolimitwebs.pages.dev':'https://nolimitwebs.com';
  if(hook.url!==origin+'/api/close-webhook'||hook.verify_ssl!==true)throw new Error('Unexpected webhook');
  const ids=[config.proposalType,config.launchType,...config.paths.flatMap(p=>[p.proposalType,p.launchType]),config.cancelType];
  const events=structuredClone(hook.events);
  if(events.length!==2||events.some(e=>!['created','updated'].includes(e.action)||e.object_type!=='activity.custom_activity'))throw new Error('Unexpected events');
  for(const e of events)e.extra_filter={type:'field_accessor',field:'data',filter:{type:'field_accessor',field:'custom_activity_type_id',filter:{type:'or',filters:ids.map(value=>({type:'equals',value}))}}};
  await api(`webhook/${config.subscriptionId}/`,{events},'PUT');
  await api(`custom_activity/${type.id}/`,{api_create_only:false},'PUT');
 }
 await writeFile(root+'/../cancel-config-'+mode+'.json',JSON.stringify(config,null,2)+'\n');
 return {mode,cancelType:config.cancelType,cancelFields:config.cancelFields,active:activate};
}
