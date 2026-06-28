'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const ACTIONS = [
  'ASSET_CREATED', 'ASSET_UPDATED', 'ASSET_DELETED',
  'ASSET_SUBMITTED', 'ASSET_APPROVED', 'ASSET_REJECTED',
  // PHOTO_UPLOADED / EXCEL_UPLOADED are the actual strings emitted by
  // routes/assets.js's auditLog() calls. PHOTO_ATTACHED / EXCEL_ATTACHED /
  // PHOTO_DELETED / EXCEL_DETACHED are kept too in case anything else in
  // the codebase already uses them — extra unused enum values are harmless,
  // but a *missing* one means AuditLog.create() silently fails validation
  // (auditMiddleware.js swallows that error to console only, so the upload
  // itself still succeeds — it just never gets logged).
  'PHOTO_UPLOADED', 'PHOTO_ATTACHED', 'PHOTO_DELETED',
  'EXCEL_UPLOADED', 'EXCEL_ATTACHED', 'EXCEL_DETACHED',
  'DOCUMENT_UPLOADED', 'DOCUMENT_DELETED',
  'MAINTENANCE_LOGGED', 'MAINTENANCE_DELETED',
  'VALUATION_UPDATED',
  'USER_CREATED', 'USER_UPDATED', 'USER_REMOVED',
  'USER_LOGIN', 'USER_LOGOUT',
  'EXPORT', 'BULK_DELETE', 'BULK_EXPORT',
  'OCR_SCAN', 'OCR_IMPORT',
  'SETTINGS_CHANGED',
  'ROLE_CONFIG_CHANGED',
];

const auditSchema = new Schema({
  action:     { type: String, required: true, enum: ACTIONS },
  entityId:   String,
  entityType: { type: String, enum: ['Asset', 'User', 'System', 'RoleConfig'] },
  performedBy: { type: Types.ObjectId, ref: 'User' },
  detail:     String,
  ipAddress:  String,
  userAgent:  String,
  metadata:   Schema.Types.Mixed,
  ts:         { type: Date, default: Date.now },
}, {
  versionKey: false,
});

auditSchema.index({ ts: -1 });
auditSchema.index({ entityId: 1, ts: -1 });
auditSchema.index({ performedBy: 1 });
auditSchema.index({ action: 1 });

module.exports = mongoose.model('AuditLog', auditSchema);
module.exports.ACTIONS = ACTIONS;