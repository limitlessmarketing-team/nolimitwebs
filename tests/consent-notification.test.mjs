import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
const source=readFileSync(new URL('../supabase/notify-lead.function.ts',import.meta.url),'utf8');
const code=source.slice(source.indexOf('const esc ='),source.indexOf('Deno.serve('));
const context={};vm.createContext(context);vm.runInContext(stripTypeScriptTypes(code),context);
test('notifications distinguish actual opt-in from missing/false consent',()=>{for(const consent of [undefined,{opted_in:false}]){const mail=context.buildEmail({name:'Test',sms_consent:consent});assert.match(mail.text,/No SMS opt-in recorded/);assert.match(mail.html,/No SMS opt-in recorded/);}const mail=context.buildEmail({name:'<Test>',sms_consent:{opted_in:true,recorded_at:'2026-09-15',source_url:'https://nolimitwebs.com/#contact',disclosure_version:'2026-09-15-v1',disclosure_text:'Example <disclosure>'}});assert.match(mail.text,/Opted in to inquiry\/project texts only/);assert.match(mail.html,/&lt;disclosure&gt;/);assert.match(mail.text,/Check current STOP\/opt-out status/);});
