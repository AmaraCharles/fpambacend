'use strict';
const rateLimit   = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { getRedis, isRedisAvailable } = require('../config/redis');
const env = require('../config/env');

function buildLimiter(max, windowMs) {
  const options = {
    windowMs: windowMs || env.RATE_LIMIT_WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',   // automated tests sign in many times
    handler: (_req, res) => res.status(429).json({ error: 'Too many requests — please slow down.' }),
  };

  // Only use Redis store if Redis is reachable
  if (isRedisAvailable()) {
    try {
      options.store = new RedisStore({
        sendCommand: (...args) => getRedis().call(...args),
      });
    } catch {
      // fall through to in-memory store
    }
  }

  return rateLimit(options);
}

function roleLimiter() {
  const fieldAgentLimiter = buildLimiter(100);
  const supervisorLimiter = buildLimiter(300);
  const analystLimiter    = buildLimiter(300);
  const adminLimiter      = buildLimiter(500);

  return (req, res, next) => {
    if (!req.user) return next();
    switch (req.user.role) {
      case 'Field Agent':   return fieldAgentLimiter(req, res, next);
      case 'Supervisor':    return supervisorLimiter(req, res, next);
      case 'GIS Analyst':   return analystLimiter(req, res, next);
      case 'System Admin':  return adminLimiter(req, res, next);
      default:              return next();
    }
  };
}

const authLimiter = buildLimiter(20, 15 * 60 * 1000);

module.exports = { roleLimiter, authLimiter };
