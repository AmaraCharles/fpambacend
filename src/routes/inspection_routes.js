'use strict';
// ── INSPECTION ROUTES ─────────────────────────────────────────────────────────
// Mount at: app.use('/api/inspections', require('./routes/inspection_routes'));
// Also handles asset-scoped: app.use('/api/assets/:assetId/inspections', ...)

const router     = require('express').Router({ mergeParams: true });
const Inspection = require('../models/Inspection');
const Asset      = require('../models/Asset');
const { authenticate }              = require('../middleware/auth');
const { resolvePermissions }        = require('../middleware/resolvePermissions');
const { auditLog }                  = require('../middleware/auditMiddleware');

const auth = [authenticate, resolvePermissions];

// ── LIST ──────────────────────────────────────────────────────────────────────
// GET /api/inspections?status=&assetId=&limit=&page=
// GET /api/assets/:assetId/inspections
router.get('/', ...auth, async (req, res) => {
  try {
    const { status, assetId: qAsset, limit = 100, page = 1 } = req.query;
    const filter = {};
    // If mounted under /assets/:assetId use that, else use query param
    if (req.params.assetId) filter.assetId = req.params.assetId;
    else if (qAsset)        filter.assetId = qAsset;
    if (status)             filter.status  = status;

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Inspection.countDocuments(filter);
    const items = await Inspection.find(filter)
      .sort({ scheduledDate: 1, createdAt: -1 })
      .skip(skip).limit(parseInt(limit)).lean();

    res.json({ inspections: items, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DASHBOARD SUMMARY ─────────────────────────────────────────────────────────
// GET /api/inspections/summary
router.get('/summary', ...auth, async (req, res) => {
  try {
    const today = new Date();
    const in7d  = new Date(today.getTime() + 7 * 86400000);
    const [total, overdue, pending, approved, upcoming] = await Promise.all([
      Inspection.countDocuments({}),
      Inspection.countDocuments({ scheduledDate: { $lt: today }, status: { $nin: ['Submitted','Approved','Rejected'] } }),
      Inspection.countDocuments({ status: 'Submitted' }),
      Inspection.countDocuments({ status: 'Approved' }),
      Inspection.countDocuments({ scheduledDate: { $gte: today, $lte: in7d }, status: { $nin: ['Approved','Rejected'] } }),
    ]);
    res.json({ total, overdue, pending, approved, upcoming });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CREATE ────────────────────────────────────────────────────────────────────
// POST /api/inspections   or   POST /api/assets/:assetId/inspections
router.post('/', ...auth, auditLog('INSPECTION_SCHEDULED', 'Inspection'), async (req, res) => {
  try {
    const assetId = req.params.assetId || req.body.assetId;
    if (!assetId) return res.status(400).json({ error: 'assetId required' });

    // Resolve asset name
    const assetQuery = (assetId.startsWith('AST-') || assetId.startsWith('FGN-')) ? { assetId } : { _id: assetId };
    const asset = await Asset.findOne(assetQuery, { name: 1, assetId: 1 }).lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const insp = new Inspection({
      assetId:       asset.assetId,
      assetName:     asset.name,
      type:          req.body.type          || 'Routine',
      scheduledDate: req.body.scheduledDate,
      assignedTo:    req.body.assignedTo    || null,
      notes:         req.body.notes         || '',
      status:        req.body.assignedTo    ? 'Assigned' : 'Scheduled',
      createdBy:     req.user?.name         || req.user?.email || 'System',
      history: [{
        status: req.body.assignedTo ? 'Assigned' : 'Scheduled',
        at:     new Date(),
        by:     req.user?.name || 'System',
      }],
    });
    await insp.save();

    // Update nextInspection on asset
    await Asset.updateOne(assetQuery, { $set: { nextInspection: req.body.scheduledDate } });

    res.status(201).json({ inspection: insp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET ONE ───────────────────────────────────────────────────────────────────
router.get('/:id', ...auth, async (req, res) => {
  try {
    const insp = await Inspection.findOne({
      $or: [{ _id: req.params.id }, { inspectionId: req.params.id }]
    }).lean();
    if (!insp) return res.status(404).json({ error: 'Not found' });
    res.json({ inspection: insp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── UPDATE STATUS ─────────────────────────────────────────────────────────────
// PUT /api/inspections/:id  — general update (assign, progress, etc.)
router.put('/:id', ...auth, async (req, res) => {
  try {
    const insp = await Inspection.findOne({
      $or: [{ _id: req.params.id }, { inspectionId: req.params.id }]
    });
    if (!insp) return res.status(404).json({ error: 'Not found' });

    const { status, assignedTo, notes, scheduledDate } = req.body;
    if (status)        insp.status        = status;
    if (assignedTo)    insp.assignedTo    = assignedTo;
    if (notes)         insp.notes         = notes;
    if (scheduledDate) insp.scheduledDate = scheduledDate;

    if (status) {
      insp.history.push({ status, at: new Date(), by: req.user?.name || 'System' });
    }
    await insp.save();
    res.json({ inspection: insp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SUBMIT REPORT ─────────────────────────────────────────────────────────────
// POST /api/inspections/:id/submit
router.post('/:id/submit', ...auth, auditLog('INSPECTION_SUBMITTED', 'Inspection'), async (req, res) => {
  try {
    const insp = await Inspection.findOne({
      $or: [{ _id: req.params.id }, { inspectionId: req.params.id }]
    });
    if (!insp) return res.status(404).json({ error: 'Not found' });

    const { condition, date, findings, recommendations } = req.body;
    if (!condition || !findings) return res.status(400).json({ error: 'condition and findings required' });

    insp.status = 'Submitted';
    insp.report = { condition, date, findings, recommendations, submittedAt: new Date(), submittedBy: req.user?.name || 'Agent' };
    insp.history.push({ status: 'Submitted', at: new Date(), by: req.user?.name || 'Agent' });
    await insp.save();
    res.json({ inspection: insp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── APPROVE ───────────────────────────────────────────────────────────────────
// POST /api/inspections/:id/approve
router.post('/:id/approve', ...auth, auditLog('INSPECTION_APPROVED', 'Inspection'), async (req, res) => {
  try {
    const insp = await Inspection.findOne({
      $or: [{ _id: req.params.id }, { inspectionId: req.params.id }]
    });
    if (!insp) return res.status(404).json({ error: 'Not found' });
    if (insp.status !== 'Submitted') return res.status(400).json({ error: 'Can only approve Submitted inspections' });

    insp.status     = 'Approved';
    insp.reviewedAt = new Date();
    insp.reviewedBy = req.user?.name || 'Supervisor';
    insp.history.push({ status: 'Approved', at: new Date(), by: req.user?.name || 'Supervisor' });
    await insp.save();

    // Update asset condition + lastInspection
    if (insp.report?.condition) {
      const assetQuery = { assetId: insp.assetId };
      const asset = await Asset.findOne(assetQuery);
      if (asset) {
        const prevCondition = asset.condition;
        asset.condition      = insp.report.condition;
        asset.lastInspection = insp.report.date || new Date();
        asset.assessed       = 'Assessed';
        if (prevCondition !== insp.report.condition) {
          asset.conditionHistory.push({
            from:      prevCondition,
            to:        insp.report.condition,
            changedAt: new Date(),
            changedBy: req.user?._id,
          });
        }
        if (insp.report.recommendations) {
          asset.notes = (asset.notes ? asset.notes + '\n' : '') + `[Inspection ${insp.inspectionId}] ${insp.report.recommendations}`;
        }
        await asset.save();
      }
    }

    res.json({ inspection: insp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REJECT ────────────────────────────────────────────────────────────────────
// POST /api/inspections/:id/reject
router.post('/:id/reject', ...auth, auditLog('INSPECTION_REJECTED', 'Inspection'), async (req, res) => {
  try {
    const insp = await Inspection.findOne({
      $or: [{ _id: req.params.id }, { inspectionId: req.params.id }]
    });
    if (!insp) return res.status(404).json({ error: 'Not found' });

    insp.status          = 'Rejected';
    insp.rejectionReason = req.body.reason || '';
    insp.reviewedAt      = new Date();
    insp.reviewedBy      = req.user?.name || 'Supervisor';
    insp.history.push({ status: 'Rejected', at: new Date(), by: req.user?.name || 'Supervisor', note: req.body.reason });
    await insp.save();
    res.json({ inspection: insp });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE ────────────────────────────────────────────────────────────────────
router.delete('/:id', ...auth, async (req, res) => {
  try {
    await Inspection.deleteOne({ $or: [{ _id: req.params.id }, { inspectionId: req.params.id }] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;