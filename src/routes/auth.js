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


router.post('/login', authLimiter, validateBody(schemas.login), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const userDoc = await User.findOne({ email, isActive: true }).select('+password');
    if (!userDoc) return res.status(401).json({ error: 'Invalid credentials' });
    // (Debug logging of the submitted password and stored hash removed — it
    // wrote every user's plain-text password to the server logs.)
    const ok = await userDoc.comparePassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { sub: userDoc._id.toString(), role: userDoc.role },
      env.JWT_SECRET,
      { expiresIn: env.JWT_EXPIRES_IN }
    );

    // Update last active
    await User.updateOne({ _id: userDoc._id }, { 'stats.lastActiveAt': new Date() });

    AuditLog.create({
      action: 'USER_LOGIN', entityId: userDoc.userId,
      entityType: 'User', performedBy: userDoc._id,
      ipAddress: req.ip, userAgent: req.get('user-agent'),
    }).catch(() => {});

    res.json({ token, user: userDoc.toSafeObject() });
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
  res.json({ user: req.user });
});

// ── Password self-service ────────────────────────────────────────────────────
const crypto = require('crypto');
const notify = require('../services/notify');
const { appUrl } = require('../services/mailer');
const sha256 = v => crypto.createHash('sha256').update(String(v)).digest('hex');
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
    await user.save();
    AuditLog.create({ action: 'USER_UPDATED', entityId: user.userId, entityType: 'User', performedBy: user._id, detail: 'Changed own password', ipAddress: req.ip }).catch(() => {});
    res.json({ message: 'Password changed' });
  } catch (err) { next(err); }
});

module.exports = router;
