'use strict';
// ── ASSET EXTRAS: Relationships + Lifecycle + Bulk Update ─────────────────────
// Mount at: app.use('/api/assets', require('./routes/asset_extras_routes'));
// These are additional routes that extend the existing asset router.

const router = require('express').Router({ mergeParams: true });
const Asset          = require('../models/Asset');
const AssetCodeIndex = require('../utils/assetCodeIndex');
const assetService   = require('../services/assetService');
const { authenticate }       = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');
const { auditLog }           = require('../middleware/auditMiddleware');

const auth = [authenticate, resolvePermissions];

// ── HELPER ────────────────────────────────────────────────────────────────────
function assetQuery(id) {
  const isObjectId = /^[a-f\d]{24}$/i.test(id);
  if (isObjectId) return { _id: id };
  // Match on either the legacy/sequential assetId (AST-.../FGN-...) or the
  // structured assetCode (FGN-{MDA}-{TYPE}-{BRANCH}-{YEAR}-{SEQ}) — callers
  // throughout the frontend aren't all guaranteed to pass the same one of
  // these two identifiers, and a lookup that only checks assetId silently
  // 404s ("Asset not found") for anything that's actually an assetCode.
  return { $or: [{ assetId: id }, { assetCode: id }] };
}

// Every asset created before the assetCode schema fix (v2, 2026) — or any
// legacy asset that predates the coding system entirely — may not have an
// assetCode yet. Rather than block child-linking on a manual migration run,
// self-heal it here: generate and persist one on the spot the first time
// it's needed. Cheap (one countDocuments) and idempotent.
//
// Also self-heals a SECOND gap: an asset can already have a code that's
// technically present but the wrong (older, pre-name-abbreviation) SHAPE —
// e.g. still v2 (FGN-MDA-TYPE-BRANCH-YEAR-SEQ) because it was never actually
// run through the migration script. Blindly trusting "it has some code" and
// building a child code on top of it would permanently bake the stale shape
// into every child. Upgrading it in place here, preserving mda/type/branch/
// year/seq exactly, means linking always builds on the CURRENT format
// regardless of whether the migration script has been run yet.
async function ensureAssetCode(asset) {
  if (asset.assetCode) {
    const parsed = AssetCodeIndex.parseAssetCode(asset.assetCode);
    if (parsed?.version === 3) return asset.assetCode;
    if (parsed?.version === 2) {
      const nameCode = AssetCodeIndex.nameToAbbr(asset.name);
      const upgraded = `FGN-${parsed.mdaCode}-${parsed.typeCode}-${nameCode}-${parsed.branchCode}-${parsed.year}-${AssetCodeIndex.formatSeq(parsed.seq)}`;
      asset.assetCode = upgraded;
      await asset.save({ validateBeforeSave: false });
      return upgraded;
    }
    // Unparseable shape (shouldn't normally happen) — don't silently
    // overwrite something we can't confidently interpret.
    return asset.assetCode;
  }
  const code = await assetService.generateAssetCode({
    mda: asset.mda, type: asset.type, name: asset.name, state: asset.state, captureDate: asset.captureDate,
  });
  asset.assetCode = code;
  await asset.save({ validateBeforeSave: false });
  return code;
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
// Body: { childId }  — links childId as a child of :id, and stamps the
// child with a {parentCode}-C{seq} code (see utils/assetCodeIndex.js).
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
    if (AssetCodeIndex.isChildCode(parent.assetCode)) {
      return res.status(400).json({ error: 'Parent asset is itself a child asset — one level of nesting only' });
    }

    // Add child to parent's childIds (deduplicate)
    if (!parent.childIds.includes(child.assetId)) {
      parent.childIds.push(child.assetId);
      // validateBeforeSave:false — legacy assets frequently lack fields the
      // schema marks required (location, type, etc.); linking shouldn't
      // fail because of unrelated missing data on an otherwise-valid asset.
      await parent.save({ validateBeforeSave: false });
    }

    // Ensure the parent has a base code to build the child's code from —
    // self-heals assets created before the assetCode schema fix.
    const parentCode = await ensureAssetCode(parent);

    // Sequence resets per parent and is never reused (mirrors the base
    // FGN-...-{SEQ} rule) — so derive the next C-number from the highest
    // C-seq already in use among this parent's *current* children, not a
    // plain count, in case an earlier child was unlinked.
    const siblings = parent.childIds.length
      ? await Asset.find({ assetId: { $in: parent.childIds } }, { assetCode: 1 }).lean()
      : [];
    const maxSeq = siblings.reduce((max, s) => {
      const parsed = AssetCodeIndex.parseChildCode(s.assetCode);
      return parsed && parsed.parentCode === parentCode ? Math.max(max, parsed.seq) : max;
    }, 0);

    child.parentId  = parent.assetId;
    child.assetCode = AssetCodeIndex.buildChildCode({ parentCode, seq: maxSeq + 1, childName: child.name });
    await child.save({ validateBeforeSave: false });

    res.json({ ok: true, parentId: parent.assetId, childId: child.assetId, childCode: child.assetCode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/assets/:id/relationships/unlink
// Body: { childId }
router.delete('/:id/relationships/unlink', ...auth, auditLog('ASSET_UNLINKED', 'Asset'), async (req, res) => {
  try {
    const { childId } = req.body;
    if (!childId) return res.status(400).json({ error: 'childId required' });

    const child = await Asset.findOne(assetQuery(childId));
    if (!child) return res.status(404).json({ error: 'Child asset not found' });

    await Asset.updateOne(assetQuery(req.params.id), { $pull: { childIds: childId } });

    // A freed child is no longer a component of anything, so it gets its
    // own independent base code rather than keeping a dangling -Cxx tail
    // that points at a relationship which no longer exists. The retired
    // C-number itself is never reissued to a future sibling (see link
    // handler above).
    child.parentId  = null;
    child.assetCode = await assetService.generateAssetCode({
      mda: child.mda, type: child.type, name: child.name, state: child.state, captureDate: child.captureDate,
    });
    await child.save({ validateBeforeSave: false });

    res.json({ ok: true, newChildCode: child.assetCode });
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

    await asset.save({ validateBeforeSave: false });
    res.json({ stage, history: asset.lifecycleHistory, status: asset.status });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BULK UPDATE (match-and-update via JSON array)
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/assets/bulk-update
// Body: { updates: [{ assetId, condition, notes, status, sector, captureDate, assessed }] }
router.post('/bulk-update', ...auth, requirePerm('canEditAssets'), auditLog('BULK_UPDATE', 'Asset'), async (req, res) => {
  try {
    const { updates } = req.body;
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ error: 'updates array required' });
    }

    const VALID_CONDITIONS = ['Good', 'Fair', 'Poor', 'Critical', null, ''];
    // Pull the allowed values straight from the schema so this never drifts.
    const enumOf = path => Asset.schema.path(path)?.enumValues || [];
    const VALID_STATUS   = enumOf('status');
    const VALID_SECTOR   = enumOf('sector');
    const VALID_ASSESSED = enumOf('assessed');
    const results = { updated: 0, failed: 0, errors: [] };

    for (const row of updates) {
      try {
        const { assetId, condition, notes, status, sector, captureDate, assessed, previousCondition } = row;
        if (!assetId) { results.failed++; results.errors.push({ assetId, error: 'missing assetId' }); continue; }
        if (condition !== undefined && !VALID_CONDITIONS.includes(condition)) {
          results.failed++; results.errors.push({ assetId, error: `invalid condition: ${condition}` }); continue;
        }
        if (status   && !VALID_STATUS.includes(status))     { results.failed++; results.errors.push({ assetId, error: `invalid status: ${status}` });     continue; }
        if (sector   && !VALID_SECTOR.includes(sector))     { results.failed++; results.errors.push({ assetId, error: `invalid sector: ${sector}` });     continue; }
        if (assessed && !VALID_ASSESSED.includes(assessed)) { results.failed++; results.errors.push({ assetId, error: `invalid assessed: ${assessed}` }); continue; }

        const asset = await Asset.findOne(assetQuery(assetId));
        if (!asset) { results.failed++; results.errors.push({ assetId, error: 'not found' }); continue; }

        const update = {};
        // Blank condition means "leave unchanged", not "clear it".
        if (condition)               update.condition = condition;
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
        await asset.save({ validateBeforeSave: false });
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