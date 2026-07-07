'use strict';
// ── ASSET EXTRAS: Relationships + Lifecycle + Bulk Update ─────────────────────
// Mount at: app.use('/api/assets', require('./routes/asset_extras_routes'));
// These are additional routes that extend the existing asset router.

const router = require('express').Router({ mergeParams: true });
const Asset  = require('../models/Asset');
const { authenticate }       = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { auditLog }           = require('../middleware/auditMiddleware');

const auth = [authenticate, resolvePermissions];

// ── HELPER ────────────────────────────────────────────────────────────────────
function assetQuery(id) {
  const isObjectId = /^[a-f\d]{24}$/i.test(id);
  return isObjectId ? { _id: id } : { assetId: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// RELATIONSHIPS
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/assets/:id/relationships
// Returns parent + children of an asset
router.get('/:id/relationships', ...auth, async (req, res) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id), { parentId: 1, childIds: 1, assetId: 1 }).lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const childIds  = asset.childIds || [];
    const parentId  = asset.parentId || null;

    // Fetch parent and children in parallel
    const [parent, children] = await Promise.all([
      parentId ? Asset.findOne(assetQuery(parentId), { assetId:1, name:1, type:1, condition:1, status:1, mda:1 }).lean() : null,
      childIds.length ? Asset.find({ assetId: { $in: childIds } }, { assetId:1, name:1, type:1, condition:1, status:1, mda:1, valuation:1 }).lean() : [],
    ]);

    res.json({ parentId, parent, childIds, children });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/assets/:id/relationships/link
// Body: { childId }  — links childId as a child of :id
router.post('/:id/relationships/link', ...auth, auditLog('ASSET_LINKED', 'Asset'), async (req, res) => {
  try {
    const { childId } = req.body;
    if (!childId) return res.status(400).json({ error: 'childId required' });

    const [parent, child] = await Promise.all([
      Asset.findOne(assetQuery(req.params.id)),
      Asset.findOne(assetQuery(childId)),
    ]);
    if (!parent) return res.status(404).json({ error: 'Parent asset not found' });
    if (!child)  return res.status(404).json({ error: 'Child asset not found' });
    if (parent.assetId === child.assetId) return res.status(400).json({ error: 'Cannot link asset to itself' });

    // Add child to parent's childIds (deduplicate)
    if (!parent.childIds.includes(child.assetId)) {
      parent.childIds.push(child.assetId);
      await parent.save();
    }
    // Set parent on child
    child.parentId = parent.assetId;
    await child.save();

    res.json({ ok: true, parentId: parent.assetId, childId: child.assetId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/assets/:id/relationships/unlink
// Body: { childId }
router.delete('/:id/relationships/unlink', ...auth, auditLog('ASSET_UNLINKED', 'Asset'), async (req, res) => {
  try {
    const { childId } = req.body;
    if (!childId) return res.status(400).json({ error: 'childId required' });

    await Promise.all([
      Asset.updateOne(assetQuery(req.params.id), { $pull: { childIds: childId } }),
      Asset.updateOne(assetQuery(childId), { $set: { parentId: null } }),
    ]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════════

const LC_TRANSITIONS = {
  Draft:                    ['Active'],
  Active:                   ['Under Review', 'Under Maintenance'],
  'Under Maintenance':      ['Active'],
  'Under Review':           ['Active', 'Scheduled for Disposal'],
  'Scheduled for Disposal': ['Decommissioned', 'Active'],
  Decommissioned:           [],
};

// GET /api/assets/:id/lifecycle
router.get('/:id/lifecycle', ...auth, async (req, res) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id),
      { lifecycleStage:1, lifecycleHistory:1, lifecycleDocs:1, assetId:1 }).lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const stage   = asset.lifecycleStage || 'Active';
    const allowed = LC_TRANSITIONS[stage] || [];
    res.json({
      stage,
      history:  asset.lifecycleHistory || [],
      documents:asset.lifecycleDocs    || [],
      allowedTransitions: allowed,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/assets/:id/lifecycle/transition
// Body: { stage, note, document }
router.post('/:id/lifecycle/transition', ...auth, auditLog('LIFECYCLE_TRANSITION', 'Asset'), async (req, res) => {
  try {
    const { stage, note, document: docName } = req.body;
    if (!stage) return res.status(400).json({ error: 'stage required' });

    const asset = await Asset.findOne(assetQuery(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const current = asset.lifecycleStage || 'Active';
    const allowed = LC_TRANSITIONS[current] || [];
    if (!allowed.includes(stage)) {
      return res.status(400).json({ error: `Cannot transition from "${current}" to "${stage}". Allowed: ${allowed.join(', ')}` });
    }

    const histEntry = { from: current, to: stage, at: new Date(), by: req.user?.name || 'System', note: note||'', document: docName||null };
    asset.lifecycleStage = stage;
    asset.lifecycleHistory.push(histEntry);

    if (docName) {
      asset.lifecycleDocs = asset.lifecycleDocs || [];
      asset.lifecycleDocs.push({ name: docName, stage, at: new Date() });
    }

    // Sync status field
    const statusMap = {
      Draft: 'Active', Active: 'Active',
      'Under Maintenance': 'Under Maintenance',
      'Under Review': 'Under Maintenance',
      'Scheduled for Disposal': 'Disputed',
      Decommissioned: 'Decommissioned',
    };
    asset.status = statusMap[stage] || asset.status;

    await asset.save();
    res.json({ stage, history: asset.lifecycleHistory, status: asset.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BULK UPDATE (match-and-update via JSON array)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/assets/bulk-update
// Body: { updates: [{ assetId, condition, notes, status, sector, captureDate, assessed }] }
router.post('/bulk-update', ...auth, auditLog('BULK_UPDATE', 'Asset'), async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ error: 'updates array required' });
    }

    const VALID_CONDITIONS = ['Good', 'Fair', 'Poor', 'Critical', null, ''];
    const results = { updated: 0, failed: 0, errors: [] };

    for (const row of updates) {
      try {
        const { assetId, condition, notes, status, sector, captureDate, assessed, previousCondition } = row;
        if (!assetId) { results.failed++; results.errors.push({ assetId, error: 'missing assetId' }); continue; }
        if (condition !== undefined && !VALID_CONDITIONS.includes(condition)) {
          results.failed++; results.errors.push({ assetId, error: `invalid condition: ${condition}` }); continue;
        }

        const asset = await Asset.findOne(assetQuery(assetId));
        if (!asset) { results.failed++; results.errors.push({ assetId, error: 'not found' }); continue; }

        const update = {};
        if (condition !== undefined) update.condition = condition || null;
        if (notes)                   update.notes     = notes;
        if (status)                  update.status    = status;
        if (sector)                  update.sector    = sector;
        if (captureDate)             update.captureDate = captureDate;
        if (assessed)                update.assessed  = assessed;

        // Record condition history if changed
        if (condition && condition !== asset.condition) {
          asset.conditionHistory.push({
            from:      asset.condition,
            to:        condition,
            changedAt: new Date(),
            changedBy: req.user?._id,
          });
        }

        Object.assign(asset, update);
        await asset.save();
        results.updated++;
      } catch (e) {
        results.failed++;
        results.errors.push({ assetId: row.assetId, error: e.message });
      }
    }

    res.json({ ok: true, ...results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// DATA COMPLETENESS SUMMARY (server-side)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/assets/completeness
router.get('/completeness', ...auth, async (req, res) => {
  try {
    const total = await Asset.countDocuments({});
    const [
      withCoords, withCondition, withSector, withMda, withState,
      withAddress, withPhotos, withValuation, withDate, assessed,
    ] = await Promise.all([
      Asset.countDocuments({ 'location.coordinates.0': { $exists: true } }),
      Asset.countDocuments({ condition: { $exists: true, $ne: null } }),
      Asset.countDocuments({ sector: { $exists: true, $ne: '' } }),
      Asset.countDocuments({ mda: { $exists: true, $ne: '' } }),
      Asset.countDocuments({ state: { $exists: true, $ne: '' } }),
      Asset.countDocuments({ address: { $exists: true, $ne: '' } }),
      Asset.countDocuments({ 'photos.0': { $exists: true } }),
      Asset.countDocuments({ 'valuation.amount': { $exists: true } }),
      Asset.countDocuments({ captureDate: { $exists: true } }),
      Asset.countDocuments({ assessed: 'Assessed' }),
    ]);

    const fields = [
      { key:'location',    label:'GPS Coordinates', filled: withCoords },
      { key:'condition',   label:'Condition',        filled: withCondition },
      { key:'sector',      label:'Sector',           filled: withSector },
      { key:'mda',         label:'MDA / Agency',     filled: withMda },
      { key:'state',       label:'State',            filled: withState },
      { key:'address',     label:'Address',          filled: withAddress },
      { key:'photos',      label:'Photos',           filled: withPhotos },
      { key:'valuation',   label:'Valuation',        filled: withValuation },
      { key:'captureDate', label:'Capture Date',     filled: withDate },
      { key:'assessed',    label:'Assessed',         filled: assessed },
    ].map(f => ({ ...f, total, pct: total ? Math.round(f.filled / total * 100) : 0 }));

    const overall = Math.round(fields.reduce((s, f) => s + f.pct, 0) / fields.length);

    // Per-MDA breakdown
    const mdaStats = await Asset.aggregate([
      { $group: {
        _id: { $ifNull: ['$mda', 'Unassigned'] },
        count:      { $sum: 1 },
        withCoords: { $sum: { $cond: [{ $gt: [{ $size: { $ifNull: ['$location.coordinates', []] } }, 0] }, 1, 0] } },
        withCond:   { $sum: { $cond: [{ $ne: ['$condition', null] }, 1, 0] } },
        withSector: { $sum: { $cond: [{ $ne: ['$sector', ''] }, 1, 0] } },
      }},
      { $sort: { count: -1 } },
    ]);

    res.json({ total, overall, fields, byMda: mdaStats });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;

// ── HEALTH-EXTRAS ─────────────────────────────────────────────────────────────
// GET /api/health-extras
// Used by api_additions.js to auto-detect which new routes are registered.
// No auth required — just signals capability.
router.get('/health-extras', (req, res) => {
  res.json({
    relationships: true,
    lifecycle:     true,
    bulkUpdate:    true,
    completeness:  true,
    inspections:   false, // inspection_routes.js is mounted separately
  });
});