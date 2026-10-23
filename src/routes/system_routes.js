'use strict';
// System health, error reporting, backups and reference lists.
//   GET  /api/system/ping           — public: { status, db } for uptime monitors
//   GET  /api/system/health         — admin: database latency, uptime, memory, integrations, counts
//   POST /api/system/client-errors  — dashboard reports a browser error (rate-limited)
//   GET  /api/system/errors         — admin: recent server + browser errors
//   GET  /api/system/backup         — admin: download every collection as Extended JSON
//   GET  /api/system/enums          — signed-in: allowed values (states, types, conditions…)
const router = require('express').Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { BSON } = require('mongodb');
const env = require('../config/env');
const ErrorLog = require('../models/ErrorLog');
const Asset = require('../models/Asset');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { authenticate, requireRole } = require('../middleware/auth');
const { NIGERIA_STATES } = require('../utils/states');
const mailer = require('../services/mailer');
const sms = require('../services/sms');

const adminOnly = [authenticate, requireRole('System Admin')];
const started = Date.now();

router.get('/ping', async (_req, res) => {
  const ok = mongoose.connection.readyState === 1;
  let db = ok ? 'ok' : 'down';
  if (ok) { try { await mongoose.connection.db.admin().ping(); } catch { db = 'down'; } }
  res.status(db === 'ok' ? 200 : 503).json({ status: db === 'ok' ? 'ok' : 'degraded', db, ts: new Date() });
});

router.get('/health', ...adminOnly, async (_req, res, next) => {
  try {
    const t0 = Date.now();
    await mongoose.connection.db.admin().ping();
    const dbLatencyMs = Date.now() - t0;
    const day = new Date(Date.now() - 86400000);
    const [assets, users, errors24h, clientErrors24h] = await Promise.all([
      Asset.estimatedDocumentCount(), User.countDocuments({ isActive: true }),
      ErrorLog.countDocuments({ source: 'server', at: { $gte: day } }),
      ErrorLog.countDocuments({ source: 'client', at: { $gte: day } }),
    ]);
    const mem = process.memoryUsage();
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - started) / 1000),
      node: process.version,
      environment: env.NODE_ENV,
      database: { name: mongoose.connection.name, host: mongoose.connection.host, latencyMs: dbLatencyMs },
      memoryMb: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
      integrations: {
        email: mailer.isConfigured(), sms: sms.isConfigured(),
        antivirus: !!process.env.CLAMAV_HOST, appUrl: mailer.appUrl() || null,
      },
      counts: { assets, activeUsers: users, serverErrors24h: errors24h, clientErrors24h },
    });
  } catch (err) { next(err); }
});

// Browser errors. Signed-in users are attributed; anonymous reports are accepted
// too (errors can happen before sign-in), but rate-limited per IP.
const clientErrorLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, handler: (_q, r) => r.status(429).json({ error: 'Too many reports' }) });
router.post('/client-errors', clientErrorLimiter, async (req, res) => {
  try {
    let user;
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) { try { user = jwt.verify(h.slice(7), env.JWT_SECRET).sub; } catch { /* anonymous */ } }
    const b = req.body || {};
    const clip = (v, n) => (v == null ? undefined : String(v).slice(0, n));
    if (!b.message) return res.status(400).json({ error: 'message is required' });
    await ErrorLog.create({
      source: 'client', message: clip(b.message, 1000), stack: clip(b.stack, 8000), url: clip(b.url, 1000),
      release: clip(b.release, 100), user, userAgent: clip(req.get('user-agent'), 400), ip: req.ip,
    });
    res.status(204).end();
  } catch { res.status(204).end(); }   // never make error reporting itself fail loudly
});

router.get('/errors', ...adminOnly, async (req, res, next) => {
  try {
    const q = {};
    if (req.query.source === 'server' || req.query.source === 'client') q.source = req.query.source;
    const errors = await ErrorLog.find(q).sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 100, 500))
      .populate('user', 'name email').lean();
    res.json({ errors });
  } catch (err) { next(err); }
});

// Full logical backup as Extended JSON (keeps ObjectIds and dates exact).
// Photo/document file contents (GridFS chunks) are excluded — too large for a
// download; their metadata is included. Contains password hashes: treat the
// file as confidential.
router.get('/backup', ...adminOnly, async (req, res, next) => {
  try {
    const db = mongoose.connection.db;
    const cols = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map(c => c.name).filter(n => !n.startsWith('system.') && !n.endsWith('.chunks')).sort();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="fpamas-backup-${stamp}.json"`);
    res.write(`{"meta":${JSON.stringify({ createdAt: new Date(), database: db.databaseName, collections: cols, format: 'mongodb-extended-json-v2', excludes: 'GridFS file contents (*.chunks)' })},"collections":{`);
    for (let i = 0; i < cols.length; i++) {
      res.write(`${i ? ',' : ''}${JSON.stringify(cols[i])}:[`);
      let first = true;
      for await (const doc of db.collection(cols[i]).find({})) {
        res.write((first ? '' : ',') + BSON.EJSON.stringify(doc, { relaxed: false }));
        first = false;
      }
      res.write(']');
    }
    res.end('}}');
    AuditLog.create({ action: 'EXPORT', entityType: 'System', entityId: 'backup', performedBy: req.user._id, detail: `Full database backup downloaded (${cols.length} collections)`, ipAddress: req.ip }).catch(() => {});
  } catch (err) {
    if (res.headersSent) { console.error('[backup] failed mid-stream:', err.message); res.end(); }
    else next(err);
  }
});

// The values the backend accepts, so the dashboard can check its own lists
// against them (System health shows any drift).
router.get('/enums', authenticate, (_req, res) => {
  const pick = name => Asset.schema.path(name)?.enumValues?.filter(v => v !== '' && v != null) || [];
  res.json({
    states: NIGERIA_STATES,
    assetTypes: pick('type'),
    conditions: pick('condition'),
    statuses: pick('status'),
    geomTypes: pick('geomType'),
    assessed: pick('assessed'),
    sectors: pick('sector'),
    lifecycleStages: pick('lifecycleStage'),
    roles: User.schema.path('role').enumValues,
    divisions: User.schema.path('division').enumValues.filter(Boolean),
  });
});

module.exports = router;
