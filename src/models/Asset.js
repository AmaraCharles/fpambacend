'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

// ── File reference sub-schema ─────────────────────────────────────────────────
const fileRefSchema = new Schema({
  fileId:       { type: Types.ObjectId, required: true },
  filename:     String,
  originalname: String,
  mimeType:     String,
  contentType:  String,
  sizeBytes:    Number,
  length:       Number,
  capturedAt:   Date,
  uploadedAt:   { type: Date, default: Date.now },
}, { _id: true });

// ── Maintenance log sub-schema ────────────────────────────────────────────────
const maintenanceLogSchema = new Schema({
  date:     { type: Date, required: true },
  desc:     { type: String, required: true },
  tech:     String,
  cost:     { type: Number, min: 0 },
  amount:   Number,
  loggedBy: { type: Types.ObjectId, ref: 'User' },
}, { _id: true, timestamps: false });

// ── Condition history sub-schema ──────────────────────────────────────────────
const conditionHistorySchema = new Schema({
  from:      String,
  to:        String,
  changedAt: { type: Date, default: Date.now },
  changedBy: { type: Types.ObjectId, ref: 'User' },
}, { _id: false });

// ── Lifecycle history sub-schema ──────────────────────────────────────────────
const lifecycleHistorySchema = new Schema({
  from:      String,
  to:        String,
  at:        { type: Date, default: Date.now },
  by:        String,
  note:      String,
  document:  String,
}, { _id: false });

// ── M&E Report sub-schema ─────────────────────────────────────────────────────
const meTaskSchema = new Schema({
  label:      { type: String, required: true },
  percentage: { type: Number, min: 0, max: 100, default: 0 },
}, { _id: false });

const meReportSchema = new Schema({
  // Contract header
  contractNo:         String,
  contractorName:     String,
  contractorAddress:  String,
  contractSum:        Number,
  contractPeriod:     String,
  commencementDate:   Date,
  completionPeriod:   String,
  reportLocation:     String,

  // Report metadata
  reportType:   { type: String, enum: ['secretariat', 'nhp'], required: true },
  reportMonth:  { type: Number, min: 1, max: 12, required: true },
  reportYear:   { type: Number, required: true },

  // Task line items (% completion per activity)
  tasks:              [meTaskSchema],
  overallPercentage:  { type: Number, min: 0, max: 100, default: 0 },

  // General remarks
  labourRating:       { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  materialsRating:    { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  progressRating:     { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  workmanshipRating:  { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  otherComments:      String,

  // Chief Resident Architect sign-off
  craName:        String,
  craDesignation: String,
  craDate:        Date,

  // Clearance certificate (issued after satisfactory report)
  clearanceIssued:       { type: Boolean, default: false },
  clearanceDate:         Date,
  clearanceMonth:        String,
  satisfactory:          { type: Boolean, default: true },
  unsatisfactoryWorks:   String,
  facilityManagerName:   String,
  facilityManagerDesig:  String,
  facilityManagerDate:   Date,

  // Workflow
  status: {
    type:    String,
    enum:    ['Draft', 'Submitted', 'Cleared', 'Not Cleared'],
    default: 'Draft',
  },

  submittedBy: { type: Types.ObjectId, ref: 'User' },
  submittedAt: Date,
}, { _id: true, timestamps: true });

// ── Main asset schema ─────────────────────────────────────────────────────────
const assetSchema = new Schema({
  assetId: { type: String, required: true, unique: true },
  name:    { type: String, required: true, trim: true },

  type: {
    type:     String,
    required: true,
    enum: ['Infrastructure', 'Land / Property', 'Utility', 'Environmental', 'Equipment'],
  },
  geomType: {
    type:    String,
    enum:    ['Point', 'Polygon', 'Linear'],
    default: 'Point',
  },

  location: {
    type:        { type: String, default: 'Point', enum: ['Point'] },
    coordinates: { type: [Number], required: true },
  },

  geometry: { type: Schema.Types.Mixed },

  condition: { type: String, enum: ['Good', 'Fair', 'Poor', 'Critical'] },
  material:  String,
  elevation: Number,
  area:      Number,
  notes:     String,

  typeData: { type: Schema.Types.Mixed, default: {} },

  capturedBy: { type: Types.ObjectId, ref: 'User' },

  // ── Approval workflow ────────────────────────────────────────────────────
  // New captures from roles without auto-approve privilege sit as 'Pending'
  // until a Sub-Head, Supervisor, or System Admin reviews them. System Admin
  // captures are auto-approved at creation (see services/assetService.js).
  // Default stays 'Approved' so existing/legacy documents and bulk imports
  // that predate this field are never accidentally hidden from the registry.
  approvalStatus: {
    type:    String,
    enum:    ['Pending', 'Approved', 'Rejected'],
    default: 'Approved',
  },
  submittedBy:     { type: Types.ObjectId, ref: 'User' },  // who captured it, when it required review
  reviewedBy:      { type: Types.ObjectId, ref: 'User' },  // who approved/rejected it (or auto-approved it)
  reviewedAt:      Date,
  rejectionReason: String,

  // ── Classification ────────────────────────────────────────────────────────
  mda:    { type: String, default: '' },
  sector: {
    type: String,
    default: '',
    enum: [
      '',
      'Administration & Governance',
      'Defence & Security',
      'Education',
      'Health',
      'Infrastructure & Works',
      'Energy & Power',
      'Agriculture & Food Security',
      'Water Resources',
      'Transportation',
      'Finance & Economy',
      'Justice & Legal Affairs',
      'Environment',
      'Communications & Digital',
      'Social Development',
      'Science & Technology',
      'Trade & Investment',
      'Petroleum & Mineral Resources',
      'Labour & Employment',
      'Foreign Affairs',
      'Culture, Tourism & Sports',
    ],
  },

  state:   String,
  lga:     String,
  address: String,

  status: {
    type:    String,
    enum:    ['Active', 'Under Maintenance', 'Decommissioned', 'Disputed', 'Recovered'],
    default: 'Active',
  },

  // ── Assessment ────────────────────────────────────────────────────────────
  assessed: {
    type:    String,
    enum:    ['Assessed', 'Unassessed'],
    default: 'Unassessed',
  },

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  lifecycleStage: {
    type:    String,
    enum:    ['Draft', 'Active', 'Under Maintenance', 'Under Review', 'Scheduled for Disposal', 'Decommissioned'],
    default: 'Active',
  },
  lifecycleHistory: [lifecycleHistorySchema],
  lifecycleDocs:    [{ name: String, stage: String, at: { type: Date, default: Date.now } }],

  // ── Relationships ─────────────────────────────────────────────────────────
  parentId:  { type: String, default: null },                 // assetId of parent
  childIds:  { type: [String], default: [] },                // assetIds of children

  nextInspection:     Date,
  lastInspection:     Date,
  inspectionInterval: { type: Number, default: 365 },

  conditionHistory: [conditionHistorySchema],

  photos:    [fileRefSchema],
  documents: [fileRefSchema],

  xlDatasets: [{
    _id:          { type: Types.ObjectId, auto: true },
    fileId:       Types.ObjectId,
    filename:     String,
    originalname: String,
    contentType:  String,
    sizeBytes:    Number,
    length:       Number,
    rowCount:     Number,
    columns:      [String],
    uploadedAt:   { type: Date, default: Date.now },
  }],

  maintenanceLogs: [maintenanceLogSchema],

  // ── M&E Reports (Monitoring & Evaluation Division) ────────────────────────
  meReports: [meReportSchema],

  valuation: {
    amount:   Number,
    currency: { type: String, default: 'NGN' },
    valuedAt: Date,
    valuedBy: String,
    method: {
      type: String,
      enum: ['Replacement Cost', 'Market Comparable', 'Depreciated',
             'Market Value', 'Income Approach', 'Book Value', 'Professional Estimate'],
    },
    notes: String,
  },

  qrPayload: String,

  ocrSource: {
    filename:  String,
    engine:    { type: String, enum: ['tesseract', 'manual'] },
    rawText:   String,
    scannedAt: Date,
  },

  captureDate: { type: Date, default: Date.now },
}, {
  timestamps: true,
  toJSON:     { virtuals: true },
  toObject:   { virtuals: true },
});

// ── Virtuals ──────────────────────────────────────────────────────────────────
assetSchema.virtual('excel').get(function () {
  return (this.xlDatasets || []).map(d => ({
    ...d.toObject ? d.toObject() : d,
    _id:          d._id || d.fileId,
    originalname: d.originalname || d.filename,
    contentType:  d.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    length:       d.length || d.sizeBytes,
    uploadDate:   d.uploadedAt,
  }));
});

assetSchema.virtual('lat').get(function () {
  return this.location?.coordinates?.[1] ?? null;
});
assetSchema.virtual('lng').get(function () {
  return this.location?.coordinates?.[0] ?? null;
});

// ── Indexes ───────────────────────────────────────────────────────────────────
assetSchema.index({ location: '2dsphere' });
assetSchema.index({ type: 1, condition: 1 });
assetSchema.index({ state: 1, lga: 1 });
assetSchema.index({ mda: 1 });
assetSchema.index({ sector: 1 });
assetSchema.index({ capturedBy: 1 });
assetSchema.index({ status: 1 });
assetSchema.index({ captureDate: -1 });
assetSchema.index({ nextInspection: 1 });
assetSchema.index({ lifecycleStage: 1 });
assetSchema.index({ parentId: 1 });
assetSchema.index({ approvalStatus: 1 });
assetSchema.index({ submittedBy: 1 });
assetSchema.index({ 'maintenanceLogs.date': 1 });
assetSchema.index({ name: 'text', notes: 'text', address: 'text' });

module.exports = mongoose.model('Asset', assetSchema);