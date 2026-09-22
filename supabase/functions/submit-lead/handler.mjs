// Public intake only. Never returns stored leads or accepts caller-supplied database queries.
const ORIGINS = new Set(['https://nolimitwebs.com', 'https://www.nolimitwebs.com', 'https://stripe-sandbox.nolimitwebs.pages.dev']);
const LIMIT = 16384;
const CONSENT_VERSION = "2026-09-15-v1";
const CONSENT_TEXT = 'I agree to receive text messages from Limitless Marketing Group LLC about my website inquiry, requested mockup, appointments, and project updates, including automated messages. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help. Consent is not a condition of purchase.';
export function createLeadHandler(env, fetcher = fetch) {
  return async function handle(req) {
    const origin = req.headers.get('origin') || '';
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
    if (ORIGINS.has(origin)) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'content-type, apikey', 'Access-Control-Allow-Methods': 'POST, OPTIONS' });
    const reply = (status, error) => new Response(JSON.stringify(error ? { error } : { ok: true }), { status, headers });
    if (!ORIGINS.has(origin)) return reply(403, 'Origin not allowed');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return reply(405, 'Method not allowed');
    if (!env.TURNSTILE_SECRET_KEY || !env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_URL) return reply(503, 'Service unavailable');
    if (!/^application\/json(?:;|$)/i.test(req.headers.get('content-type') || '')) return reply(415, 'JSON required');
    let body;
    try {
      if (Number(req.headers.get('content-length')) > LIMIT) return reply(413, 'Request too large');
      const reader = req.body?.getReader();
      if (!reader) return reply(400, 'Invalid request');
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > LIMIT) { await reader.cancel(); return reply(413, 'Request too large'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch { return reply(400, 'Invalid request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, 'Invalid request');
    if (body.company_website) return reply(200);
    const lead = {};
    for (const [field, max] of Object.entries({ name: 200, business: 200, phone: 50, email: 200, message: 4000 })) {
      const value = body[field] ?? '';
      if (typeof value !== 'string' || value.length > max || value.includes('\0')) return reply(400, 'Invalid field');
      lead[field] = value.trim();
    }
    if (!lead.name || (!lead.phone && !lead.email)) return reply(400, 'Name and contact details required');
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return reply(400, 'Invalid email');
    if (lead.phone && !/^[+()\d\s.\-]{5,50}$/.test(lead.phone)) return reply(400, 'Invalid phone');
    if (body.sms_consent !== undefined && typeof body.sms_consent !== 'boolean') return reply(400, 'Invalid SMS consent');
    const optedIn = body.sms_consent === true;
    if (optedIn && (!lead.phone || body.sms_consent_version !== CONSENT_VERSION)) return reply(400, 'Phone and current SMS consent required');
    // Values below come from the server, never from caller-supplied proof fields.
    lead.sms_consent = {
      opted_in: optedIn,
      recorded_at: new Date().toISOString(),
      phone: lead.phone,
      source_url: origin + '/#contact',
      method: 'website_checkbox',
      disclosure_version: body.sms_consent_version === CONSENT_VERSION ? CONSENT_VERSION : null,
      disclosure_text: body.sms_consent_version === CONSENT_VERSION ? CONSENT_TEXT : null,
      terms_url: 'https://nolimitwebs.com/terms/',
      privacy_url: 'https://nolimitwebs.com/privacy/',
      scope: 'inquiry_mockup_appointments_project_updates',
      promotional_consent: false
    };
    if (typeof body.token !== 'string' || !body.token || body.token.length > 2048) return reply(400, 'Verification required');
    try {
      const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: body.token }), signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) return reply(503, 'Verification unavailable');
      const verified = await response.json();
      if (verified.success !== true || verified.hostname !== new URL(origin).hostname || verified.action !== 'quote_request') return reply(403, 'Verification failed');
      // Preview exercises verification only; it cannot insert real leads or send notifications.
      if (origin === 'https://stripe-sandbox.nolimitwebs.pages.dev') return reply(200);
      const contact = lead.email ? lead.email.toLowerCase() : lead.phone.replace(/\D/g, '');
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.TURNSTILE_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const hash = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(contact))), b => b.toString(16).padStart(2, '0')).join('');
      const saved = await fetcher(env.SUPABASE_URL + '/rest/v1/rpc/submit_verified_lead', {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY },
        body: JSON.stringify({ lead_data: lead, contact_hash: hash }), signal: AbortSignal.timeout(8000)
      });
      if (!saved.ok) return reply(503, 'Submission unavailable');
      if (await saved.json() !== true) return reply(429, 'Too many requests. Please call or email us.');
      return reply(200);
    } catch { return reply(503, 'Submission unavailable'); }
  };
}
