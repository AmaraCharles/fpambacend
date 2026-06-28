'use strict';
// ── ASSET APPROVAL ROUTES ─────────────────────────────────────────────────────
// Mount at: app.use('/api/asset-approvals', require('./routes/asset_approval_routes'));
//
// Deliberately mounted at its own top-level path rather than nested under
// /api/assets/:id/... — that keeps it independent of however the existing
// generic asset CRUD router is structured, so it can be dropped in without
// touching that file at all.

const router = require('express').Router();
const assetService = require('../services/assetService');
const { authenticate }                    = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');
const { scopeFilter }                     = require('../middleware/scopeFilter');
const { auditLog }                        = require('../middleware/auditMiddleware');
const { validateBody, schemas }           = require('../middleware/validate');

const auth = [authenticate, resolvePermissions, scopeFilter];

// ── LIST ──────────────────────────────────────────────────────────────────────
// GET /api/asset-approvals?status=Pending|Approved|Rejected|all&page=&limit=
//
// Users with canApproveAssets (Sub-Head / Supervisor / System Admin) see the
// full queue. Everyone else (e.g. a Field Agent) is scoped to only the items
// they personally submitted, so they can track the status of their own
// captures without being able to browse anyone else's pending work.
router.get('/', ...auth, async (req, res) => {
  try {
    const { status = 'Pending', page = 1, limit = 50 } = req.query;

    let filter = { ...req.scopeFilter };
    if (!req.permissions?.canApproveAssets) {
      filter = { ...filter, submittedBy: req.user._id };
    }

    const result = await assetService.listPendingApprovals({ status, page, limit, scopeFilter: filter });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SUMMARY ───────────────────────────────────────────────────────────────────
// GET /api/asset-approvals/summary — counts for a dashboard/sidebar badge.
router.get('/summary', ...auth, requirePerm('canApproveAssets'), async (req, res) => {
  try {
    const summary = await assetService.approvalsSummary(req.scopeFilter);
    res.json(summary);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── APPROVE ───────────────────────────────────────────────────────────────────
// POST /api/asset-approvals/:id/approve
router.post('/:id/approve',
  ...auth,
  requirePerm('canApproveAssets'),
  auditLog('ASSET_APPROVED', 'Asset'),
  async (req, res) => {
    try {
      const asset = await assetService.approveAsset(req.params.id, req.user._id);
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `${asset.name} approved`;
      res.json({ asset });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  }
);

// ── REJECT ────────────────────────────────────────────────────────────────────
// POST /api/asset-approvals/:id/reject   body: { reason }
router.post('/:id/reject',
  ...auth,
  requirePerm('canApproveAssets'),
  validateBody(schemas.assetReject),
  auditLog('ASSET_REJECTED', 'Asset'),
  async (req, res) => {
    try {
      const asset = await assetService.rejectAsset(req.params.id, req.user._id, req.body.reason);
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `${asset.name} rejected${req.body.reason ? ': ' + req.body.reason : ''}`;
      res.json({ asset });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message });
    }
  }
);

module.exports = router;