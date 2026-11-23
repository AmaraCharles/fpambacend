'use strict';
// ── PUBLIC GALLERY (staff side) ───────────────────────────────────────────────
// Mount at: app.use('/api/gallery', require('./routes/gallery_routes'));
//
// PATCH /api/gallery/assets/:id   — { enabled, caption } show/hide an asset on the website gallery
// GET   /api/gallery/assets       — assets currently shown (for the dashboard)
//
// The public side is GET /api/public/gallery and /api/public/photos/:fileId
// (routes/public_routes.js), which only ever expose name, type, location,
// caption and general photos.

const router = require('express').Router();
const Asset = require('../models/Asset');
const { idQuery } = require('../services/assetService');
const { authenticate } = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { auditLog } = require('../middleware/auditMiddleware');

const GALLERY_ROLES = ['System Admin', 'Supervisor', 'Sub-Head'];

/** The asset's general photos: excludes photos that belong to one of its M&E reports. */
function generalPhotos(asset) {
  const reportIds = new Set((asset.meReports || []).map(r => String(r._id)));
  return (asset.photos || []).filter(p => p.fileId && !(p.meReportId && reportIds.has(String(p.meReportId))));
}
// Never published, whatever is ticked: security-sensitive sites.
const BLOCKED_TYPES = ['Security Facility'];

function requireGallery(req, res, next) {
  if (!GALLERY_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Only System Admins, Supervisors and Sub-Heads can change the public gallery' });
  next();
}
const auth = [authenticate, resolvePermissions];

router.get('/assets', ...auth, async (_req, res) => {
  try {
    const assets = await Asset.find({ 'publicGallery.enabled': true }, { assetId: 1, name: 1, type: 1, state: 1, publicGallery: 1, photos: 1, 'meReports._id': 1 }).lean();
    res.json({ assets: assets.map(a => ({ assetId: a.assetId, name: a.name, type: a.type, state: a.state, caption: a.publicGallery?.caption || '', photoCount: generalPhotos(a).length })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/assets/:id', ...auth, requireGallery, auditLog('GALLERY_UPDATED', 'Asset'), async (req, res) => {
  try {
    const asset = await Asset.findOne(idQuery(req.params.id), { assetId: 1, type: 1, approvalStatus: 1, photos: 1, publicGallery: 1, 'meReports._id': 1 }).lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const enabled = !!req.body?.enabled;
    if (enabled) {
      if (BLOCKED_TYPES.includes(asset.type)) return res.status(422).json({ error: `${asset.type} assets can't be shown publicly` });
      if (asset.approvalStatus && asset.approvalStatus !== 'Approved') return res.status(422).json({ error: 'Only approved assets can be shown publicly' });
      if (!generalPhotos(asset).length) return res.status(422).json({ error: 'Add at least one photo first' });
    }
    const publicGallery = {
      enabled,
      caption: req.body?.caption !== undefined ? String(req.body.caption).trim().slice(0, 300) : asset.publicGallery?.caption || '',
      updatedBy: req.user._id, updatedAt: new Date(),
    };
    // Only this field: a full save() would re-validate the whole record, and
    // older assets can hold values that no longer pass (e.g. retired types).
    await Asset.updateOne({ _id: asset._id }, { $set: { publicGallery } });
    res.locals.auditEntityId = asset.assetId;
    res.json({ publicGallery });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
module.exports.BLOCKED_TYPES = BLOCKED_TYPES;
module.exports.generalPhotos = generalPhotos;
