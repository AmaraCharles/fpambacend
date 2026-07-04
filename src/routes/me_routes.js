'use strict';
// ── M&E REPORTS ROUTES ────────────────────────────────────────────────────────
// Mount at: app.use('/api/assets', require('./routes/me_routes'));
//
// GET    /api/assets/:id/me-reports          — list all M&E reports for asset
// POST   /api/assets/:id/me-reports          — submit a new M&E report
// PATCH  /api/assets/:id/me-reports/:rid     — update / issue clearance
// DELETE /api/assets/:id/me-reports/:rid     — delete a draft report

const router = require('express').Router({ mergeParams: true });
const Asset  = require('../models/Asset');
const { authenticate }       = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { auditLog }           = require('../middleware/auditMiddleware');

const auth = [authenticate, resolvePermissions];

function assetQuery(id) {
  // Handle both legacy AST- IDs and new FGN- format IDs
  const isObjectId = /^[a-f\d]{24}$/i.test(id);
  return isObjectId ? { _id: id } : { assetId: id };
}

// Secretariat task template
const SECRETARIAT_TASKS = [
  'General Cleaning of the Complex and its Surrounding',
  'Horticulture work',
  'Attendance to Minor Mechanical repairs in the complex',
  'Water supply in the Complex for Improved sanitation purposes',
  'Attendance to minor Electrical repairs',
  'Operation, servicing of generators and minor repairs of borehole',
  'Quarterly fumigation of the complex',
  'Removal of refuse and proper disposal in a refuse dump',
  'Provision of equipment, tools and non-hazardous chemical',
  'Minor repairs of doors and windows such as locks and hinges',
];

// NHP task template
const NHP_TASKS = [
  'General Cleaning of the Facility and its Surrounding',
  'Horticulture work',
  'Night Security',
  'Day Security',
  'Quarterly cleaning of Apartment',
  'Purchase of cleaning equipment',
  'Purchase of Security equipment',
  'Removal of refuse and proper disposal in a refuse dump',
  'Hiring of Staff',
];

// ── GET /api/assets/:id/me-reports ───────────────────────────────────────────
router.get('/:id/me-reports', ...auth, async (req, res) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id), { meReports: 1, assetId: 1, name: 1 }).lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ reports: asset.meReports || [], assetId: asset.assetId, assetName: asset.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/me-reports/templates ─────────────────────────────────────────────
// Returns task templates so frontend can build forms without hardcoding
router.get('/me-reports/templates', ...auth, (req, res) => {
  res.json({ secretariat: SECRETARIAT_TASKS, nhp: NHP_TASKS });
});

// ── POST /api/assets/:id/me-reports ──────────────────────────────────────────
router.post('/:id/me-reports', ...auth, auditLog('ME_REPORT_SUBMITTED', 'Asset'), async (req, res) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const {
      contractNo, contractorName, contractorAddress, contractSum,
      contractPeriod, commencementDate, completionPeriod, reportLocation,
      reportType, reportMonth, reportYear,
      tasks, overallPercentage,
      labourRating, materialsRating, progressRating, workmanshipRating, otherComments,
      craName, craDesignation, craDate,
      status,
    } = req.body;

    if (!reportType || !reportMonth || !reportYear) {
      return res.status(400).json({ error: 'reportType, reportMonth and reportYear are required' });
    }

    const report = {
      contractNo, contractorName, contractorAddress,
      contractSum: contractSum ? Number(contractSum) : undefined,
      contractPeriod, commencementDate, completionPeriod, reportLocation,
      reportType, reportMonth: Number(reportMonth), reportYear: Number(reportYear),
      tasks: (tasks || []).map(t => ({ label: t.label, percentage: Number(t.percentage) || 0 })),
      overallPercentage: Number(overallPercentage) || 0,
      labourRating, materialsRating, progressRating, workmanshipRating, otherComments,
      craName, craDesignation, craDate,
      status: status || 'Submitted',
      submittedBy: req.user._id,
      submittedAt: new Date(),
    };

    asset.meReports.push(report);
    await asset.save();

    const saved = asset.meReports[asset.meReports.length - 1];
    res.status(201).json({ report: saved, message: 'M&E report submitted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PATCH /api/assets/:id/me-reports/:rid ────────────────────────────────────
// Used for: editing a draft, issuing clearance, changing status
router.patch('/:id/me-reports/:rid', ...auth, auditLog('ME_REPORT_UPDATED', 'Asset'), async (req, res) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const report = asset.meReports.id(req.params.rid);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const allowed = [
      'contractNo', 'contractorName', 'contractorAddress', 'contractSum',
      'contractPeriod', 'commencementDate', 'completionPeriod', 'reportLocation',
      'reportType', 'reportMonth', 'reportYear',
      'tasks', 'overallPercentage',
      'labourRating', 'materialsRating', 'progressRating', 'workmanshipRating', 'otherComments',
      'craName', 'craDesignation', 'craDate',
      'clearanceIssued', 'clearanceDate', 'clearanceMonth',
      'satisfactory', 'unsatisfactoryWorks',
      'facilityManagerName', 'facilityManagerDesig', 'facilityManagerDate',
      'status',
    ];

    allowed.forEach(k => { if (req.body[k] !== undefined) report[k] = req.body[k]; });

    // Auto-set status when clearance is issued
    if (req.body.clearanceIssued === true) {
      report.status = req.body.satisfactory === false ? 'Not Cleared' : 'Cleared';
      report.clearanceDate = report.clearanceDate || new Date();
    }

    await asset.save();
    res.json({ report, message: 'Report updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DELETE /api/assets/:id/me-reports/:rid ───────────────────────────────────
router.delete('/:id/me-reports/:rid', ...auth, auditLog('ME_REPORT_DELETED', 'Asset'), async (req, res) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id));
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const report = asset.meReports.id(req.params.rid);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.status !== 'Draft') return res.status(400).json({ error: 'Only Draft reports can be deleted' });

    report.deleteOne();
    await asset.save();
    res.json({ message: 'Report deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;