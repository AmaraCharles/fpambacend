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
  // Emitted by routes that were added later but never registered here, so
  // every one of these was rejected by validation and silently not logged.
  'ASSET_LINKED', 'ASSET_UNLINKED', 'LIFECYCLE_TRANSITION', 'BULK_UPDATE',
  'INSPECTION_SCHEDULED', 'INSPECTION_SUBMITTED', 'INSPECTION_APPROVED', 'INSPECTION_REJECTED',
  'INVENTORY_ITEM_ADDED', 'INVENTORY_ITEM_UPDATED', 'INVENTORY_ITEM_DELETED',
  'INVENTORY_IMPORTED', 'INVENTORY_EXPORTED',
  'ME_REPORT_SUBMITTED', 'ME_REPORT_UPDATED', 'ME_REPORT_DELETED',
  'FORM_REQUEST_SUBMITTED', 'FORM_REQUEST_UPDATED', 'FORM_REQUEST_ATTACHMENT_ADDED', 'FORM_REQUEST_DELETED',
  'CERTIFICATE_ISSUED', 'CERTIFICATE_PHYSICAL_COPY_ISSUED',
];

const auditSchema = new Schema({
  action:     { type: String, required: true, enum: ACTIONS },
  entityId:   String,
  entityType: { type: String, enum: ['Asset', 'User', 'System', 'RoleConfig', 'Inspection', 'FormRequest'] },
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