'use strict';
const AuditLog = require('../models/AuditLog');

/**
 * Extracts the real client IP from the request.
 * - In production behind a proxy (Nginx, Render, Vercel, etc.), the real IP
 *   is in the X-Forwarded-For header. `trust proxy` must be set in Express
 *   (`app.set('trust proxy', 1)`) for req.ip to reflect this automatically,
 *   but we also read the header directly as a fallback.
 * - ::1 and ::ffff:127.0.0.1 are IPv6 representations of localhost — we
 *   normalise them to '127.0.0.1' so the audit log is readable.
 * - ::ffff:x.x.x.x is an IPv4-mapped IPv6 address — we strip the prefix.
 */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = (forwarded ? forwarded.split(',')[0].trim() : null)
            || req.ip
            || req.connection?.remoteAddress
            || '';

  if (raw === '::1' || raw === '::ffff:127.0.0.1') return '127.0.0.1';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw || null;
}

/**
 * Factory — wrap a route with automatic audit logging.
 * Usage: router.post('/assets', auth, auditLog('ASSET_CREATED', 'Asset'), handler)
 *
 * Route handlers set res.locals.auditEntityId and res.locals.auditDetail for enrichment.
 */
function auditLog(action, entityType) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;  // only log successful mutations

      const entityId = res.locals.auditEntityId
        || req.params.id
        || req.params.assetId
        || null;

      AuditLog.create({
        action,
        entityType,
        entityId,
        performedBy: req.user?._id || req.user?.id || null,
        detail:      res.locals.auditDetail || '',
        ipAddress:   getClientIp(req),
        userAgent:   req.get('user-agent'),
        metadata:    res.locals.auditMetadata || undefined,
      }).catch((err) => console.error('[Audit] Failed to write log:', err));
    });
    next();
  };
}

module.exports = { auditLog };


/**
 * Factory — wrap a route with automatic audit logging.
 * Usage: router.post('/assets', auth, auditLog('ASSET_CREATED', 'Asset'), handler)
 *
 * Route handlers set res.locals.auditEntityId and res.locals.auditDetail for enrichment.
 */
function auditLog(action, entityType) {
  return (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;  // only log successful mutations

      const entityId = res.locals.auditEntityId
        || req.params.id
        || req.params.assetId
        || null;

      AuditLog.create({
        action,
        entityType,
        entityId,
        performedBy: req.user?._id || req.user?.id || null,
        detail:      res.locals.auditDetail || '',
        ipAddress:   req.ip,
        userAgent:   req.get('user-agent'),
        metadata:    res.locals.auditMetadata || undefined,
      }).catch((err) => console.error('[Audit] Failed to write log:', err));
    });
    next();
  };
}

module.exports = { auditLog };