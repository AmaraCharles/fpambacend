'use strict';
// ── ROLE CONFIG ROUTES ────────────────────────────────────────────────────────
// Mount BEFORE /api/users in app.js:
//   app.use('/api/users/role-config', require('./routes/role_config_routes'));
//
//   GET    /api/users/role-config           → return all role configs
//   PUT    /api/users/role-config/:role     → save one role's permissions
//   POST   /api/users/role-config/reset     → restore factory defaults

const router   = require('express').Router();
const mongoose = require('mongoose');

const { authenticate }                    = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');

const auth      = [authenticate, resolvePermissions];
const adminOnly = [...auth, requirePerm('canManageSettings')];

// ── Keys the frontend PERM_LABELS understands ─────────────────────────────────
const FRONTEND_KEYS = [
  'canCreate', 'canEdit', 'canDelete', 'canApprove',
  'canExport', 'canViewAll', 'canManageUsers', 'canViewAudit', 'canManageSettings',
  'canEditInventory', 'canSubmitFormRequests', 'canReviewFormRequests',
];

const TO_SHORT = {
  canCreateAssets:   'canCreate',
  canEditAssets:     'canEdit',
  canDeleteAssets:   'canDelete',
  canApproveAssets:  'canApprove',
  canExportData:     'canExport',
  canViewAuditLog:   'canViewAudit',
  canChangeSettings: 'canManageSettings',
  canEditInventory:      'canEditInventory',      // passes through unchanged — already short
  canSubmitFormRequests: 'canSubmitFormRequests', // passes through unchanged — already short
  canReviewFormRequests: 'canReviewFormRequests', // passes through unchanged — already short
};

// Normalize any mix of long/short keys → short keys only
function normalize(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const short = TO_SHORT[k];
    if (short && !(short in out)) out[short] = Boolean(v);
  }
  for (const k of FRONTEND_KEYS) {
    if (!(k in out)) out[k] = false;
  }
  return out;
}

const ROLES = ['Field Agent', 'Sub-Head', 'Supervisor', 'GIS Analyst'];

const FACTORY_DEFAULTS = {
  'Field Agent': {
    canCreate: true,  canEdit: false, canDelete: false, canApprove: false,
    canExport: false, canViewAll: false, canManageUsers: false,
    canViewAudit: false, canManageSettings: false,
    // canEditInventory:true — corrected to match the original frontend
    // app.js's ROLE_DEFAULTS (Field Agents physically catalogue inventory
    // during capture); the earlier `false` here was a guess made before
    // that file was available, and it was wrong.
    canEditInventory: true, canSubmitFormRequests: true, canReviewFormRequests: false,
  },
  'Sub-Head': {
    canCreate: true,  canEdit: false, canDelete: false, canApprove: true,
    canExport: false, canViewAll: true, canManageUsers: false,
    canViewAudit: false, canManageSettings: false,
    canEditInventory: true, canSubmitFormRequests: true, canReviewFormRequests: true,
  },
  'Supervisor': {
    canCreate: true,  canEdit: true,  canDelete: true,  canApprove: true,
    canExport: true,  canViewAll: true, canManageUsers: false,
    canViewAudit: true, canManageSettings: false,
    canEditInventory: true, canSubmitFormRequests: true, canReviewFormRequests: true,
  },
  'GIS Analyst': {
    canCreate: false, canEdit: false, canDelete: false, canApprove: false,
    canExport: true,  canViewAll: true, canManageUsers: false,
    canViewAudit: true, canManageSettings: false,
    canEditInventory: false, canSubmitFormRequests: true, canReviewFormRequests: false,
  },
};

function col() {
  return mongoose.connection.db.collection('roleconfigs');
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', ...auth, async (req, res) => {
  try {
    const docs = await col().find({}).toArray();
    const byRole = {};
    docs.forEach(d => { byRole[d.role] = d.defaults; });

    const configs = ROLES.map(role => ({
      role,
      defaults: normalize(byRole[role] || FACTORY_DEFAULTS[role]),
    }));

    res.json({ configs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /:role ────────────────────────────────────────────────────────────────
router.put('/:role', ...adminOnly, async (req, res) => {
  try {
    const role = decodeURIComponent(req.params.role);
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `Unknown role: ${role}` });
    }
    const defaults = normalize(req.body.defaults || req.body);

    await col().updateOne(
      { role },
      { $set: { role, defaults, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ role, defaults });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /reset ───────────────────────────────────────────────────────────────
router.post('/reset', ...adminOnly, async (req, res) => {
  try {
    await col().deleteMany({});
    const docs = ROLES.map(role => ({
      role, defaults: FACTORY_DEFAULTS[role], updatedAt: new Date(),
    }));
    await col().insertMany(docs);
    res.json({ configs: ROLES.map(role => ({ role, defaults: FACTORY_DEFAULTS[role] })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;