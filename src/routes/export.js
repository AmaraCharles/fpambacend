'use strict';
const router = require('express').Router();
const { authenticate }       = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');
const { scopeFilter }        = require('../middleware/scopeFilter');
const { auditLog }           = require('../middleware/auditMiddleware');
const exportSvc = require('../services/exportService');

const auth = [authenticate, resolvePermissions, scopeFilter, requirePerm('canExportData')];

// Builds the same filter the registry list uses (assetService.listAssets), so
// "Export all" produces exactly what the user is looking at: only verified
// assets (Pending/Rejected excluded) narrowed by any filters passed through.
function buildFilter(q = {}) {
  const f = {};
  for (const key of ['type', 'condition', 'state', 'lga', 'geomType', 'status', 'mda']) {
    if (q[key]) f[key] = q[key];
  }
  if (q.assessed === 'Assessed')   f.assessed = 'Assessed';
  if (q.assessed === 'Unassessed') f.assessed = { $in: ['Unassessed', null, ''] };
  if (q.approvalStatus !== 'all')  f.approvalStatus = { $nin: ['Pending', 'Rejected'] };
  return f;
}

function runExport(fmt, res, scope, filter) {
  switch (fmt) {
    case 'csv':     return exportSvc.streamCSV(res, scope, filter);
    case 'geojson': return exportSvc.streamGeoJSON(res, scope, filter);
    case 'xlsx':    return exportSvc.streamXLSX(res, scope, filter);
    case 'pdf':     return exportSvc.streamPDF(res, scope, filter);
    case 'json':
    default:        return exportSvc.sendJSON(res, scope, filter);
  }
}

// GET /api/assets/export?format=csv|json|geojson|xlsx|pdf[&type=..&state=..&assessed=..]
router.get('/', ...auth, auditLog('EXPORT', 'System'), async (req, res, next) => {
  try {
    const fmt = (req.query.format || 'json').toLowerCase();
    await runExport(fmt, res, req.scopeFilter, buildFilter(req.query));
  } catch (err) { next(err); }
});

// Bulk export of an explicit set of assets. Accepts both assetId and the
// structured assetCode. POST is preferred — a percentage export can carry
// thousands of IDs, which overflows URL length limits on a GET.
async function bulkHandler(req, res, next) {
  try {
    const src = req.method === 'POST' ? (req.body || {}) : req.query;
    const ids = (Array.isArray(src.ids) ? src.ids : String(src.ids || '').split(','))
      .map(s => String(s).trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    const fmt = String(src.format || 'json').toLowerCase();
    const filter = { $or: [{ assetId: { $in: ids } }, { assetCode: { $in: ids } }] };
    await runExport(fmt, res, req.scopeFilter, filter);
  } catch (err) { next(err); }
}

router.get('/bulk',  ...auth, requirePerm('canBulkExport'), auditLog('BULK_EXPORT', 'System'), bulkHandler);
router.post('/bulk', ...auth, requirePerm('canBulkExport'), auditLog('BULK_EXPORT', 'System'), bulkHandler);

module.exports = router;
