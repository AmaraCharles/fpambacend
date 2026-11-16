'use strict';
// ── BUILDING TRAINING & MAINTENANCE ───────────────────────────────────────────
// Mount at: app.use('/api/btm', require('./routes/btm_routes'));
//
// GET    /api/btm/summary
// GET    /api/btm/plans                POST /api/btm/plans
// PATCH  /api/btm/plans/:id            DELETE /api/btm/plans/:id
// POST   /api/btm/plans/:id/work-order — raise a work order for a planned task
// GET    /api/btm/work-orders          POST /api/btm/work-orders  (body.reportId raises one from a public report)
// PATCH  /api/btm/work-orders/:id      — edit / change status; Completed writes the asset's maintenance log
// GET    /api/btm/training             POST /api/btm/training
// PATCH  /api/btm/training/:id         DELETE /api/btm/training/:id
//
// Anyone on FPAM staff can view. Changes need System Admin or the Building
// Training & Maintenance division (division 'All' = cross-division roles).

const crypto = require('crypto');
const router = require('express').Router();
const Asset = require('../models/Asset');
const PublicReport = require('../models/PublicReport');
const { MaintenancePlan, WorkOrder, TrainingSession, FREQUENCIES, CATEGORIES, WO_STATUSES } = require('../models/Maintenance');
const { idQuery } = require('../services/assetService');
const { authenticate } = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { auditLog } = require('../middleware/auditMiddleware');

const BTM = 'Building Training & Maintenance';
const canManage = u => u.role === 'System Admin' || u.division === BTM || u.division === 'All';

function staffOnly(req, res, next) {
  if (req.user.role === 'MDA Agent') return res.status(403).json({ error: 'Not available to MDA accounts' });
  next();
}
function requireBtm(req, res, next) {
  if (!canManage(req.user)) {
    return res.status(403).json({ error: `Only System Admin or the ${BTM} division can make changes here`, yourDivision: req.user.division });
  }
  next();
}
const view = [authenticate, resolvePermissions, staffOnly];
const edit = [...view, requireBtm];

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const date = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; };
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (err) { res.status(err.name === 'ValidationError' ? 422 : 500).json({ error: err.message }); }
};

async function findAsset(id) {
  const a = id ? await Asset.findOne(idQuery(id), { assetId: 1, name: 1 }).lean() : null;
  return a;
}
function newRef() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `WO-${d}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}
async function createWorkOrder(fields) {
  for (let i = 0; i < 3; i++) {
    try { return await WorkOrder.create({ ...fields, ref: newRef() }); }
    catch (err) { if (err.code !== 11000) throw err; }
  }
  throw new Error('Could not allocate a work order number');
}

// ── Summary ──────────────────────────────────────────────────────────────────
router.get('/summary', ...view, wrap(async (req, res) => {
  const now = new Date(), week = addDays(now, 7), yearStart = new Date(now.getFullYear(), 0, 1);
  const [open, inProgress, overdueWo, plansOverdue, plansDueWeek, sessions] = await Promise.all([
    WorkOrder.countDocuments({ status: 'Open' }),
    WorkOrder.countDocuments({ status: 'In progress' }),
    WorkOrder.countDocuments({ status: { $in: ['Open', 'In progress'] }, dueDate: { $lt: now } }),
    MaintenancePlan.countDocuments({ active: true, nextDue: { $lt: now } }),
    MaintenancePlan.countDocuments({ active: true, nextDue: { $gte: now, $lte: week } }),
    TrainingSession.find({ date: { $gte: yearStart } }, { attendees: 1 }).lean(),
  ]);
  res.json({
    workOrders: { open, inProgress, overdue: overdueWo },
    plans: { overdue: plansOverdue, dueThisWeek: plansDueWeek },
    training: { sessionsThisYear: sessions.length, attendeesThisYear: sessions.reduce((n, s) => n + (s.attendees?.length || 0), 0) },
    canManage: canManage(req.user),
    options: { frequencies: Object.keys(FREQUENCIES), categories: CATEGORIES, statuses: WO_STATUSES },
  });
}));

// ── Maintenance plans ────────────────────────────────────────────────────────
router.get('/plans', ...view, wrap(async (req, res) => {
  const q = req.query.all === '1' ? {} : { active: true };
  if (req.query.assetId) q.assetId = String(req.query.assetId);
  res.json({ plans: await MaintenancePlan.find(q).sort({ nextDue: 1 }).limit(1000).lean() });
}));

function planFields(b) {
  const out = {};
  if (b.task !== undefined) out.task = str(b.task, 200);
  if (b.category !== undefined) out.category = b.category;
  if (b.frequency !== undefined) out.frequency = b.frequency;
  if (b.nextDue !== undefined) out.nextDue = date(b.nextDue);
  if (b.assignedTo !== undefined) out.assignedTo = str(b.assignedTo, 120);
  if (b.notes !== undefined) out.notes = str(b.notes, 2000);
  if (b.active !== undefined) out.active = !!b.active;
  return out;
}

router.post('/plans', ...edit, auditLog('BTM_PLAN_CREATED', 'MaintenancePlan'), wrap(async (req, res) => {
  const asset = await findAsset(req.body?.assetId);
  if (!asset) return res.status(422).json({ error: 'Choose an asset from the register' });
  const plan = await MaintenancePlan.create({ ...planFields(req.body), assetId: asset.assetId, assetName: asset.name, createdBy: req.user._id });
  res.status(201).json({ plan });
}));

router.patch('/plans/:id', ...edit, auditLog('BTM_PLAN_UPDATED', 'MaintenancePlan'), wrap(async (req, res) => {
  const plan = await MaintenancePlan.findById(req.params.id).catch(() => null);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  plan.set(planFields(req.body || {}));
  await plan.save();
  res.json({ plan });
}));

router.delete('/plans/:id', ...edit, auditLog('BTM_PLAN_DELETED', 'MaintenancePlan'), wrap(async (req, res) => {
  const r = await MaintenancePlan.deleteOne({ _id: req.params.id }).catch(() => ({ deletedCount: 0 }));
  if (!r.deletedCount) return res.status(404).json({ error: 'Plan not found' });
  res.json({ ok: true });
}));

router.post('/plans/:id/work-order', ...edit, auditLog('BTM_WORK_ORDER_CREATED', 'WorkOrder'), wrap(async (req, res) => {
  const plan = await MaintenancePlan.findById(req.params.id).catch(() => null);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  const existing = await WorkOrder.findOne({ 'source.type': 'plan', 'source.id': plan._id, status: { $in: ['Open', 'In progress'] } }).lean();
  if (existing) return res.status(409).json({ error: `Work order ${existing.ref} is already open for this task`, workOrder: existing });
  const wo = await createWorkOrder({
    assetId: plan.assetId, assetName: plan.assetName, title: plan.task, description: plan.notes, category: plan.category,
    assignedTo: plan.assignedTo, dueDate: plan.nextDue, source: { type: 'plan', id: plan._id },
    createdBy: req.user._id, createdByName: req.user.name || '',
  });
  res.locals.auditEntityId = wo.ref;
  res.status(201).json({ workOrder: wo });
}));

// ── Work orders ──────────────────────────────────────────────────────────────
router.get('/work-orders', ...view, wrap(async (req, res) => {
  const q = {};
  if (req.query.status === 'active') q.status = { $in: ['Open', 'In progress'] };
  else if (req.query.status) q.status = String(req.query.status);
  if (req.query.assetId) q.assetId = String(req.query.assetId);
  res.json({ workOrders: await WorkOrder.find(q).sort({ createdAt: -1 }).limit(1000).lean() });
}));

function woFields(b) {
  const out = {};
  if (b.title !== undefined) out.title = str(b.title, 200);
  if (b.description !== undefined) out.description = str(b.description, 4000);
  if (b.category !== undefined) out.category = b.category;
  if (b.priority !== undefined) out.priority = b.priority;
  if (b.assignedTo !== undefined) out.assignedTo = str(b.assignedTo, 120);
  if (b.dueDate !== undefined) out.dueDate = date(b.dueDate);
  if (b.cost !== undefined) out.cost = b.cost === '' || b.cost === null ? null : Number(b.cost);
  return out;
}

router.post('/work-orders', ...edit, auditLog('BTM_WORK_ORDER_CREATED', 'WorkOrder'), wrap(async (req, res) => {
  const b = req.body || {};
  let report = null;
  if (b.reportId) {
    report = await PublicReport.findById(b.reportId).catch(() => null);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.workOrderId) return res.status(409).json({ error: 'A work order has already been raised for this report' });
  }
  const asset = await findAsset(report ? report.assetId : b.assetId);
  if (!asset) return res.status(422).json({ error: 'Choose an asset from the register' });
  const wo = await createWorkOrder({
    title: report ? `${report.category} (public report ${report.ref})` : '',
    description: report ? report.description : '',
    ...woFields(b),
    assetId: asset.assetId, assetName: asset.name,
    source: report ? { type: 'report', id: report._id } : { type: 'manual' },
    createdBy: req.user._id, createdByName: req.user.name || '',
  });
  if (report) {
    report.workOrderId = wo._id;
    if (['New', 'Acknowledged'].includes(report.status)) report.status = 'In progress';
    report.history.push({ status: report.status, by: req.user.name || '', note: `Work order ${wo.ref} raised` });
    await report.save();
  }
  res.locals.auditEntityId = wo.ref;
  res.status(201).json({ workOrder: wo });
}));

router.patch('/work-orders/:id', ...edit, auditLog('BTM_WORK_ORDER_UPDATED', 'WorkOrder'), wrap(async (req, res) => {
  const wo = await WorkOrder.findById(req.params.id).catch(() => null);
  if (!wo) return res.status(404).json({ error: 'Work order not found' });
  const b = req.body || {};
  if (['Completed', 'Cancelled'].includes(wo.status)) return res.status(409).json({ error: `This work order is already ${wo.status.toLowerCase()}` });
  wo.set(woFields(b));
  if (b.status && b.status !== wo.status) {
    if (!WO_STATUSES.includes(b.status)) return res.status(422).json({ error: 'Unknown status' });
    if (b.status === 'Completed') {
      const note = str(b.completionNote, 2000);
      if (!note) return res.status(422).json({ error: 'Say what was done before completing' });
      wo.completionNote = note;
      wo.completedAt = date(b.completedAt) || new Date();
    }
    wo.status = b.status;
  }
  await wo.save();

  if (wo.status === 'Completed') {
    // The asset's own maintenance log gets the record, so it shows on the asset.
    await Asset.updateOne({ assetId: wo.assetId }, { $push: { maintenanceLogs: {
      date: wo.completedAt, desc: `${wo.ref}: ${wo.title}${wo.completionNote ? ` — ${wo.completionNote}` : ''}`,
      tech: wo.assignedTo || undefined, cost: wo.cost ?? undefined, loggedBy: req.user._id,
    } } });
    if (wo.source?.type === 'plan' && wo.source.id) {
      const plan = await MaintenancePlan.findById(wo.source.id);
      if (plan) {
        plan.lastDone = wo.completedAt;
        plan.nextDue = addDays(wo.completedAt, FREQUENCIES[plan.frequency] || 30);
        await plan.save();
      }
    }
    if (wo.source?.type === 'report' && wo.source.id) {
      const report = await PublicReport.findById(wo.source.id);
      if (report && !['Resolved', 'Dismissed'].includes(report.status)) {
        report.status = 'Resolved';
        report.history.push({ status: 'Resolved', by: req.user.name || '', note: `Work order ${wo.ref} completed: ${wo.completionNote}` });
        await report.save();
      }
    }
  }
  res.locals.auditEntityId = wo.ref;
  res.json({ workOrder: wo });
}));

// ── Training ─────────────────────────────────────────────────────────────────
router.get('/training', ...view, wrap(async (req, res) => {
  res.json({ sessions: await TrainingSession.find({}).sort({ date: -1 }).limit(1000).lean() });
}));

async function trainingFields(b) {
  const out = {};
  if (b.title !== undefined) out.title = str(b.title, 200);
  if (b.topic !== undefined) out.topic = str(b.topic, 200);
  if (b.date !== undefined) out.date = date(b.date);
  if (b.durationHours !== undefined) out.durationHours = b.durationHours === '' || b.durationHours === null ? null : Number(b.durationHours);
  if (b.venue !== undefined) out.venue = str(b.venue, 200);
  if (b.facilitator !== undefined) out.facilitator = str(b.facilitator, 120);
  if (b.notes !== undefined) out.notes = str(b.notes, 4000);
  if (Array.isArray(b.attendees)) {
    out.attendees = b.attendees.slice(0, 500)
      .map(a => ({ name: str(a?.name, 120), organisation: str(a?.organisation, 160) }))
      .filter(a => a.name);
  }
  if (b.assetId !== undefined) {
    const asset = await findAsset(b.assetId);
    out.assetId = asset?.assetId || '';
    out.assetName = asset?.name || '';
  }
  return out;
}

router.post('/training', ...edit, auditLog('BTM_TRAINING_CREATED', 'TrainingSession'), wrap(async (req, res) => {
  const session = await TrainingSession.create({ ...(await trainingFields(req.body || {})), createdBy: req.user._id });
  res.status(201).json({ session });
}));

router.patch('/training/:id', ...edit, auditLog('BTM_TRAINING_UPDATED', 'TrainingSession'), wrap(async (req, res) => {
  const session = await TrainingSession.findById(req.params.id).catch(() => null);
  if (!session) return res.status(404).json({ error: 'Training session not found' });
  session.set(await trainingFields(req.body || {}));
  await session.save();
  res.json({ session });
}));

router.delete('/training/:id', ...edit, auditLog('BTM_TRAINING_DELETED', 'TrainingSession'), wrap(async (req, res) => {
  const r = await TrainingSession.deleteOne({ _id: req.params.id }).catch(() => ({ deletedCount: 0 }));
  if (!r.deletedCount) return res.status(404).json({ error: 'Training session not found' });
  res.json({ ok: true });
}));

module.exports = router;
