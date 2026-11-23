'use strict';
// ── ACCESS REQUESTS ───────────────────────────────────────────────────────────
// Mount at: app.use('/api/access-requests', require('./routes/access_requests_routes'));
//
// POST  /api/access-requests       — public (register.html): { name, email, organisation, requestedRole, reason }
// GET   /api/access-requests       — System Admin: list (?status=pending|approved|declined)
// PATCH /api/access-requests/:id   — System Admin: { status: 'approved'|'declined', note, userId? }
//
// Before this existed, register.html's request failed silently and was kept
// only in the visitor's own browser, so nobody at FPAM ever saw it.

const router = require('express').Router();
const AccessRequest = require('../models/AccessRequest');
const User = require('../models/User');
const { authenticate } = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { auditLog } = require('../middleware/auditMiddleware');
const { publicReportLimiter } = require('../middleware/rateLimiter');
const notify = require('../services/notify');

const str = (v, max) => String(v ?? '').trim().slice(0, max);
function requireAdmin(req, res, next) {
  if (req.user.role !== 'System Admin') return res.status(403).json({ error: 'Only System Admins can review access requests' });
  next();
}
const admin = [authenticate, resolvePermissions, requireAdmin];

router.post('/', publicReportLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.website) return res.status(201).json({ ok: true });   // honeypot: bots get a normal answer, nothing stored
    const name = str(b.name, 120), email = str(b.email, 160).toLowerCase(), organisation = str(b.organisation, 200);
    if (!name || !email || !organisation) return res.status(422).json({ error: 'Name, email and organisation are required' });
    if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(422).json({ error: 'Enter a valid email address' });
    const requestedRole = AccessRequest.ROLES.includes(b.requestedRole) ? b.requestedRole : 'Field Agent';

    // Same answer whether or not an account or pending request exists, so the
    // form can't be used to find out who has an account.
    const [existingUser, pending] = await Promise.all([
      User.exists({ email }),
      AccessRequest.exists({ email, status: 'pending' }),
    ]);
    if (!existingUser && !pending) {
      const request = await AccessRequest.create({ name, email, organisation, requestedRole, reason: str(b.reason, 1000) });
      notify.accessRequested(request);
    }
    res.status(201).json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/', ...admin, async (req, res) => {
  try {
    const q = {};
    if (['pending', 'approved', 'declined'].includes(req.query.status)) q.status = req.query.status;
    const [requests, counts] = await Promise.all([
      AccessRequest.find(q).sort({ createdAt: -1 }).limit(500).lean(),
      AccessRequest.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    ]);
    res.json({ requests, counts: Object.fromEntries(counts.map(c => [c._id, c.n])) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/:id', ...admin, auditLog('ACCESS_REQUEST_DECIDED', 'AccessRequest'), async (req, res) => {
  try {
    const r = await AccessRequest.findById(req.params.id).catch(() => null);
    if (!r) return res.status(404).json({ error: 'Request not found' });
    if (r.status !== 'pending') return res.status(409).json({ error: `This request was already ${r.status}` });
    const status = req.body?.status;
    if (!['approved', 'declined'].includes(status)) return res.status(422).json({ error: 'Status must be approved or declined' });
    const note = str(req.body?.note, 500);
    if (status === 'declined' && !note) return res.status(422).json({ error: 'Give a reason for declining' });
    if (status === 'approved') {
      // Approving means an account now exists for this email (created on the Users page).
      const user = await User.findOne({ email: r.email }, { _id: 1 }).lean();
      if (!user) return res.status(422).json({ error: 'Create the account first, then approve' });
      r.userId = user._id;
    }
    Object.assign(r, { status, note, decidedBy: req.user._id, decidedByName: req.user.name || '', decidedAt: new Date() });
    await r.save();
    res.locals.auditEntityId = r.email;
    res.json({ request: r });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
