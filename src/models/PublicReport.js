'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

// Problems reported by members of the public, usually by scanning the QR label
// on an asset (dashboard route /a/<assetId>). Each report goes to the asset's
// MDA (their MDA Agents) and to FPAM approvers, and is worked through
// New → Acknowledged → In progress → Resolved (or Dismissed).
const CATEGORIES = ['Damage or disrepair', 'Safety hazard', 'Illegal occupation or encroachment', 'Vandalism or theft', 'Sanitation or refuse', 'Other'];
const STATUSES = ['New', 'Acknowledged', 'In progress', 'Resolved', 'Dismissed'];

const historySchema = new Schema({
  status: { type: String, enum: STATUSES },
  note:   { type: String, default: '' },
  by:     { type: String, default: '' },
  at:     { type: Date, default: Date.now },
}, { _id: false });

const publicReportSchema = new Schema({
  ref:       { type: String, required: true, unique: true },   // e.g. RPT-20261116-4F2A
  assetId:   { type: String, required: true },
  assetName: { type: String, default: '' },
  mda:       { type: String, default: '' },
  state:     { type: String, default: '' },
  category:  { type: String, enum: CATEGORIES, required: true },
  severity:  { type: String, enum: ['Low', 'Medium', 'High'], default: 'Medium' },
  description: { type: String, required: true, maxlength: 2000 },
  // Optional; never shown publicly.
  reporter: {
    name:  { type: String, default: '', maxlength: 120 },
    phone: { type: String, default: '', maxlength: 30 },
    email: { type: String, default: '', maxlength: 160 },
  },
  location: { lat: Number, lng: Number },                     // the reporter's phone location, if shared
  status:   { type: String, enum: STATUSES, default: 'New' },
  history:  [historySchema],
  workOrderId: { type: Types.ObjectId, default: null },        // set when a maintenance work order is raised
}, { timestamps: true });

publicReportSchema.index({ mda: 1, status: 1, createdAt: -1 });
publicReportSchema.index({ assetId: 1, createdAt: -1 });

publicReportSchema.statics.CATEGORIES = CATEGORIES;
publicReportSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.model('PublicReport', publicReportSchema);
