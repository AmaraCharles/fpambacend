'use strict';
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { Schema, Types } = mongoose;

// ── Permissions sub-schema ────────────────────────────────────────────────────
// Keys match the short names used by the frontend (users.js / role_config_routes.js)
// and by resolvePermissions.js's ROLE_DEFAULTS. Any key set here overrides
// the role's default from ROLE_DEFAULTS when resolvePermissions merges them.
const permissionsSchema = new Schema({
  canCreate:         { type: Boolean },
  canEdit:           { type: Boolean },
  canDelete:         { type: Boolean },
  canApprove:        { type: Boolean },
  canExport:         { type: Boolean },
  canViewAll:        { type: Boolean },
  canManageUsers:    { type: Boolean },
  canViewAudit:      { type: Boolean },
  canManageSettings: { type: Boolean },
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
    enum: ['Field Agent', 'Sub-Head', 'Supervisor', 'GIS Analyst', 'System Admin'],
  },

  // Division scopes which part of the platform the user can access.
  // Supervisor and System Admin are cross-division (value: 'All').
  // Field Agent is restricted to their assigned division only.
  division: {
    type: String,
    enum: [
      'All',
      'Assets & Condition',
      'Monitoring & Evaluation',
      'Planning & Design',
      'Rehabilitation & Restoration',
      'Building Training & Maintenance',
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
}, {
  timestamps: true,
});

// ── Indexes ──────────────────────────────────────────────────────────────────
userSchema.index({ role: 1 });
userSchema.index({ division: 1 });
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
  return obj;
};

module.exports = mongoose.model('User', userSchema);