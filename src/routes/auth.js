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
    const user = await User.findOne({ email, isActive: true }).select('+password').lean({ virtuals: false });

    // Use a plain lean doc but attach comparePassword manually
    const userDoc = await User.findOne({ email, isActive: true }).select('+password');
    if (!userDoc) return res.status(401).json({ error: 'Invalid credentials' });

console.log('user found:', !!user);
if (user) {
  console.log('input password:', password);
console.log('stored hash:', user.password);
  const match = await bcrypt.compare(password, user.password);
  console.log('password match:', match);
}
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

module.exports = router;
