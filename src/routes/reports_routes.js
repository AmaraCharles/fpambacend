'use strict';
// ── PUBLIC REPORTS QUEUE (staff and MDA Agents) ───────────────────────────────
// Mount at: app.use('/api/reports', require('./routes/reports_routes'));
//
// GET   /api/reports        — list (MDA Agents see only their MDA's), ?status=&assetId=
// PATCH /api/reports/:id    — change status with an optional note

const router = require('express').Router();
const PublicReport = require('../models/PublicReport');
const { authenticate } = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { auditLog } = require('../middleware/auditMiddleware');

const auth = [authenticate, resolvePermissions];
const HANDLER_ROLES = ['System Admin', 'Supervisor', 'Sub-Head', 'GIS Analyst'];

/** Which reports this user may see: MDA Agents only their own MDA's. */
function scope(user) {
  if (user.role === 'MDA Agent') return { mda: user.mda || '__none__' };
  return {};
}
/** Who can change a report's status. */
function canHandle(user, report) {
  if (user.role === 'MDA Agent') return !!user.mda && user.mda === report.mda;
  return HANDLER_ROLES.includes(user.role) || ['All', 'Building Training & Maintenance'].includes(user.division);
}

router.get('/', ...auth, async (req, res) => {
  try {
    const base = scope(req.user);
    const q = { ...base };
    if (req.query.status) q.status = String(req.query.status);
    if (req.query.assetId) q.assetId = String(req.query.assetId);
    const [reports, counts] = await Promise.all([
      PublicReport.find(q).sort({ createdAt: -1 }).limit(500).lean(),
      PublicReport.aggregate([{ $match: base }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    res.json({
      reports,
      counts: Object.fromEntries(counts.map(c => [c._id, c.n])),
      canHandle: req.user.role === 'MDA Agent' ? !!req.user.mda : canHandle(req.user, {}),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', ...auth, auditLog('PUBLIC_REPORT_UPDATED', 'PublicReport'), async (req, res) => {
  try {
    const report = await PublicReport.findOne({ _id: req.params.id, ...scope(req.user) }).catch(() => null);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (!canHandle(req.user, report)) return res.status(403).json({ error: 'You cannot update this report' });
    const status = req.body?.status;
    const note = String(req.body?.note || '').trim().slice(0, 1000);
    if (!PublicReport.STATUSES.includes(status)) return res.status(422).json({ error: 'Unknown status' });
    if (['Resolved', 'Dismissed'].includes(status) && !note) return res.status(422).json({ error: 'Add a note saying what was done' });
    report.status = status;
    report.history.push({ status, note, by: req.user.name || req.user.email });
    await report.save();
    res.locals.auditEntityId = report.ref;
    res.json({ report });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
