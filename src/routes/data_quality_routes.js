'use strict';
// Data-quality clean-up: find assets with data problems, fix bad spellings in
// bulk, assign the rest to people, and mark fixes verified.
//   GET  /api/data-quality/summary             — counts per issue type + the bad state/MDA spellings
//   GET  /api/data-quality/issues?type=&mine=1 — assets with one issue type (paged)
//   POST /api/data-quality/fix-state {from,to} — rename a state spelling on every asset
//   POST /api/data-quality/fix-mda   {from,to} — rename an MDA spelling on every asset
//   POST /api/data-quality/assign    {assetIds,userId,note}
//   POST /api/data-quality/verify    {assetIds}
//   GET  /api/data-quality/assignees     — staff who can be assigned fixes
const router = require('express').Router();
const { Types } = require('mongoose');
const Asset = require('../models/Asset');
const Mda = require('../models/Mda');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { authenticate, requireRole } = require('../middleware/auth');
const { NIGERIA_STATES, normalizeState } = require('../utils/states');
const notify = require('../services/notify');

const MANAGERS = ['System Admin', 'Supervisor', 'Sub-Head', 'GIS Analyst'];
const FIXERS = ['System Admin', 'Supervisor'];
router.use(authenticate);

const ISSUE_TYPES = {
  invalid_state: 'State missing or not a recognised state',
  unknown_mda: 'MDA missing or not in the MDA list',
  missing_gps: 'No GPS coordinates',
  no_photos: 'No photos',
  no_condition: 'Condition not recorded',
  overdue_inspection: 'Inspection overdue',
  unassessed: 'Not yet assessed',
};

async function knownMdaKeys() {
  const mdas = await Mda.find({}, { name: 1, shortName: 1 }).lean();
  return new Set(mdas.flatMap(m => [m.name, m.shortName]).filter(Boolean).map(s => s.trim().toLowerCase()));
}
async function unknownMdaValues() {
  const [values, known] = await Promise.all([Asset.distinct('mda'), knownMdaKeys()]);
  return values.filter(v => v && !known.has(String(v).trim().toLowerCase()));
}

/** Mongo filter for one issue type. */
async function issueFilter(type) {
  switch (type) {
    case 'invalid_state': return { $or: [{ state: { $nin: NIGERIA_STATES } }, { state: { $exists: false } }] };
    case 'unknown_mda': return { $or: [{ mda: { $in: [...await unknownMdaValues(), '', null] } }, { mda: { $exists: false } }] };
    case 'missing_gps': return { $or: [{ 'location.coordinates': { $exists: false } }, { 'location.coordinates': [] }, { 'location.coordinates': [0, 0] }] };
    case 'no_photos': return { $or: [{ photos: { $exists: false } }, { photos: { $size: 0 } }] };
    case 'no_condition': return { $or: [{ condition: { $exists: false } }, { condition: null }, { condition: '' }] };
    case 'overdue_inspection': return { nextInspection: { $lt: new Date() } };
    case 'unassessed': return { assessed: { $ne: 'Assessed' } };
    default: return null;
  }
}

router.get('/summary', requireRole(...MANAGERS), async (_req, res, next) => {
  try {
    const counts = {};
    for (const type of Object.keys(ISSUE_TYPES)) counts[type] = await Asset.countDocuments(await issueFilter(type));
    const badStates = await Asset.aggregate([
      { $match: await issueFilter('invalid_state') },
      { $group: { _id: '$state', n: { $sum: 1 } } }, { $sort: { n: -1 } },
    ]);
    const unknown = await unknownMdaValues();
    const badMdas = unknown.length ? await Asset.aggregate([
      { $match: { mda: { $in: unknown } } }, { $group: { _id: '$mda', n: { $sum: 1 } } }, { $sort: { n: -1 } },
    ]) : [];
    const [assigned, verified] = await Promise.all([
      Asset.countDocuments({ 'dataQuality.assignedTo': { $ne: null }, 'dataQuality.verifiedAt': null }),
      Asset.countDocuments({ 'dataQuality.verifiedAt': { $ne: null } }),
    ]);
    res.json({
      total: await Asset.estimatedDocumentCount(),
      issues: Object.entries(ISSUE_TYPES).map(([type, label]) => ({ type, label, count: counts[type] })),
      badStates: badStates.map(s => ({ value: s._id ?? '', count: s.n, suggestion: normalizeState(s._id) || null })),
      badMdas: badMdas.map(m => ({ value: m._id, count: m.n })),
      workflow: { assignedOpen: assigned, verified },
      states: NIGERIA_STATES,
    });
  } catch (err) { next(err); }
});

router.get('/issues', async (req, res, next) => {
  try {
    const mine = req.query.mine === '1' || !MANAGERS.includes(req.user.role);
    const q = {};
    if (req.query.type) {
      const f = await issueFilter(req.query.type);
      if (!f) return res.status(400).json({ error: 'Unknown issue type' });
      Object.assign(q, f);
    }
    if (mine) Object.assign(q, { 'dataQuality.assignedTo': req.user._id, 'dataQuality.verifiedAt': null });
    if (req.query.value !== undefined && (req.query.type === 'invalid_state' || req.query.type === 'unknown_mda')) {
      q[req.query.type === 'invalid_state' ? 'state' : 'mda'] = req.query.value || { $in: ['', null] };
      delete q.$or;
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const [assets, total] = await Promise.all([
      Asset.find(q, { assetId: 1, assetCode: 1, name: 1, type: 1, state: 1, mda: 1, condition: 1, nextInspection: 1, dataQuality: 1, 'location.coordinates': 1 })
        .sort({ name: 1 }).skip((page - 1) * limit).limit(limit)
        .populate('dataQuality.assignedTo', 'name').populate('dataQuality.verifiedBy', 'name').lean(),
      Asset.countDocuments(q),
    ]);
    res.json({ assets, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) { next(err); }
});

const dupKeyOf = (name, state, mda) => [name, state, mda].map(s => String(s).trim().toLowerCase()).join('|');

/**
 * Rename `from` → `to` in one field on every asset. Recomputes dupKey (the
 * model hook doesn't run on bulk writes) and skips assets that would collide
 * with an existing asset of the same name/state/MDA.
 */
async function bulkRename(field, from, to, user, ip) {
  const docs = await Asset.find({ [field]: from === '' ? { $in: ['', null] } : from }, { name: 1, state: 1, mda: 1, parentId: 1, assetId: 1 }).lean();
  const ops = [], skipped = [], planned = new Set();
  for (const a of docs) {
    const next = { state: a.state, mda: a.mda, [field]: to };
    const key = !a.parentId && a.name && next.state && next.mda ? dupKeyOf(a.name, next.state, next.mda) : null;
    if (key && (planned.has(key) || await Asset.exists({ dupKey: key, _id: { $ne: a._id } }))) { skipped.push(a.assetId); continue; }
    if (key) planned.add(key);
    ops.push({ updateOne: { filter: { _id: a._id }, update: { $set: { [field]: to, dupKey: key } } } });
  }
  const r = ops.length ? await Asset.bulkWrite(ops, { ordered: false }) : { modifiedCount: 0 };
  AuditLog.create({ action: 'BULK_UPDATE', entityType: 'System', entityId: `data-quality-${field}`, performedBy: user._id, ipAddress: ip,
    detail: `${field} "${from}" → "${to}" on ${r.modifiedCount} asset(s)${skipped.length ? `; ${skipped.length} skipped as duplicates` : ''}`,
    metadata: { skipped } }).catch(() => {});
  return { updated: r.modifiedCount, skipped };
}

router.post('/fix-state', requireRole(...FIXERS), async (req, res, next) => {
  try {
    const { from = '', to } = req.body || {};
    const canonical = normalizeState(to);
    if (!canonical) return res.status(422).json({ error: 'Choose a valid state to change to' });
    res.json(await bulkRename('state', String(from), canonical, req.user, req.ip));
  } catch (err) { next(err); }
});

router.post('/fix-mda', requireRole(...FIXERS), async (req, res, next) => {
  try {
    const { from = '', to } = req.body || {};
    const mda = await Mda.findOne({ name: String(to || '') }).lean();
    if (!mda) return res.status(422).json({ error: 'Choose an MDA from the MDA list (add it in Settings first if it is missing)' });
    res.json(await bulkRename('mda', String(from), mda.name, req.user, req.ip));
  } catch (err) { next(err); }
});

// Staff who can be given fixes (the user list itself is System Admin-only).
router.get('/assignees', requireRole(...MANAGERS), async (_req, res, next) => {
  try {
    const users = await User.find({ isActive: true, role: { $ne: 'MDA Agent' } }, { name: 1, role: 1, division: 1 }).sort({ name: 1 }).lean();
    res.json({ users });
  } catch (err) { next(err); }
});

const ids = list => (Array.isArray(list) ? list : []).map(String).slice(0, 500);

router.post('/assign', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const { assetIds, userId, note } = req.body || {};
    if (!Types.ObjectId.isValid(userId)) return res.status(422).json({ error: 'Choose who should fix these' });
    const assignee = await User.findOne({ _id: userId, isActive: true }, { name: 1 }).lean();
    if (!assignee) return res.status(422).json({ error: 'That user is not active' });
    const list = ids(assetIds);
    if (!list.length) return res.status(422).json({ error: 'Select at least one asset' });
    const assets = await Asset.find({ assetId: { $in: list } }, { assetId: 1, name: 1 }).lean();
    await Asset.updateMany({ assetId: { $in: list } }, { $set: {
      'dataQuality.assignedTo': assignee._id, 'dataQuality.assignedBy': req.user._id, 'dataQuality.assignedAt': new Date(),
      'dataQuality.note': String(note || '').slice(0, 500), 'dataQuality.verifiedBy': null, 'dataQuality.verifiedAt': null,
    } });
    notify.dataQualityAssigned(assignee._id, assets, req.user, note);
    AuditLog.create({ action: 'BULK_UPDATE', entityType: 'System', entityId: 'data-quality-assign', performedBy: req.user._id, ipAddress: req.ip,
      detail: `${assets.length} asset(s) assigned to ${assignee.name} for data fixes` }).catch(() => {});
    res.json({ assigned: assets.length });
  } catch (err) { next(err); }
});

router.post('/verify', requireRole(...MANAGERS), async (req, res, next) => {
  try {
    const list = ids(req.body?.assetIds);
    // Segregation of duties: you can't verify fixes you were assigned to make.
    const r = await Asset.updateMany({ assetId: { $in: list }, 'dataQuality.assignedTo': { $ne: req.user._id } },
      { $set: { 'dataQuality.verifiedBy': req.user._id, 'dataQuality.verifiedAt': new Date() } });
    res.json({ verified: r.modifiedCount, skipped: list.length - r.modifiedCount });
  } catch (err) { next(err); }
});

module.exports = router;
