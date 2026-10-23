'use strict';
// ── Notifications ─────────────────────────────────────────────────────────────
// Who gets told what, on which channels. Event functions are fire-and-forget:
// call them without awaiting; failures are logged and never affect the request.
//
//   Event                                   Recipients                      In-app  Email  SMS
//   ─────────────────────────────────────── ─────────────────────────────── ─────── ────── ───
//   Capture submitted for approval          Approvers                         ✓       ✓
//   Capture approved / rejected             The person who submitted it       ✓       ✓     ✓
//   Inspection report submitted             Approvers                         ✓       ✓
//   Inspection report approved / rejected   The inspector                     ✓       ✓     ✓
//   Form request submitted by an MDA        Form reviewers                    ✓       ✓
//   Form request reviewed (status change)   The MDA agent                     ✓       ✓     ✓
//   Certificate issued                      The MDA agent                     ✓       ✓     ✓
//   Data-quality fix assigned               The assignee                      ✓       ✓
//   Account created / password reset        The user                                  ✓ (on request)
//   Forgot-password link                    The user                                  ✓
//
// In-app notifications are stored (models/Notification) and pushed to the
// user's open dashboards over socket.io. SMS only goes to users with a phone
// number, and only when an SMS provider is configured (services/sms.js).

const User = require('../models/User');
const Notification = require('../models/Notification');
const { sendMail, appUrl } = require('./mailer');
const { sendSms } = require('./sms');

const APPROVER_ROLES = ['Sub-Head', 'Supervisor', 'System Admin'];
const PROJ = { email: 1, phone: 1, name: 1, isActive: 1 };

async function usersForRoles(roles, excludeId) {
  const users = await User.find({ role: { $in: roles }, isActive: true }, PROJ).lean();
  return users.filter(u => String(u._id) !== String(excludeId || ''));
}
async function userOf(userOrId) {
  if (!userOrId) return null;
  const id = userOrId._id || userOrId;
  const u = await User.findById(id, PROJ).lean().catch(() => null);
  return u && u.isActive !== false ? u : null;
}
const run = fn => { Promise.resolve().then(fn).catch(err => console.error('[notify]', err.message)); };

/** Store + push in-app notifications, send one email (BCC for several), optional SMS. */
async function deliver(users, { type, title, body, link, icon, color, email, sms }) {
  const list = users.filter(Boolean);
  if (!list.length) return;
  const docs = await Notification.insertMany(list.map(u => ({ user: u._id, type, title, body, link, icon, color })));
  try {
    const { getIO } = require('../sockets/realtime');
    const io = getIO();
    docs.forEach(d => io?.to(`user:${d.user}`).emit('notification', d.toObject()));
  } catch { /* realtime not running (scripts, tests) */ }
  if (email) await sendMail({ to: list.map(u => u.email), ...email });
  if (sms) await Promise.all(list.filter(u => u.phone).map(u => sendSms(u.phone, sms)));
}
exports._deliver = deliver;

const FORM_LABEL = t => String(t || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

// ── Assets ───────────────────────────────────────────────────────────────────
exports.assetSubmitted = (asset, submitter) => run(async () => {
  if (asset.approvalStatus !== 'Pending') return;
  const who = submitter?.name || 'A field officer';
  await deliver(await usersForRoles(APPROVER_ROLES, submitter?._id), {
    type: 'ASSET_SUBMITTED', title: 'New capture awaiting approval', icon: 'fa-stamp', color: '#f0a500',
    body: `${who} captured "${asset.name}"${asset.state ? ` in ${asset.state}` : ''}.`, link: '/approvals',
    email: {
      subject: `New capture awaiting approval: ${asset.name}`, heading: 'A new asset capture needs review',
      lines: [`${who} captured "${asset.name}" (${asset.type || 'asset'}${asset.state ? `, ${asset.state}` : ''}).`,
        'It will join the verified registry once someone with approval rights reviews it.'],
      cta: { label: 'Review captures', url: `${appUrl()}/approvals` },
    },
  });
});

exports.assetDecided = (asset, decision, reason) => run(async () => {
  const approved = decision === 'Approved';
  const link = `/assets/${encodeURIComponent(asset.assetId)}`;
  await deliver([await userOf(asset.submittedBy || asset.capturedBy)], {
    type: 'ASSET_DECIDED', title: approved ? 'Capture approved' : 'Capture rejected',
    icon: approved ? 'fa-circle-check' : 'fa-circle-xmark', color: approved ? '#2DB87B' : '#e05555',
    body: `"${asset.name}" was ${approved ? 'approved' : 'rejected'}${!approved && reason ? ` — ${reason}` : ''}.`, link,
    email: {
      subject: `Your capture was ${approved ? 'approved' : 'rejected'}: ${asset.name}`,
      heading: approved ? 'Capture approved' : 'Capture rejected',
      lines: [approved ? `"${asset.name}" has been approved and is now part of the verified registry.` : `"${asset.name}" was not approved.`,
        ...(!approved && reason ? [`Reason: ${reason}`] : [])],
      cta: { label: 'Open the asset', url: `${appUrl()}${link}` },
    },
    sms: `FPAMAS: your capture "${asset.name}" was ${approved ? 'approved' : 'rejected'}${!approved && reason ? `: ${reason}` : ''}.`,
  });
});

// ── Inspections ──────────────────────────────────────────────────────────────
exports.inspectionSubmitted = (insp, submitterId) => run(async () => {
  const name = insp.assetName || insp.assetId;
  await deliver(await usersForRoles(APPROVER_ROLES, submitterId), {
    type: 'INSPECTION_SUBMITTED', title: 'Inspection report to review', icon: 'fa-clipboard-check', color: '#4A90D9',
    body: `${insp.report?.submittedBy || 'An inspector'} reported "${name}" as ${insp.report?.condition || '—'}.`, link: '/inspections',
    email: {
      subject: `Inspection report to review: ${name}`, heading: 'An inspection report is waiting for review',
      lines: [`${insp.report?.submittedBy || 'An inspector'} submitted the ${String(insp.type || 'routine').toLowerCase()} inspection for "${name}".`,
        `Condition found: ${insp.report?.condition || '—'}. Approving it updates the asset's condition and next inspection date.`],
      cta: { label: 'Review inspections', url: `${appUrl()}/inspections` },
    },
  });
});

exports.inspectionDecided = (insp, decision, reason) => run(async () => {
  const name = insp.assetName || insp.assetId;
  const d = decision.toLowerCase();
  await deliver([await userOf(insp.report?.submittedById)], {
    type: 'INSPECTION_DECIDED', title: `Inspection report ${d}`,
    icon: decision === 'Approved' ? 'fa-circle-check' : 'fa-circle-xmark', color: decision === 'Approved' ? '#2DB87B' : '#e05555',
    body: `Your report for "${name}" was ${d}${reason ? ` — ${reason}` : ''}.`, link: '/inspections',
    email: {
      subject: `Inspection report ${d}: ${name}`, heading: `Inspection report ${d}`,
      lines: [`Your inspection report for "${name}" was ${d}.`, ...(reason ? [`Reason: ${reason}`] : [])],
      cta: { label: 'Open inspections', url: `${appUrl()}/inspections` },
    },
    sms: `FPAMAS: your inspection report for "${name}" was ${d}${reason ? `: ${reason}` : ''}.`,
  });
});

// ── Form requests ────────────────────────────────────────────────────────────
exports.formRequestSubmitted = (request, submitter) => run(async () => {
  if (request.status !== 'Submitted') return;
  await deliver(await usersForRoles(APPROVER_ROLES, submitter?._id), {
    type: 'FORM_SUBMITTED', title: `New ${FORM_LABEL(request.formType)}`, icon: 'fa-file-circle-check', color: '#4A90D9',
    body: `${request.mda} submitted a ${FORM_LABEL(request.formType)}.`, link: '/form-requests',
    email: {
      subject: `New ${FORM_LABEL(request.formType)} from ${request.mda}`, heading: 'A compliance form was submitted',
      lines: [`${request.mda} submitted a ${FORM_LABEL(request.formType)}${submitter?.name ? ` (by ${submitter.name})` : ''}.`],
      cta: { label: 'Review form requests', url: `${appUrl()}/form-requests` },
    },
  });
});

exports.formRequestReviewed = request => run(async () => {
  if (!['UnderReview', 'Approved', 'Deferred', 'Rejected'].includes(request.status)) return;
  const status = request.status === 'UnderReview' ? 'under review' : request.status.toLowerCase();
  await deliver([await userOf(request.submittedBy)], {
    type: 'FORM_REVIEWED', title: `${FORM_LABEL(request.formType)} ${status}`,
    icon: request.status === 'Approved' ? 'fa-circle-check' : request.status === 'Rejected' ? 'fa-circle-xmark' : 'fa-hourglass-half',
    color: request.status === 'Approved' ? '#2DB87B' : request.status === 'Rejected' ? '#e05555' : '#f0a500',
    body: `FPAM marked your ${FORM_LABEL(request.formType)} as ${status}${request.reviewRemarks ? ` — ${request.reviewRemarks}` : ''}.`, link: '/portal',
    email: {
      subject: `Your ${FORM_LABEL(request.formType)} is ${status}`, heading: `Submission ${status}`,
      lines: [`FPAM has marked your ${FORM_LABEL(request.formType)} as ${status}.`, ...(request.reviewRemarks ? [`Remarks: ${request.reviewRemarks}`] : [])],
      cta: { label: 'View your submissions', url: `${appUrl()}/portal` },
    },
    sms: `FPAMAS: your ${FORM_LABEL(request.formType)} is now ${status}.`,
  });
});

exports.certificateIssued = request => run(async () => {
  await deliver([await userOf(request.submittedBy)], {
    type: 'CERTIFICATE_ISSUED', title: 'Certificate issued', icon: 'fa-certificate', color: '#2DB87B',
    body: `Certificate ${request.certificateNumber} is ready to download.`, link: '/portal',
    email: {
      subject: `Certificate issued: ${request.certificateNumber}`, heading: 'Your compliance certificate is ready',
      lines: [`Certificate ${request.certificateNumber} has been issued for your ${FORM_LABEL(request.formType)}.`,
        'You can download it from the portal. A physical copy will follow.'],
      cta: { label: 'Download certificate', url: `${appUrl()}/portal` },
    },
    sms: `FPAMAS: certificate ${request.certificateNumber} has been issued. Download it from the portal.`,
  });
});

// ── Data quality ─────────────────────────────────────────────────────────────
exports.dataQualityAssigned = (assigneeId, assets, assignedBy, note) => run(async () => {
  const n = assets.length;
  const first = assets[0];
  await deliver([await userOf(assigneeId)], {
    type: 'DATA_FIX_ASSIGNED', title: 'Data fixes assigned to you', icon: 'fa-screwdriver-wrench', color: '#4A90D9',
    body: `${assignedBy?.name || 'An admin'} asked you to fix ${n === 1 ? `"${first.name}"` : `${n} assets`}${note ? ` — ${note}` : ''}.`,
    link: '/data-quality?mine=1',
    email: {
      subject: `Data fixes assigned to you (${n})`, heading: 'You have assets to tidy up',
      lines: [`${assignedBy?.name || 'An admin'} assigned ${n} asset${n === 1 ? '' : 's'} with data problems to you.`, ...(note ? [`Note: ${note}`] : [])],
      cta: { label: 'Open data quality', url: `${appUrl()}/data-quality?mine=1` },
    },
  });
});

// ── Accounts ─────────────────────────────────────────────────────────────────
// These return the send result so the caller can tell the admin whether it went.
exports.accountCreated = (user, password) => sendMail({
  to: user.email,
  subject: 'Your FPAM Asset Platform account',
  heading: `Welcome, ${user.name}`,
  lines: [`An account has been created for you as ${user.role}.`, `Sign-in email: ${user.email}`,
    ...(password ? [`Temporary password: ${password}`, 'Please change it after you sign in (your name in the sidebar → Change password).'] : [])],
  cta: { label: 'Sign in', url: `${appUrl()}/dashboard` },
});

exports.passwordResetByAdmin = (user, password) => sendMail({
  to: user.email,
  subject: 'Your FPAM password was reset',
  heading: 'Your password was reset',
  lines: ['A System Admin reset your password.', `New temporary password: ${password}`,
    'Please sign in and change it straight away.'],
  cta: { label: 'Sign in', url: `${appUrl()}/dashboard` },
  footnote: "If you didn't expect this, contact your System Admin.",
});

exports.passwordResetLink = (user, link) => sendMail({
  to: user.email,
  subject: 'Reset your FPAM password',
  heading: 'Reset your password',
  lines: ['We received a request to reset the password for this account. The link works once and expires in 1 hour.'],
  cta: { label: 'Choose a new password', url: link },
  footnote: "If you didn't ask for this, you can ignore this email — your password won't change.",
});
