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
  // Set when a photo is uploaded as part of an M&E report submission
  // (routes/me_routes.js / me.html saveReport()) — lets the report's view
  // modal show only the photos captured for that specific report, rather
  // than the asset's entire photo gallery.
  meReportId:   { type: Types.ObjectId, default: null },
}, { _id: true });

// ── Maintenance log sub-schema ────────────────────────────────────────────────
const maintenanceLogSchema = new Schema({
  date:         { type: Date, required: true },
  desc:         { type: String, required: true },
  tech:         String,
  cost:         { type: Number, min: 0 },
  amount:       Number,
  loggedBy:     { type: Types.ObjectId, ref: 'User' },
  // M&E clearance certificate link (set when clearance is issued from me.html)
  meReportId:   String,
  meReportLink: String,
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

// ── Inventory item sub-schema ─────────────────────────────────────────────────
// Mirrors the standard FPAM condition-assessment inventory sheet:
// INTERNAL/EXTERNAL | ROOM NAME/NUMBERS | FLOOR LEVEL | CATEGORY | ITEM |
// DESCRIPTION | ROOM DIMENSION | BRAND NAME | QUANTITY | QUANTITY NOT
// FUNCTIONING | DIMENSION OF DAMAGES/DEFECT | DEFECTS/FAULT (Y/N) | COMMENT
const inventoryItemSchema = new Schema({
  location: {
    type:    String,
    enum:    ['INTERNAL', 'EXTERNAL'],
    default: 'INTERNAL',
  },
  roomName:               String,   // "ROOM NAME / NUMBERS"
  floorLevel:             String,
  category: {
    type:    String,
    enum:    ['MECHANICAL', 'ELECTRICAL', 'STRUCTURAL', 'OTHER'],
    default: 'OTHER',
  },
  item:                   String,
  description:            String,
  roomDimension:          String,
  brandName:              String,
  quantity:               { type: Number, min: 0, default: 0 },
  quantityNotFunctioning: { type: Number, min: 0, default: 0 },
  dimensionOfDamage:      String,
  hasDefect:              { type: Boolean, default: false }, // Y/N column
  comment:                String, // free text: REPLACE / GOOD / SERVICE / etc.

  // Provenance — which uploaded file this row came from, so the digital
  // record always traces back to the original submitted sheet.
  sourceFileId: Types.ObjectId,
  sourceRow:    Number,   // 1-indexed row number in the source sheet, for audit
  sourceSheet:  String,   // worksheet name, for multi-sheet imports

  addedBy:  { type: Types.ObjectId, ref: 'User' },
  editedBy: { type: Types.ObjectId, ref: 'User' },
}, { _id: true, timestamps: true });

// ── M&E report sub-schema ─────────────────────────────────────────────────────
// Embedded monthly progress report + clearance certificate, written/read by
// routes/me_routes.js. Two variants share this shape: 'secretariat' (10 task
// items) and 'nhp' (9 task items) — see SECRETARIAT_TASKS/NHP_TASKS in that
// route file for the canonical task labels.
const meReportSchema = new Schema({
  // Contract header
  contractNo:        String,
  contractorName:     String,
  contractorAddress:  String,
  contractSum:        Number,
  contractPeriod:     String,
  commencementDate:   String,
  completionPeriod:   String,
  reportLocation:     String,

  // Report identity
  // 'others' = custom task list (used by me.html), previously only saved
  // because validation was skipped.
  reportType:  { type: String, enum: ['secretariat', 'nhp', 'others'], required: true },
  reportMonth: { type: Number, min: 1, max: 12, required: true },
  reportYear:  { type: Number, required: true },

  // Task progress
  tasks: [{
    _id:        false,
    label:      String,
    percentage: { type: Number, min: 0, max: 100, default: 0 },
  }],
  overallPercentage: { type: Number, min: 0, max: 100, default: 0 },

  // Ratings
  labourRating:      { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  materialsRating:   { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  progressRating:    { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  workmanshipRating: { type: String, enum: ['Very Good', 'Good', 'Fair', 'Poor'] },
  otherComments:     String,

  // CRA (Chief Resident Architect) sign-off
  craName:        String,
  craDesignation: String,
  craDate:        String,

  // Clearance certificate
  clearanceIssued:      { type: Boolean, default: false },
  clearanceDate:        Date,
  clearanceMonth:       String,
  satisfactory:         Boolean,
  unsatisfactoryWorks:  String,
  facilityManagerName:  String,
  facilityManagerDesig: String,
  facilityManagerDate:  String,

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

  // Structured FGN-{MDA}-{TYPE}-{BRANCH}-{YEAR}-{SEQ} code (see utils/assetCodeIndex.js).
  // sparse:true is required alongside unique:true — legacy assets that
  // predate this field (or haven't been backfilled by migrateAssetCodes.js
  // yet) will have assetCode === undefined, and a plain unique index would
  // reject every doc after the first one with a missing value.
  //
  // NOTE (v2, 2026): this field was referenced throughout assetService.js
  // and migrateAssetCodes.js from day one, but was never actually declared
  // on the schema — Mongoose's default strict mode silently dropped it on
  // every .save()/bulkWrite() before it reached MongoDB. Every asset coded
  // prior to this fix needs migrateAssetCodes.js re-run to actually persist.
  assetCode: { type: String, unique: true, sparse: true, index: true },

  name:    { type: String, required: true, trim: true },

  type: {
    type:     String,
    required: true,
    enum: [
      'Infrastructure', 'Land / Property', 'Utility', 'Environmental', 'Equipment', 'Monument',
      'Administrative Office', 'Residential', 'Hospital', 'School', 'Laboratory',
      'Warehouse', 'Court', 'Security Facility',
    ],
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

  // ── Duplicate-name guard (v2, 2026) ──────────────────────────────────────
  // Scoped to name + state + MDA — two assets in the same state under the
  // same MDA can't share a name, but the same generic name (e.g. "Pencil")
  // is allowed to recur freely elsewhere. Deliberately excludes child/
  // component assets (parentId set): a "Mathematics Set" child literally
  // named "Pencil" is expected to collide in name with another parent's
  // "Pencil" in the same state+MDA, and that's correct, not a duplicate
  // capture — child identity is already disambiguated by its -Cxx code.
  // Computed automatically in the pre('validate') hook below; never set
  // this directly. null/undefined is excluded from the partial unique
  // index, so legacy assets missing state/mda are never blocked by this.
  dupKey: { type: String, default: null },

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
  // See utils/assetCodeIndex.js buildChildCode() — a linked child's assetCode
  // becomes {parentAssetCode}-C{seq}, so this parentId/childIds pair remains
  // the source of truth while the code is a human-readable projection of it.
  parentId:  { type: String, default: null },                 // assetId of parent
  childIds:  { type: [String], default: [] },                // assetIds of children

  nextInspection:     Date,
  lastInspection:     Date,
  inspectionInterval: { type: Number, default: 365 },
  // Cached count of Approved formal inspections (capture itself never counts
  // — see routes/inspection_routes.js POST /:id/approve). Denormalised here
  // purely for a fast "Inspected N×" badge without a separate Inspection
  // query on every asset list render. The full per-visit INSP-xx codes live
  // on the Inspection documents themselves (model/Inspection.js).
  inspectionCount: { type: Number, default: 0 },

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

  // ── Inventory / Condition Assessment ─────────────────────────────────────
  // Structured replication of the FPAM inventory sheet — see inventoryItemSchema
  // above. Populated either manually (Inventory tab) or via Excel import
  // (routes/inventory_routes.js: import-preview → import-commit).
  inventoryItems: [inventoryItemSchema],

  // ── M&E Monthly Progress Reports / Clearance Certificates ────────────────
  // See meReportSchema above. Written/read entirely by routes/me_routes.js.
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

// ── Duplicate-name key computation ─────────────────────────────────────────────
// Recomputed on every validate pass so it always reflects the current
// name/state/mda/parentId, whether this is a new doc or an edit via
// asset.save(). NOTE: this hook does NOT fire on Model.findOneAndUpdate()/
// updateOne() — those bypass document middleware entirely. assetService.js's
// updateAsset() replicates this exact logic manually before those calls;
// keep the two in sync if this ever changes.
function computeDupKey(doc) {
  if (doc.parentId) return null;              // children are exempt — see field comment above
  if (!doc.name || !doc.state || !doc.mda) return null;
  return [doc.name, doc.state, doc.mda].map(s => String(s).trim().toLowerCase()).join('|');
}
assetSchema.pre('validate', function () {
  this.dupKey = computeDupKey(this);
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
assetSchema.index({ childIds: 1 });
// Partial: only assets with a real dupKey (non-child, name+state+mda all
// present) participate — legacy/incomplete assets and child components are
// excluded entirely rather than colliding on a shared null/undefined value.
assetSchema.index(
  { dupKey: 1 },
  { unique: true, partialFilterExpression: { dupKey: { $type: 'string' } }, name: 'uniq_name_state_mda' }
);
assetSchema.index({ approvalStatus: 1 });
assetSchema.index({ submittedBy: 1 });
assetSchema.index({ 'maintenanceLogs.date': 1 });
assetSchema.index({ 'meReports.status': 1 });
assetSchema.index({ 'meReports.reportYear': 1, 'meReports.reportMonth': 1 });
assetSchema.index({ 'inventoryItems.category': 1 });
assetSchema.index({ 'inventoryItems.hasDefect': 1 });
assetSchema.index({ name: 'text', notes: 'text', address: 'text' });

module.exports = mongoose.model('Asset', assetSchema);