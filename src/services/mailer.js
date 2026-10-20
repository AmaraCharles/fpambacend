'use strict';
// ── Outgoing email ────────────────────────────────────────────────────────────
// SMTP is configured through environment variables (works with Gmail/Google
// Workspace, Microsoft 365, Zoho, Brevo, SendGrid SMTP, Mailgun SMTP, …):
//
//   SMTP_HOST=smtp.example.com     SMTP_PORT=587    SMTP_SECURE=false
//   SMTP_USER=notifications@...    SMTP_PASS=...
//   MAIL_FROM="FPAM Asset Platform <notifications@...>"
//   APP_URL=https://fpam.vercel.app/app     (base used for links in emails)
//
// Without SMTP_HOST nothing is sent — each message is logged instead — so the
// app keeps working before email is set up. Sending never throws: a mail
// failure must not fail the request that triggered it.

const nodemailer = require('nodemailer');

let transport = null;

const isConfigured = () => !!process.env.SMTP_HOST;

function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  return transport;
}

/** Base URL of the dashboard for links in emails (no trailing slash). */
const appUrl = () => String(process.env.APP_URL || process.env.CLIENT_URL || '').replace(/\/$/, '');

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Branded HTML email. `lines` are paragraphs (already-escaped HTML allowed via
 * { html }); plain strings are escaped. `cta` adds a button.
 */
function render({ heading, lines = [], cta, footnote }) {
  const body = lines.map(l => `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:#2C3E50">${typeof l === 'string' ? esc(l) : l.html}</p>`).join('');
  const button = cta ? `<p style="margin:22px 0"><a href="${esc(cta.url)}" style="background:#4A90D9;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:600;font-size:14px;display:inline-block">${esc(cta.label)}</a></p>` : '';
  const html = `<!doctype html><html><body style="margin:0;background:#F4F6F9;font-family:Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F9;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#0B2545;padding:18px 24px;color:#ffffff;font-weight:700;font-size:15px">FPAM Asset Platform</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 16px;font-size:19px;color:#0B2545">${esc(heading)}</h1>${body}${button}
${footnote ? `<p style="margin:18px 0 0;font-size:12px;color:#5A6A7A">${esc(footnote)}</p>` : ''}
</td></tr>
<tr><td style="padding:14px 24px;background:#F4F6F9;font-size:11px;color:#5A6A7A">Federal Public Assets Maintenance Department · Federal Ministry of Housing and Urban Development. This is an automated message.</td></tr>
</table></td></tr></table></body></html>`;
  const text = [heading, '', ...lines.map(l => (typeof l === 'string' ? l : l.text || '')), cta ? `\n${cta.label}: ${cta.url}` : '', footnote ? `\n${footnote}` : ''].join('\n');
  return { html, text };
}

/**
 * Send one message. `to` may be a string or array; blanks are dropped.
 * Resolves to { sent: boolean, reason? } — never rejects.
 */
async function sendMail({ to, subject, heading, lines, cta, footnote }) {
  const recipients = [...new Set([].concat(to || []).filter(Boolean))];
  if (!recipients.length) return { sent: false, reason: 'no recipients' };
  if (!isConfigured()) {
    console.log(`[mail] SMTP not configured — skipped "${subject}" to ${recipients.join(', ')}`);
    return { sent: false, reason: 'not configured' };
  }
  try {
    const { html, text } = render({ heading: heading || subject, lines, cta, footnote });
    await getTransport().sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      // Several recipients go in BCC so people don't see each other's addresses.
      ...(recipients.length === 1 ? { to: recipients[0] } : { to: process.env.MAIL_FROM || process.env.SMTP_USER, bcc: recipients }),
      subject, html, text,
    });
    return { sent: true };
  } catch (err) {
    console.error('[mail] send failed:', subject, err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendMail, isConfigured, appUrl, render, _setTransportForTests: t => { transport = t; } };
