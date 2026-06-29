'use strict';
// ── FILE INDEX ROUTE ──────────────────────────────────────────────────────────
// Add to app.js: app.use('/api/assets/files', require('./routes/files_route'));
// OR add this route BEFORE /:id in your existing assets routes file.
//
// GET /api/assets/files?type=photo&limit=500&page=1
// Returns all files across all assets in one aggregated call.

const router = require('express').Router();
const Asset  = require('../models/Asset');
const { authenticate }       = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { scopeFilter }        = require('../middleware/scopeFilter');

const auth = [authenticate, resolvePermissions, scopeFilter];

router.get('/', ...auth, async (req, res, next) => {
  try {
    const { type, limit = 500, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Match only assets with at least one file
    const matchOr = [];
    if (!type || type === 'photo')    matchOr.push({ 'photos.0':    { $exists: true } });
    if (!type || type === 'document') matchOr.push({ 'documents.0': { $exists: true } });
    if (!type || type === 'excel')    matchOr.push({ 'xlDatasets.0':{ $exists: true } });

    const pipeline = [
      { $match: matchOr.length ? { $or: matchOr } : {} },
      { $project: { assetId:1, name:1, photos:1, documents:1, xlDatasets:1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
    ];

    const assets = await Asset.aggregate(pipeline);

    const files = [];
    assets.forEach(a => {
      (a.photos     || []).forEach(f => files.push({ ...f, _assetId: a.assetId, _assetName: a.name, _fileType: 'photo' }));
      (a.documents  || []).forEach(f => files.push({ ...f, _assetId: a.assetId, _assetName: a.name, _fileType: 'document' }));
      (a.xlDatasets || []).forEach(f => files.push({ ...f, _assetId: a.assetId, _assetName: a.name, _fileType: 'excel' }));
    });

    res.json({ files, total: files.length });
  } catch (err) { next(err); }
});

module.exports = router;
