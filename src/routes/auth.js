'use strict';
const router = require('express').Router();
const jwt    = require('jsonwebtoken');
const User   = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { authenticate } = require('../middleware/auth');
const { validateBody, schemas } = require('../middleware/validate');
const bcrypt = require('bcryptjs');
const { authLimiter } = require('../middleware/rateLimiter');
const env = require('../config/env');
const totp = require('../utils/totp');
const { mfaSetupRequired } = require('../utils/mfaPolicy');
const crypto = require('crypto');
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');

/** Session token. `tv` lets "sign out everywhere" revoke it (see middleware/auth). */
const signToken = user => jwt.sign(
  { sub: user._id.toString(), role: user.role, tv: user.tokenVersion || 0 },
  env.JWT_SECRET,
  { expiresIn: env.JWT_EXPIRES_IN },
);

/** Complete a sign-in: record it and return the session. */
async function finishLogin(req, res, userDoc, detail) {
  await User.updateOne({ _id: userDoc._id }, { 'stats.lastActiveAt': new Date() });
  AuditLog.create({
    action: 'USER_LOGIN', entityId: userDoc.userId,
    entityType: 'User', performedBy: userDoc._id, detail,
    ipAddress: req.ip, userAgent: req.get('user-agent'),
  }).catch(() => {});
  res.json({ token: signToken(userDoc), user: { ...userDoc.toSafeObject(), mfaSetupRequired: mfaSetupRequired(userDoc) } });
}

router.post('/login', authLimiter, validateBody(schemas.login), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const userDoc = await User.findOne({ email, isActive: true }).select('+password');
    if (!userDoc) return res.status(401).json({ error: 'Invalid credentials' });
    // (Debug logging of the submitted password and stored hash removed — it
    // wrote every user's plain-text password to the server logs.)
    const ok = await userDoc.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    // Two-step sign-in: the password was right, now ask for the app code.
    // The mfaToken is only accepted by /mfa/verify and expires in 5 minutes.
    if (userDoc.mfa?.enabled) {
      const mfaToken = jwt.sign({ sub: userDoc._id.toString(), purpose: 'mfa', tv: userDoc.tokenVersion || 0 }, env.JWT_SECRET, { expiresIn: '5m' });
      return res.json({ mfaRequired: true, mfaToken });
    }
    await finishLogin(req, res, userDoc);
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/verify { mfaToken, code }  — code from the app, or a recovery code
router.post('/mfa/verify', authLimiter, async (req, res, next) => {
  try {
    let payload;
    try { payload = jwt.verify(String(req.body?.mfaToken || ''), env.JWT_SECRET); } catch { payload = null; }
    if (!payload || payload.purpose !== 'mfa') return res.status(401).json({ error: 'Sign-in expired — enter your password again' });
    const user = await User.findOne({ _id: payload.sub, isActive: true }).select('+mfa.secret +mfa.recoveryCodes');
    if (!user || !user.mfa?.enabled || (payload.tv || 0) !== (user.tokenVersion || 0)) return res.status(401).json({ error: 'Sign-in expired — enter your password again' });

    const code = String(req.body?.code || '').trim();
    if (totp.verifyTotp(user.mfa.secret, code)) return finishLogin(req, res, user, 'Two-step sign-in');
    const hash = sha256(code.toUpperCase().replace(/[^A-Z0-9]/g, ''));
    const idx = (user.mfa.recoveryCodes || []).indexOf(hash);
    if (idx !== -1) {
      user.mfa.recoveryCodes.splice(idx, 1);                   // each recovery code works once
      await user.save({ validateBeforeSave: false });
      return finishLogin(req, res, user, `Two-step sign-in with a recovery code (${user.mfa.recoveryCodes.length} left)`);
    }
    res.status(401).json({ error: 'That code is not right — check the time on your phone and try again' });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/setup — start: returns a new secret to add to the app
router.post('/mfa/setup', authenticate, async (req, res, next) => {
  try {
    const secret = totp.generateSecret();
    await User.updateOne({ _id: req.user._id }, { 'mfa.pendingSecret': secret });
    res.json({ secret, otpauthUrl: totp.otpauthUrl(secret, req.user.email) });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/enable { code } — confirm the app works; returns one-time recovery codes
router.post('/mfa/enable', authenticate, authLimiter, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+mfa.pendingSecret');
    if (!user?.mfa?.pendingSecret) return res.status(400).json({ error: 'Start setup first' });
    if (!totp.verifyTotp(user.mfa.pendingSecret, req.body?.code)) return res.status(400).json({ error: 'That code is not right — try the newest code in the app' });
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'));
    user.mfa.secret = user.mfa.pendingSecret;
    user.mfa.pendingSecret = undefined;
    user.mfa.enabled = true;
    user.mfa.enabledAt = new Date();
    user.mfa.recoveryCodes = codes.map(c => sha256(c.replace(/-/g, '')));
    await user.save({ validateBeforeSave: false });
    AuditLog.create({ action: 'USER_UPDATED', entityId: user.userId, entityType: 'User', performedBy: user._id, detail: 'Turned on two-step sign-in', ipAddress: req.ip }).catch(() => {});
    res.json({ message: 'Two-step sign-in is on', recoveryCodes: codes });
  } catch (err) { next(err); }
});

// POST /api/auth/mfa/disable { password }
router.post('/mfa/disable', authenticate, authLimiter, async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id).select('+password');
    if (!user || !(await user.comparePassword(String(req.body?.password || '')))) return res.status(400).json({ error: 'Password is incorrect' });
    user.mfa = { enabled: false };
    await user.save({ validateBeforeSave: false });
    AuditLog.create({ action: 'USER_UPDATED', entityId: user.userId, entityType: 'User', performedBy: user._id, detail: 'Turned off two-step sign-in', ipAddress: req.ip }).catch(() => {});
    res.json({ message: 'Two-step sign-in is off' });
  } catch (err) { next(err); }
});

// POST /api/auth/logout-all — end every session, on every device (including this one)
router.post('/logout-all', authenticate, async (req, res, next) => {
  try {
    await User.updateOne({ _id: req.user._id }, { $inc: { tokenVersion: 1 } });
    AuditLog.create({ action: 'USER_LOGOUT', entityId: req.user.userId, entityType: 'User', performedBy: req.user._id, detail: 'Signed out everywhere', ipAddress: req.ip }).catch(() => {});
    res.json({ message: 'Signed out on every device' });
  } catch (err) { next(err); }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    AuditLog.create({
      action: 'USER_LOGOUT', entityId: req.user.userId,
      entityType: 'User', performedBy: req.user._id,
      ipAddress: req.ip,
    }).catch(() => {});
    res.json({ message: 'Logged out' });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: { ...req.user, mfaSetupRequired: mfaSetupRequired(req.user) } });
});

// ── Password self-service ────────────────────────────────────────────────────
const notify = require('../services/notify');
const { appUrl } = require('../services/mailer');
const strongEnough = p => typeof p === 'string' && p.length >= 8;

// POST /api/auth/forgot-password { email }
// Always answers the same way so it can't be used to discover which emails exist.
router.post('/forgot-password', authLimiter, async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const generic = { message: 'If that email belongs to an active account, a reset link has been sent.' };
    if (!email) return res.json(generic);
    const user = await User.findOne({ email, isActive: true });
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      user.resetToken = sha256(token);                       // only the hash is stored
      user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
      await user.save({ validateBeforeSave: false });
      notify.passwordResetLink(user, `${appUrl()}/reset-password?token=${token}`);
    }
    res.json(generic);
  } catch (err) { next(err); }
});

// POST /api/auth/reset-password { token, password }
router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Reset link is missing its token' });
    if (!strongEnough(password)) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const user = await User.findOne({ resetToken: sha256(token), resetTokenExpires: { $gt: new Date() }, isActive: true })
      .select('+resetToken +resetTokenExpires');
    if (!user) return res.status(400).json({ error: 'This reset link is invalid or has expired — request a new one' });
    user.password = password;            // hashed by the pre-save hook
    user.resetToken = undefined;
    user.resetTokenExpires = undefined;
    user.tokenVersion = (user.tokenVersion || 0) + 1;   // sign out everywhere
    await user.save();
    AuditLog.create({ action: 'USER_UPDATED', entityId: user.userId, entityType: 'User', performedBy: user._id, detail: 'Password reset via email link', ipAddress: req.ip }).catch(() => {});
    res.json({ message: 'Password updated — you can sign in now' });
  } catch (err) { next(err); }
});

// POST /api/auth/change-password { currentPassword, newPassword }
router.post('/change-password', authenticate, authLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!strongEnough(newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    const user = await User.findById(req.user._id).select('+password');
    if (!user || !(await user.comparePassword(String(currentPassword || '')))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    user.password = newPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;   // other devices are signed out
    await user.save();
    AuditLog.create({ action: 'USER_UPDATED', entityId: user.userId, entityType: 'User', performedBy: user._id, detail: 'Changed own password', ipAddress: req.ip }).catch(() => {});
    // This device stays signed in with a fresh token.
    res.json({ message: 'Password changed', token: signToken(user) });
  } catch (err) { next(err); }
});

module.exports = router;
