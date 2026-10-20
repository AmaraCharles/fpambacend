'use strict';
const router     = require('express').Router();
const crypto     = require('crypto');
const User       = require('../models/User');
const { getRoleConfigOverrides, ROLE_DEFAULTS, SHORT_TO_LONG } = require('../middleware/resolvePermissions');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditMiddleware');
const { validateBody, schemas } = require('../middleware/validate');
const notify = require('../services/notify');

const adminOnly = [authenticate, requireRole('System Admin')];

// ─────────────────────────────────────────────────────────────────────────────
// User management
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/users
router.get('/', ...adminOnly, async (req, res, next) => {
  try {
    const { role, state, active, page = 1, limit = 50 } = req.query;
    const filter = {};
    if (role)               filter.role     = role;
    if (state)              filter.states   = state;
    if (active !== undefined) filter.isActive = active === 'true';

    const skip = (page - 1) * limit;
    const [users, total] = await Promise.all([
      User.find(filter).skip(+skip).limit(+limit).sort({ createdAt: -1 }).select('-password').lean(),
      User.countDocuments(filter),
    ]);
    res.json({ users, total, page: +page, pages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
});

// POST /api/users
router.post('/',
  ...adminOnly,
  validateBody(schemas.createUser),
  auditLog('USER_CREATED', 'User'),
  async (req, res, next) => {
    try {
      const { sendCredentials, ...fields } = req.body;
      const user = await User.create({ ...fields, createdBy: req.user._id });
      res.locals.auditEntityId = user.userId;
      res.locals.auditDetail   = `${user.name} (${user.role}) created`;
      const mail = sendCredentials ? await notify.accountCreated(user, fields.password) : { sent: false };
      res.status(201).json({ user: user.toSafeObject(), emailed: mail.sent, emailError: sendCredentials && !mail.sent ? mail.reason : undefined });
    } catch (err) {
      if (err.code === 11000) return res.status(409).json({ error: 'Email already in use' });
      next(err);
    }
  }
);

// GET /api/users/:id
router.get('/:id', ...adminOnly, async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id).select('-password').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Attach effective permissions — computed the exact same way live
    // requests resolve them (role baseline → admin-configured role
    // override → this user's individual override), so what the admin sees
    // here always matches what actually gets enforced. Previously this read
    // via the RoleConfig Mongoose model, whose schema declares long key
    // names (canApproveAssets, ...) — but routes/role_config_routes.js
    // actually writes to that same "roleconfigs" collection using SHORT
    // keys (canApprove, ...) via the raw driver, bypassing the schema
    // entirely. Mongoose can't hydrate fields it doesn't recognize, so this
    // was silently showing empty/default values for any role an admin had
    // ever actually customized through the Settings page.
    let effectivePermissions = { all: true };
    if (user.role !== 'System Admin') {
      const base = ROLE_DEFAULTS[user.role] || ROLE_DEFAULTS['Field Agent'];
      const allOverrides = await getRoleConfigOverrides();
      const roleOverride = allOverrides[user.role] || {};
      // user.permissions is stored with the same SHORT keys the Settings/
      // Users UI writes (validate.js's `permissions` schema) — translate
      // before merging, same as resolvePermissions.js's actual enforcement
      // logic, or this preview would show a different result than what
      // actually gets enforced for this user.
      const rawUserOverride = user.permissions || {};
      const userOverride = {};
      for (const [key, val] of Object.entries(rawUserOverride)) {
        userOverride[SHORT_TO_LONG[key] || key] = val;
      }
      effectivePermissions = { ...base, ...roleOverride, ...userOverride };
    }

    res.json({ user, effectivePermissions });
  } catch (err) { next(err); }
});

// PUT /api/users/:id
router.put('/:id',
  ...adminOnly,
  validateBody(schemas.updateUser),
  auditLog('USER_UPDATED', 'User'),
  async (req, res, next) => {
    try {
      // Prevent System Admin from downgrading themselves
      if (req.params.id === req.user._id.toString() && req.body.role && req.body.role !== 'System Admin') {
        return res.status(400).json({ error: 'Cannot change your own role' });
      }
      if (req.params.id === req.user._id.toString() && req.body.isActive === false) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
      }
      const user = await User.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true }).select('-password').lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.locals.auditEntityId = user.userId;
      res.locals.auditDetail   = `${user.name} updated`;
      res.json({ user });
    } catch (err) { next(err); }
  }
);

// PUT /api/users/:id/permissions
router.put('/:id/permissions',
  ...adminOnly,
  validateBody(schemas.permissions),
  auditLog('USER_UPDATED', 'User'),
  async (req, res, next) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.params.id,
        { $set: { permissions: req.body } },
        { new: true }
      ).select('-password').lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.locals.auditDetail = `Permissions updated for ${user.name}`;
      res.json({ user });
    } catch (err) { next(err); }
  }
);

// DELETE /api/users/:id  — soft delete
router.delete('/:id',
  ...adminOnly,
  auditLog('USER_REMOVED', 'User'),
  async (req, res, next) => {
    try {
      if (req.params.id === req.user._id.toString()) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
      }
      const user = await User.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true }).lean();
      if (!user) return res.status(404).json({ error: 'User not found' });
      res.locals.auditEntityId = user.userId;
      res.locals.auditDetail   = `${user.name} deactivated`;
      res.json({ message: 'User deactivated' });
    } catch (err) { next(err); }
  }
);

// POST /api/users/:id/reset-password
// Body (all optional): { password, sendEmail }
//   password  — set this exact password (min 8 chars); omitted = generate one
//   sendEmail — also email the new password to the user
router.post('/:id/reset-password', ...adminOnly, auditLog('USER_UPDATED', 'User'), async (req, res, next) => {
  try {
    const { password, sendEmail } = req.body || {};
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newPassword = password || crypto.randomBytes(6).toString('base64url');
    user.password = newPassword;
    user.resetToken = undefined;          // any outstanding email link stops working
    user.resetTokenExpires = undefined;
    await user.save();  // triggers bcrypt pre-save hook
    res.locals.auditEntityId = user.userId;
    res.locals.auditDetail   = `Password reset for ${user.name}${sendEmail ? ' (emailed)' : ''}`;
    const mail = sendEmail ? await notify.passwordResetByAdmin(user, newPassword) : { sent: false };
    res.json({
      // Only echo a generated password; an admin-chosen one they already know.
      tempPassword: password ? undefined : newPassword,
      emailed: mail.sent,
      emailError: sendEmail && !mail.sent ? mail.reason : undefined,
    });
  } catch (err) { next(err); }
});

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: role configuration (GET/PUT/POST /role-config...) intentionally
// lives ONLY in routes/role_config_routes.js now, mounted at
// /api/users/role-config in app.js — BEFORE this router. A duplicate set of
// role-config routes used to live here too, at the exact same path
// (/api/users/role-config), using the RoleConfig Mongoose model's long key
// names. Since Express matches mounted routers in registration order and
// role_config_routes.js is mounted first, these were permanently
// unreachable dead code — every request matched role_config_routes.js
// first and never got here at all. They also used an incompatible key
// shape from what users.html's admin UI actually sends/expects (short
// keys), so even if the mount order were fixed, wiring them back in would
// have broken the Settings page rather than fixed anything. Removed rather
// than resurrected.
// ─────────────────────────────────────────────────────────────────────────────

module.exports = router;