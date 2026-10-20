'use strict';
// ── Email notifications ───────────────────────────────────────────────────────
// Who gets told what. Every function is fire-and-forget: call it without
// awaiting; failures are logged by the mailer and never affect the request.
//
//   Event                                   Recipients
//   ─────────────────────────────────────── ───────────────────────────────────
//   Capture submitted for approval          Approvers (Sub-Head, Supervisor, System Admin)
//   Capture approved / rejected             The person who submitted it
//   Inspection report submitted             Approvers
//   Inspection report approved / rejected   The inspector who submitted it
//   Form request submitted by an MDA        Form reviewers (Sub-Head, Supervisor, System Admin)
//   Form request reviewed (status change)   The MDA agent who submitted it
//   Certificate issued                      The MDA agent who submitted it
//   Account created (if requested)          The new user
//   Password reset by an admin (if asked)   The user
//   Forgot-password link                    The user

const User = require('../models/User');
const { sendMail, appUrl } = require('./mailer');

const APPROVER_ROLES = ['Sub-Head', 'Supervisor', 'System Admin'];

async function emailsForRoles(roles, excludeId) {
  const users = await User.find({ role: { $in: roles }, isActive: true }, { email: 1 }).lean();
  return users.filter(u => String(u._id) !== String(excludeId || '')).map(u => u.email);
}
async function emailOf(userOrId) {
  if (!userOrId) return null;
  if (typeof userOrId === 'object' && userOrId.email) return userOrId.email;
  const u = await User.findById(userOrId._id || userOrId, { email: 1, isActive: 1 }).lean().catch(() => null);
  return u && u.isActive !== false ? u.email : null;
}
const run = fn => { Promise.resolve().then(fn).catch(err => console.error('[notify]', err.message)); };

const FORM_LABEL = t => String(t || '').toLowerCase().replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase());

// ── Assets ───────────────────────────────────────────────────────────────────
exports.assetSubmitted = (asset, submitter) => run(async () => {
  if (asset.approvalStatus !== 'Pending') return;
  await sendMail({
    to: await emailsForRoles(APPROVER_ROLES, submitter?._id),
    subject: `New capture awaiting approval: ${asset.name}`,
    heading: 'A new asset capture needs review',
    lines: [`${submitter?.name || 'A field officer'} captured "${asset.name}" (${asset.type || 'asset'}${asset.state ? `, ${asset.state}` : ''}).`,
      'It will join the verified registry once someone with approval rights reviews it.'],
    cta: { label: 'Review captures', url: `${appUrl()}/approvals` },
  });
});

exports.assetDecided = (asset, decision, reason) => run(async () => {
  const to = await emailOf(asset.submittedBy || asset.capturedBy);
  const approved = decision === 'Approved';
  await sendMail({
    to,
    subject: `Your capture was ${approved ? 'approved' : 'rejected'}: ${asset.name}`,
    heading: approved ? 'Capture approved' : 'Capture rejected',
    lines: [approved ? `"${asset.name}" has been approved and is now part of the verified registry.`
      : `"${asset.name}" was not approved.`, ...(!approved && reason ? [`Reason: ${reason}`] : [])],
    cta: { label: 'Open the asset', url: `${appUrl()}/assets/${encodeURIComponent(asset.assetId)}` },
  });
});

// ── Inspections ──────────────────────────────────────────────────────────────
exports.inspectionSubmitted = (insp, submitterId) => run(async () => {
  await sendMail({
    to: await emailsForRoles(APPROVER_ROLES, submitterId),
    subject: `Inspection report to review: ${insp.assetName || insp.assetId}`,
    heading: 'An inspection report is waiting for review',
    lines: [`${insp.report?.submittedBy || 'An inspector'} submitted the ${String(insp.type || 'routine').toLowerCase()} inspection for "${insp.assetName || insp.assetId}".`,
      `Condition found: ${insp.report?.condition || '—'}. Approving it updates the asset's condition and next inspection date.`],
    cta: { label: 'Review inspections', url: `${appUrl()}/inspections` },
  });
});

exports.inspectionDecided = (insp, decision, reason) => run(async () => {
  const to = await emailOf(insp.report?.submittedById);
  await sendMail({
    to,
    subject: `Inspection report ${decision.toLowerCase()}: ${insp.assetName || insp.assetId}`,
    heading: `Inspection report ${decision.toLowerCase()}`,
    lines: [`Your inspection report for "${insp.assetName || insp.assetId}" was ${decision.toLowerCase()}.`, ...(reason ? [`Reason: ${reason}`] : [])],
    cta: { label: 'Open inspections', url: `${appUrl()}/inspections` },
  });
});

// ── Form requests ────────────────────────────────────────────────────────────
exports.formRequestSubmitted = (request, submitter) => run(async () => {
  if (request.status !== 'Submitted') return;
  await sendMail({
    to: await emailsForRoles(APPROVER_ROLES, submitter?._id),
    subject: `New ${FORM_LABEL(request.formType)} from ${request.mda}`,
    heading: 'A compliance form was submitted',
    lines: [`${request.mda} submitted a ${FORM_LABEL(request.formType)}${submitter?.name ? ` (by ${submitter.name})` : ''}.`],
    cta: { label: 'Review form requests', url: `${appUrl()}/form-requests` },
  });
});

exports.formRequestReviewed = request => run(async () => {
  if (!['UnderReview', 'Approved', 'Deferred', 'Rejected'].includes(request.status)) return;
  const status = request.status === 'UnderReview' ? 'under review' : request.status.toLowerCase();
  await sendMail({
    to: await emailOf(request.submittedBy),
    subject: `Your ${FORM_LABEL(request.formType)} is ${status}`,
    heading: `Submission ${status}`,
    lines: [`FPAM has marked your ${FORM_LABEL(request.formType)} as ${status}.`,
      ...(request.reviewRemarks ? [`Remarks: ${request.reviewRemarks}`] : [])],
    cta: { label: 'View your submissions', url: `${appUrl()}/portal` },
  });
});

exports.certificateIssued = request => run(async () => {
  await sendMail({
    to: await emailOf(request.submittedBy),
    subject: `Certificate issued: ${request.certificateNumber}`,
    heading: 'Your compliance certificate is ready',
    lines: [`Certificate ${request.certificateNumber} has been issued for your ${FORM_LABEL(request.formType)}.`,
      'You can download it from the portal. A physical copy will follow.'],
    cta: { label: 'Download certificate', url: `${appUrl()}/portal` },
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
