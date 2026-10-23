'use strict';
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const env = require('../config/env');

/**
 * Verify JWT and attach req.user
 */
async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.slice(7);
    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Short-lived "password OK, now enter your code" tokens are only good for
    // /auth/mfa/verify, never for the API.
    if (payload.purpose) return res.status(401).json({ error: 'Invalid or expired token' });

    const user = await User.findById(payload.sub).select('-password -resetToken -resetTokenExpires').lean();
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Account not found or deactivated' });
    }
    // Signed out everywhere (password changed, "sign out everywhere", etc.)
    if ((payload.tv || 0) !== (user.tokenVersion || 0)) {
      return res.status(401).json({ error: 'Your session has ended — please sign in again' });
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Require one or more roles.  requireRole('System Admin') or requireRole(['Supervisor','System Admin'])
 */
function requireRole(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!allowed.includes(req.user.role)) {
      return res.status(403).json({ error: `Requires role: ${allowed.join(' or ')}` });
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
