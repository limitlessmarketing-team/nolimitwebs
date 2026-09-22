import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('database setup does not grant ordinary users access to all leads', () => {
 const sql = readFileSync(new URL('../supabase/migrations.sql', import.meta.url), 'utf8');
 assert.doesNotMatch(sql, /create policy "authenticated can read leads"/i);
 assert.doesNotMatch(sql, /grant\s+select\s+on\s+table\s+public\.portfolio_leads\s+to\s+authenticated/i);
 assert.match(sql, /revoke select on table public\.portfolio_leads from anon, authenticated/i);
});
test('all static pages have framing and script restrictions', () => {
 const headers = readFileSync(new URL('../site/_headers', import.meta.url), 'utf8');
 assert.match(headers, /^\/\*\n/);
 assert.match(headers, /frame-ancestors 'none'/);
 assert.match(headers, /object-src 'none'/);
 assert.match(headers, /X-Frame-Options: DENY/);
});
