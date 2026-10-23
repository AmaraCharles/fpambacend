'use strict';
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Schema, Types } = mongoose;

// ── Permissions sub-schema ────────────────────────────────────────────────────
// Keys match the short names used by the frontend (users.js / role_config_routes.js)
// and by resolvePermissions.js's ROLE_DEFAULTS. Any key set here overrides
// the role's default from ROLE_DEFAULTS when resolvePermissions merges them.
const permissionsSchema = new Schema({
  canCreate:              { type: Boolean },
  canEdit:                { type: Boolean },
  canDelete:              { type: Boolean },
  canApprove:             { type: Boolean },
  canExport:              { type: Boolean },
  canViewAll:             { type: Boolean },
  canManageUsers:         { type: Boolean },
  canViewAudit:           { type: Boolean },
  canManageSettings:      { type: Boolean },
  canEditInventory:       { type: Boolean },
  canSubmitFormRequests:  { type: Boolean },
  canReviewFormRequests:  { type: Boolean },
}, { _id: false });

const userSchema = new Schema({
  userId: { type: String, unique: true },  // "USR-4821" — auto-generated
  name:   { type: String, required: true, trim: true },
  email:  { type: String, required: true, unique: true, lowercase: true, trim: true },
  role: {
    type: String,
    required: true,
    // Ranking (low → high): Field Agent < Sub-Head < Supervisor < GIS Analyst < System Admin.
    // Sub-Head sits just above Field Agent and exists to verify/approve field
    // captures before they're treated as part of the official registry.
    // MDA Agent sits outside this ranking entirely — it's an external role
    // scoped to exactly one MDA (see `mda` field below), not part of the
    // internal FPAM hierarchy or the division system.
    enum: ['Field Agent', 'Sub-Head', 'Supervisor', 'GIS Analyst', 'System Admin', 'MDA Agent'],
  },

  // Which MDA this user belongs to. Only meaningful for role: 'MDA Agent' —
  // scopes every form-request query/mutation to this one MDA server-side
  // (see routes/form_requests_routes.js: scopeQuery()). Left null for every
  // other role.
  mda: { type: String, default: null },

  // Division scopes which part of the platform the user can access.
  // Supervisor and System Admin are cross-division (value: 'All').
  // Field Agent is restricted to their assigned division only.
  // MDA Agent has no division at all (null) — they operate outside FPAM's
  // internal division structure entirely, so null must be a valid enum
  // value here, not just an unset/default state.
  division: {
    type: String,
    enum: [
      'All',
      'Assets & Condition',
      'Monitoring & Evaluation',
      'Planning & Design',
      'Rehabilitation & Restoration',
      'Building Training & Maintenance',
      null,
    ],
    default: 'Assets & Condition',
  },

  password: { type: String, required: true, select: false },

  color: { type: String, default: '#3B82F6' },  // avatar hex

  // Geographic scope
  zone:   String,
  states: [String],
  lgas:   [String],

  // Per-user permission overrides (merged with RoleConfig defaults)
  permissions: { type: permissionsSchema, default: {} },

  stats: {
    assetsCreated: { type: Number, default: 0 },
    lastActiveAt:  Date,
    totalActions:  { type: Number, default: 0 },
  },

  isActive:  { type: Boolean, default: true },
  createdBy: { type: Types.ObjectId, ref: 'User' },

  // One-time password reset token
  resetToken:        { type: String, select: false },
  resetTokenExpires: { type: Date,   select: false },

  // Mobile number for SMS alerts (optional).
  phone: { type: String, trim: true, default: null },

  // Bumped to sign the user out everywhere: every issued token carries the
  // version it was issued at, and auth rejects tokens from older versions.
  // Bumped on password change/reset, deactivation and "sign out everywhere".
  tokenVersion: { type: Number, default: 0 },

  // Two-step sign-in (TOTP authenticator app).
  mfa: {
    enabled:       { type: Boolean, default: false },
    secret:        { type: String, select: false },
    pendingSecret: { type: String, select: false },   // during setup, until confirmed
    recoveryCodes: { type: [String], select: false }, // sha256 hashes; each works once
    enabledAt:     Date,
  },
}, {
  timestamps: true,
});

// ── Indexes ──────────────────────────────────────────────────────────────────
userSchema.index({ role: 1 });
userSchema.index({ division: 1 });
userSchema.index({ mda: 1 });
userSchema.index({ isActive: 1 });

// ── Pre-save: hash password ──────────────────────────────────────────────────
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// ── Auto-generate userId ─────────────────────────────────────────────────────
userSchema.pre('save', async function (next) {
  if (this.userId) return next();
  const count = await mongoose.model('User').countDocuments();
  this.userId = `USR-${(count + 1000).toString().padStart(4, '0')}`;
  next();
});

// ── Instance method: compare password ────────────────────────────────────────
userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

// ── Instance method: safe JSON (no password) ─────────────────────────────────
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.resetToken;
  delete obj.resetTokenExpires;
  if (obj.mfa) obj.mfa = { enabled: !!obj.mfa.enabled, enabledAt: obj.mfa.enabledAt };
  delete obj.tokenVersion;
  return obj;
};

module.exports = mongoose.model('User', userSchema);