'use strict';
const router   = require('express').Router();
const AuditLog = require('../models/AuditLog');
const { authenticate }       = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');

// GET /api/audit
// Permission key here MUST match resolvePermissions.js's ROLE_DEFAULTS
// exactly — it defines `canViewAudit` (System Admin, Supervisor, GIS
// Analyst). This route previously required `canViewAuditLog`, a key that
// exists nowhere in ROLE_DEFAULTS, so `req.permissions.canViewAuditLog`
// was always undefined and requirePerm() 403'd every single role,
// including System Admin — breaking both the main Audit Log page and the
// embedded per-asset Audit tab on asset-view.html for everyone, always.
router.get('/',
  authenticate, resolvePermissions, requirePerm('canViewAudit'),
  async (req, res, next) => {
    try {
      const { action, entityId, entityType, entity, from, to, page = 1, limit = 50 } = req.query;
      const filter = {};
      if (action)     filter.action     = action;
      // The per-asset Audit tab (asset-view.html renderAuditTab) sends
      // ?entity=<assetId>, not ?entityId=<assetId> — accept both so that
      // caller keeps working without also having to touch the frontend.
      if (entityId || entity) filter.entityId = entityId || entity;
      if (entityType) filter.entityType = entityType;
      if (from || to) {
        filter.ts = {};
        if (from) filter.ts.$gte = new Date(from);
        // A bare date (YYYY-MM-DD) means "up to the end of that day" —
        // new Date('2026-10-18') is midnight, which excluded the whole day.
        if (to)   filter.ts.$lte = /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59.999Z`) : new Date(to);
      }

      const skip = (page - 1) * limit;
      const [logs, total] = await Promise.all([
        AuditLog.find(filter)
          .skip(+skip).limit(+limit)
          .sort({ ts: -1 })
          .populate('performedBy', 'name email role')
          .lean(),
        AuditLog.countDocuments(filter),
      ]);

      res.json({ logs, total, page: +page, pages: Math.ceil(total / limit) });
    } catch (err) { next(err); }
  }
);

module.exports = router;