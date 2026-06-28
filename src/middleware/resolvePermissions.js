'use strict';

const ROLE_DEFAULTS = {
  'System Admin': {
    canCreateAssets: true,  canEditAssets: true,  canDeleteAssets: true,
    canCreate: true,        canEdit: true,         canDelete: true,
    canExport: true,        canViewAll: true,
    canManageUsers: true,   canViewAudit: true,    canManageSettings: true,
    canApproveAssets: true,
  },
  'Supervisor': {
    canCreateAssets: true,  canEditAssets: true,  canDeleteAssets: true,
    canCreate: true,        canEdit: true,         canDelete: true,
    canExport: true,        canViewAll: true,
    canManageUsers: false,  canViewAudit: true,    canManageSettings: false,
    canApproveAssets: true,
  },
  // Sub-Head — one rung above Field Agent. Created specifically to verify
  // field captures: can review a Field Agent's submission and approve or
  // reject it before it's treated as part of the official registry.
  'Sub-Head': {
    canCreateAssets: true,  canEditAssets: false, canDeleteAssets: false,
    canCreate: true,        canEdit: false,        canDelete: false,
    canExport: false,       canViewAll: true,
    canManageUsers: false,  canViewAudit: false,   canManageSettings: false,
    canApproveAssets: true,
  },
  'GIS Analyst': {
    canCreateAssets: false, canEditAssets: false, canDeleteAssets: false,
    canCreate: false,       canEdit: false,        canDelete: false,
    canExport: true,        canViewAll: true,
    canManageUsers: false,  canViewAudit: true,    canManageSettings: false,
    canApproveAssets: false,
  },
  'Field Agent': {
    // Field Agents can CAPTURE new assets (capture.html) but cannot
    // edit or delete existing registry records. Their captures land as
    // 'Pending' until a Sub-Head / Supervisor / System Admin approves them.
    canCreateAssets: true,  canEditAssets: false, canDeleteAssets: false,
    canCreate: false,       canEdit: false,        canDelete: false,
    canExport: false,       canViewAll: false,
    canManageUsers: false,  canViewAudit: false,   canManageSettings: false,
    canApproveAssets: false,
  },
};

function resolvePermissions(req, res, next) {
  const user = req.user;
  if (!user) return next();

  const role = user.role || user.userRole || user.roleName || user.type || 'Field Agent';
  req.user.role = role;

  const defaults  = ROLE_DEFAULTS[role] || ROLE_DEFAULTS['Field Agent'];
  const overrides = user.permissions || {};

  req.permissions = { ...defaults, ...overrides };
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

module.exports = { resolvePermissions, requirePerm };