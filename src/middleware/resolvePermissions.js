'use strict';

const mongoose = require('mongoose');

// ── Role defaults ─────────────────────────────────────────────────────────────
// This is the ultimate fallback baseline for every permission key checked
// anywhere in the app via requirePerm(). Historically several route files
// checked keys that were never added here at all (canApprove vs
// canApproveAssets, plus canEditInventory/canReviewFormRequests/
// canSubmitFormRequests/canRunOCR missing outright) — since resolvePermissions
// merges `{ ...defaults, ...overrides }`, a key that's simply absent from
// defaults is `undefined`, and `undefined === true` is always false, so
// those routes 403'd for every role including System Admin, silently,
// with no error indicating why. Every key any requirePerm() call anywhere
// in the codebase checks MUST have an entry here for every role.
const ROLE_DEFAULTS = {
  'System Admin': {
    canCreateAssets: true,  canEditAssets: true,  canDeleteAssets: true,
    canCreate: true,        canEdit: true,         canDelete: true,
    canExport: true,        canViewAll: true,
    canExportData: true,    canBulkExport: true,
    canManageUsers: true,   canViewAudit: true,    canManageSettings: true,
    canApproveAssets: true,
    canEditInventory: true, canReviewFormRequests: true, canSubmitFormRequests: true,
    canRunOCR: true,
  },
  'Supervisor': {
    canCreateAssets: true,  canEditAssets: true,  canDeleteAssets: true,
    canCreate: true,        canEdit: true,         canDelete: true,
    canExport: true,        canViewAll: true,
    canExportData: true,    canBulkExport: true,
    canManageUsers: false,  canViewAudit: true,    canManageSettings: false,
    canApproveAssets: true,
    canEditInventory: true, canReviewFormRequests: true, canSubmitFormRequests: true,
    canRunOCR: true,
  },
  // Sub-Head — one rung above Field Agent. Created specifically to verify
  // field captures: can review a Field Agent's submission and approve or
  // reject it before it's treated as part of the official registry.
  'Sub-Head': {
    canCreateAssets: true,  canEditAssets: false, canDeleteAssets: false,
    canCreate: true,        canEdit: false,        canDelete: false,
    canExport: false,       canViewAll: true,
    canExportData: false,   canBulkExport: false,
    canManageUsers: false,  canViewAudit: false,   canManageSettings: false,
    canApproveAssets: true,
    // canEditInventory:true — matches the original frontend app.js's
    // ROLE_DEFAULTS exactly (confirmed once that file was actually
    // available); the earlier `false` here was my own guess, made without
    // access to that file, and it was wrong.
    canEditInventory: true, canReviewFormRequests: true, canSubmitFormRequests: true,
    canRunOCR: true,
  },
  'GIS Analyst': {
    canCreateAssets: false, canEditAssets: false, canDeleteAssets: false,
    canCreate: false,       canEdit: false,        canDelete: false,
    canExport: true,        canViewAll: true,
    canExportData: true,    canBulkExport: true,
    canManageUsers: false,  canViewAudit: true,    canManageSettings: false,
    canApproveAssets: false,
    canEditInventory: false, canReviewFormRequests: false, canSubmitFormRequests: true,
    canRunOCR: true,
  },
  'Field Agent': {
    // Field Agents can CAPTURE new assets (capture.html) but cannot
    // edit or delete existing registry records. Their captures land as
    // 'Pending' until a Sub-Head / Supervisor / System Admin approves them.
    canCreateAssets: true,  canEditAssets: false, canDeleteAssets: false,
    canCreate: false,       canEdit: false,        canDelete: false,
    canExport: false,       canViewAll: false,
    canExportData: false,   canBulkExport: false,
    canManageUsers: false,  canViewAudit: false,   canManageSettings: false,
    canApproveAssets: false,
    // canEditInventory:true — same correction as Sub-Head above. Field
    // Agents are the ones physically walking a facility cataloguing
    // inventory during capture, so this makes sense as true; my earlier
    // guess of false was wrong, made without the original frontend file.
    canEditInventory: true, canReviewFormRequests: false, canSubmitFormRequests: true,
    canRunOCR: true,
  },
};

// ── Admin-configurable overrides (Role Config page) ─────────────────────────
// routes/role_config_routes.js manages the "roleconfigs" MongoDB collection
// directly via the raw driver, storing SHORT key names (canApprove,
// canEdit, ...) that match what users.html's admin UI renders. Until now,
// this middleware never read that collection at all, so saving changes on
// the Role Config settings page had ZERO effect on real enforcement — every
// requirePerm() check only ever consulted the hardcoded ROLE_DEFAULTS above.
// SHORT_TO_LONG is the exact inverse of role_config_routes.js's TO_SHORT map
// and is what makes an admin's saved override actually take effect.
const SHORT_TO_LONG = {
  canCreate:              'canCreateAssets',
  canEdit:                'canEditAssets',
  canDelete:              'canDeleteAssets',
  canApprove:             'canApproveAssets',
  canExport:              'canExportData',
  canViewAudit:           'canViewAudit',
  canManageSettings:      'canManageSettings',
  canManageUsers:         'canManageUsers',
  canViewAll:             'canViewAll',
  canEditInventory:       'canEditInventory',
  canReviewFormRequests:  'canReviewFormRequests',
  canSubmitFormRequests:  'canSubmitFormRequests',
};

// Cheap in-process cache — this middleware runs on every permissioned
// request, and the roleconfigs collection changes rarely (only when an
// admin explicitly saves the settings page), so re-querying Mongo on every
// single request would be wasteful. TTL keeps a saved change from taking
// more than a few seconds to actually apply.
let _roleConfigCache   = null;
let _roleConfigCacheAt = 0;
const ROLE_CONFIG_CACHE_TTL_MS = 15000;

async function getRoleConfigOverrides() {
  const now = Date.now();
  if (_roleConfigCache && (now - _roleConfigCacheAt) < ROLE_CONFIG_CACHE_TTL_MS) {
    return _roleConfigCache;
  }
  try {
    if (!mongoose.connection || mongoose.connection.readyState !== 1) return _roleConfigCache || {};
    const docs = await mongoose.connection.db.collection('roleconfigs').find({}).toArray();
    const byRole = {};
    for (const doc of docs) {
      const longForm = {};
      for (const [shortKey, val] of Object.entries(doc.defaults || {})) {
        longForm[SHORT_TO_LONG[shortKey] || shortKey] = val;
      }
      byRole[doc.role] = longForm;
    }
    _roleConfigCache   = byRole;
    _roleConfigCacheAt = now;
    return byRole;
  } catch (err) {
    // DB hiccup — fall back to whatever we last had (or nothing), never
    // let a role-config lookup failure be the reason a request 500s.
    return _roleConfigCache || {};
  }
}

async function resolvePermissions(req, res, next) {
  const user = req.user;
  if (!user) return next();

  const role = user.role || user.userRole || user.roleName || user.type || 'Field Agent';
  req.user.role = role;

  const base = ROLE_DEFAULTS[role] || ROLE_DEFAULTS['Field Agent'];

  let roleOverride = {};
  try {
    const allOverrides = await getRoleConfigOverrides();
    roleOverride = allOverrides[role] || {};
  } catch {
    roleOverride = {};
  }

  // Priority, lowest to highest: hardcoded role baseline → admin-configured
  // role override (Settings page) → per-user override (individual grant).
  // Same short/long key problem exists one layer further down: PUT
  // /api/users/:id/permissions (an admin granting one specific user an
  // individual override) validates and stores the SAME short key shape
  // (validate.js's `permissions` schema — canApprove, canEdit, ...)
  // directly onto user.permissions with zero translation. Merging that
  // in unchanged means it sits alongside the long keys as unrelated,
  // never-checked fields — an admin could grant a specific Field Agent
  // individual approval rights and it would silently do nothing, exactly
  // like the role-level Settings page did before the fix above.
  const rawUserOverride = user.permissions || {};
  const userOverride = {};
  for (const [key, val] of Object.entries(rawUserOverride)) {
    userOverride[SHORT_TO_LONG[key] || key] = val;
  }
  req.permissions = { ...base, ...roleOverride, ...userOverride };
  next();
}

function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.permissions) {
      return res.status(403).json({ error: 'Permissions not resolved — check middleware order' });
    }
    if (req.permissions[perm] === true) return next();
    return res.status(403).json({
      error:        `Permission denied: ${perm} required`,
      yourRole:     req.user?.role,
      requiredPerm: perm,
    });
  };
}

module.exports = { resolvePermissions, requirePerm, getRoleConfigOverrides, ROLE_DEFAULTS, SHORT_TO_LONG };