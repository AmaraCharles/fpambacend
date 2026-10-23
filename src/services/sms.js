'use strict';
// ── Outgoing SMS ─────────────────────────────────────────────────────────────
// Configured with environment variables; without them nothing is sent (each
// message is logged instead), like the mailer. Sending never throws.
//
//   SMS_PROVIDER=termii      TERMII_API_KEY=...   TERMII_SENDER_ID=FPAM   (Nigerian provider)
//   SMS_PROVIDER=twilio      TWILIO_ACCOUNT_SID=...  TWILIO_AUTH_TOKEN=...  TWILIO_FROM=+1...
//   SMS_PROVIDER=africastalking  AT_USERNAME=...  AT_API_KEY=...  AT_SENDER_ID=FPAM (optional)

const provider = () => (process.env.SMS_PROVIDER || '').toLowerCase();
const isConfigured = () => ['termii', 'twilio', 'africastalking'].includes(provider());

/** Nigerian numbers to international format: 0803… → 234803… (no '+'). */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) p = p.slice(1);
  if (p.startsWith('0') && p.length === 11) p = '234' + p.slice(1);
  return /^\d{10,15}$/.test(p) ? p : null;
}

let fetchImpl = (...a) => fetch(...a);

async function sendSms(to, text) {
  const phone = normalizePhone(to);
  if (!phone) return { sent: false, reason: 'no valid phone number' };
  const body = String(text).slice(0, 459);   // 3 SMS segments max
  if (!isConfigured()) {
    console.log(`[sms] SMS not configured — skipped message to ${phone.slice(0, 6)}…`);
    return { sent: false, reason: 'not configured' };
  }
  try {
    let r;
    if (provider() === 'termii') {
      r = await fetchImpl('https://api.ng.termii.com/api/sms/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: phone, from: process.env.TERMII_SENDER_ID || 'FPAM', sms: body, type: 'plain', channel: 'generic', api_key: process.env.TERMII_API_KEY }),
      });
    } else if (provider() === 'twilio') {
      const sid = process.env.TWILIO_ACCOUNT_SID;
      r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: '+' + phone, From: process.env.TWILIO_FROM, Body: body }),
      });
    } else {
      r = await fetchImpl('https://api.africastalking.com/version1/messaging', {
        method: 'POST',
        headers: { apiKey: process.env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: process.env.AT_USERNAME, to: '+' + phone, message: body, ...(process.env.AT_SENDER_ID ? { from: process.env.AT_SENDER_ID } : {}) }),
      });
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return { sent: true };
  } catch (err) {
    console.error('[sms] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendSms, isConfigured, normalizePhone, _setFetchForTests: f => { fetchImpl = f; } };
