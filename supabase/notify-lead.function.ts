import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/**
 * Emails a notification whenever a new row lands in public.portfolio_leads.
 *
 * Invoked by a database trigger (see the notify_new_lead migration), not by the
 * browser — the site itself never calls this and never sees any of these keys.
 *
 * Auth: the trigger sends a shared secret in `x-hook-secret`. The expected value
 * lives in public.app_settings, which is readable only by the service role, so
 * the secret never has to be configured by hand in two places.
 *
 * Required secret you must set yourself: RESEND_API_KEY.
 * Optional overrides: LEAD_NOTIFY_TO, LEAD_NOTIFY_FROM.
 */

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const NOTIFY_TO = Deno.env.get("LEAD_NOTIFY_TO") ?? "contact@nolimitwebs.com";
const NOTIFY_FROM = Deno.env.get("LEAD_NOTIFY_FROM") ??
  "Limitless Leads <onboarding@resend.dev>";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

/** Constant-time-ish compare so the secret can't be guessed byte by byte. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const esc = (value: unknown): string =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );

type Lead = {
  id?: string;
  name?: string;
  business?: string;
  phone?: string;
  email?: string;
  message?: string;
  created_at?: string;
};

function row(label: string, value: string | undefined): string {
  if (!value || !value.trim()) return "";
  return `<tr>
      <td style="padding:6px 16px 6px 0;color:#6b7280;font:13px -apple-system,Segoe UI,sans-serif;white-space:nowrap;vertical-align:top">${esc(label)}</td>
      <td style="padding:6px 0;color:#111827;font:15px -apple-system,Segoe UI,sans-serif">${esc(value)}</td>
    </tr>`;
}

function buildEmail(lead: Lead): { subject: string; html: string; text: string } {
  const who = (lead.name || "Someone").trim();
  const where = (lead.business || "").trim();
  const subject = where ? `New mockup request — ${who} (${where})` : `New mockup request — ${who}`;

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7f9">
  <div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:28px">
    <p style="margin:0 0 4px;font:600 12px/1 -apple-system,Segoe UI,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#4d7cfe">New lead · nolimitwebs.com</p>
    <h1 style="margin:0 0 20px;font:700 22px/1.3 -apple-system,Segoe UI,sans-serif;color:#111827">${esc(who)} wants a free mockup</h1>
    <table style="border-collapse:collapse;width:100%">
      ${row("Name", lead.name)}
      ${row("Business", lead.business)}
      ${row("Phone", lead.phone)}
      ${row("Email", lead.email)}
      ${row("Message", lead.message)}
      ${row("Received", lead.created_at)}
    </table>
    ${
    lead.phone
      ? `<p style="margin:24px 0 0"><a href="tel:${esc(lead.phone)}" style="display:inline-block;background:#111827;color:#fff;text-decoration:none;padding:11px 20px;border-radius:999px;font:600 14px -apple-system,Segoe UI,sans-serif">Call ${esc(lead.phone)}</a></p>`
      : ""
  }
  </div>
</body></html>`;

  const text = [
    `New lead from nolimitwebs.com`,
    ``,
    `Name:     ${lead.name ?? ""}`,
    `Business: ${lead.business ?? ""}`,
    `Phone:    ${lead.phone ?? ""}`,
    `Email:    ${lead.email ?? ""}`,
    `Message:  ${lead.message ?? ""}`,
    `Received: ${lead.created_at ?? ""}`,
  ].join("\n");

  return { subject, html, text };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { data: setting, error: settingError } = await admin
    .from("app_settings")
    .select("value")
    .eq("key", "lead_hook_secret")
    .maybeSingle();

  if (settingError || !setting?.value) {
    console.error("could not read lead_hook_secret", settingError);
    return new Response("Server not configured", { status: 500 });
  }

  if (!secretsMatch(req.headers.get("x-hook-secret") ?? "", setting.value)) {
    return new Response("Unauthorized", { status: 401 });
  }

  if (!RESEND_API_KEY) {
    console.error("RESEND_API_KEY is not set");
    return new Response("Email provider not configured", { status: 500 });
  }

  let lead: Lead;
  try {
    const body = await req.json();
    lead = (body?.record ?? body) as Lead;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const { subject, html, text } = buildEmail(lead);

  const payload: Record<string, unknown> = {
    from: NOTIFY_FROM,
    to: [NOTIFY_TO],
    subject,
    html,
    text,
  };
  // Replying to the notification should reach the prospect directly.
  if (lead.email && lead.email.includes("@")) payload.reply_to = lead.email;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const detail = await res.text();
  if (!res.ok) {
    console.error("resend rejected the send", res.status, detail);
    return new Response(JSON.stringify({ ok: false, status: res.status, detail }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true, detail }), {
    headers: { "content-type": "application/json" },
  });
});
