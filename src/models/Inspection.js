'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

const historySchema = new Schema({
  status: String,
  at:     { type: Date, default: Date.now },
  by:     String,
  note:   String,
}, { _id: false });

const inspectionSchema = new Schema({
  inspectionId:  { type: String, required: true, unique: true, index: true },
  assetId:       { type: String, required: true, index: true },
  assetName:     String,
  type: {
    type:    String,
    enum:    ['Routine', 'Condition Assessment', 'Post-Maintenance', 'Emergency', 'Annual'],
    default: 'Routine',
  },
  scheduledDate: { type: Date, required: true, index: true },
  assignedTo:    String,   // agent name (or user ID if you want to ref)
  assignedById:  { type: Types.ObjectId, ref: 'User' },
  notes:         String,

  status: {
    type:    String,
    enum:    ['Scheduled', 'Assigned', 'In Progress', 'Submitted', 'Approved', 'Rejected'],
    default: 'Scheduled',
    index:   true,
  },

  // Filled when agent submits
  report: {
    condition:       String,
    date:            Date,
    findings:        String,
    recommendations: String,
    submittedAt:     Date,
    submittedBy:     String,
  },

  // Filled on approval/rejection
  reviewedAt:      Date,
  reviewedBy:      String,
  rejectionReason: String,

  // ── Visit coding (v2, 2026) ────────────────────────────────────────────────
  // Assigned only on approval (see routes/inspection_routes.js POST
  // /:id/approve) — the initial field capture never counts as visit 1, and
  // a Submitted-but-not-yet-Approved inspection doesn't hold a number
  // either, so a later Rejected report never burns a visit slot.
  // visitSeq is scoped per asset (by its assetCode/assetId): the 1st
  // approved inspection for a given asset is visitSeq 1, its 2nd is 2, etc.
  // inspectionCode is the derived, human-readable projection of that:
  // {ASSET CODE}-INSP-{visitSeq}, e.g. FGN-FMWH-INF-008-2026-0031-INSP-02.
  // The asset's own code is never modified to add this — see
  // utils/assetCodeIndex.js buildInspectionCode().
  visitSeq:       { type: Number, default: null },
  inspectionCode: { type: String, default: null },

  history: [historySchema],
  createdBy: String,
}, {
  timestamps: true,
});

// Auto-generate inspectionId. Must run on pre('validate'), not pre('save'):
// Mongoose validates before save hooks run, so with the old pre('save') the
// required inspectionId was always missing at validation time and every
// POST /api/inspections failed with a 500.
inspectionSchema.pre('validate', async function () {
  if (this.inspectionId) return;
  const last = await mongoose.model('Inspection')
    .findOne({ inspectionId: /^INS-[0-9A-Z]+$/ }, { inspectionId: 1 })
    .sort({ createdAt: -1 }).lean();
  const prev = last ? parseInt(last.inspectionId.slice(4), 36) : NaN;
  const num  = Number.isFinite(prev) ? prev + 1 : 1000;
  this.inspectionId = 'INS-' + num.toString(36).toUpperCase();
});

inspectionSchema.index({ assetId: 1, visitSeq: 1 });

module.exports = mongoose.model('Inspection', inspectionSchema);