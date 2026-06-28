'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const defaultsSchema = new Schema({
  canCreateAssets:   { type: Boolean, default: false },
  canEditAssets:     { type: Boolean, default: false },
  canDeleteAssets:   { type: Boolean, default: false },
  canApproveAssets:  { type: Boolean, default: false },
  canExportData:     { type: Boolean, default: false },
  canRunOCR:         { type: Boolean, default: false },
  canManageUsers:    { type: Boolean, default: false },
  canViewAnalytics:  { type: Boolean, default: false },
  canViewAuditLog:   { type: Boolean, default: false },
  canChangeSettings: { type: Boolean, default: false },
  canBulkDelete:     { type: Boolean, default: false },
  canBulkExport:     { type: Boolean, default: false },
  maxPhotosPerAsset: { type: Number,  default: 50    },
  maxAssetsPerDay:   { type: Number,  default: null  },
}, { _id: false });

const roleConfigSchema = new Schema({
  role: {
    type: String,
    required: true,
    unique: true,
    enum: ['Field Agent', 'Sub-Head', 'Supervisor', 'GIS Analyst', 'System Admin'],
  },
  defaults:  { type: defaultsSchema, default: () => ({}) },
  updatedBy: { type: Types.ObjectId, ref: 'User' },
}, {
  timestamps: true,
});

// Factory defaults per role
roleConfigSchema.statics.FACTORY_DEFAULTS = {
  'Field Agent': {
    canCreateAssets:   true,
    canEditAssets:     false,
    canDeleteAssets:   false,
    canApproveAssets:  false,
    canExportData:     false,
    canRunOCR:         true,
    canManageUsers:    false,
    canViewAnalytics:  false,
    canViewAuditLog:   false,
    canChangeSettings: false,
    canBulkDelete:     false,
    canBulkExport:     false,
    maxPhotosPerAsset: 50,
    maxAssetsPerDay:   100,
  },
  // Sub-Head — one rung above Field Agent. Can capture assets like a Field
  // Agent, but also reviews/approves (or rejects) captures submitted by
  // Field Agents before they count as verified registry entries.
  'Sub-Head': {
    canCreateAssets:   true,
    canEditAssets:     false,
    canDeleteAssets:   false,
    canApproveAssets:  true,
    canExportData:     false,
    canRunOCR:         true,
    canManageUsers:    false,
    canViewAnalytics:  false,
    canViewAuditLog:   false,
    canChangeSettings: false,
    canBulkDelete:     false,
    canBulkExport:     false,
    maxPhotosPerAsset: 50,
    maxAssetsPerDay:   null,
  },
  'Supervisor': {
    canCreateAssets:   true,
    canEditAssets:     true,
    canDeleteAssets:   false,
    canApproveAssets:  true,
    canExportData:     true,
    canRunOCR:         true,
    canManageUsers:    false,
    canViewAnalytics:  true,
    canViewAuditLog:   false,
    canChangeSettings: false,
    canBulkDelete:     false,
    canBulkExport:     true,
    maxPhotosPerAsset: 50,
    maxAssetsPerDay:   null,
  },
  'GIS Analyst': {
    canCreateAssets:   false,
    canEditAssets:     false,
    canDeleteAssets:   false,
    canApproveAssets:  false,
    canExportData:     true,
    canRunOCR:         true,
    canManageUsers:    false,
    canViewAnalytics:  true,
    canViewAuditLog:   true,
    canChangeSettings: false,
    canBulkDelete:     false,
    canBulkExport:     true,
    maxPhotosPerAsset: 50,
    maxAssetsPerDay:   null,
  },
  'System Admin': {
    canCreateAssets:   true,
    canEditAssets:     true,
    canDeleteAssets:   true,
    canApproveAssets:  true,
    canExportData:     true,
    canRunOCR:         true,
    canManageUsers:    true,
    canViewAnalytics:  true,
    canViewAuditLog:   true,
    canChangeSettings: true,
    canBulkDelete:     true,
    canBulkExport:     true,
    maxPhotosPerAsset: null,
    maxAssetsPerDay:   null,
  },
};

module.exports = mongoose.model('RoleConfig', roleConfigSchema);