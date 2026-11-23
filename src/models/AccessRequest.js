'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

// "Request access" submissions from the public site's register.html. System
// Admins review them on the dashboard (Users → Access requests): approve by
// creating the account, or decline with a reason.
const ROLES = ['Field Agent', 'Sub-Head', 'Supervisor', 'GIS Analyst'];

const accessRequestSchema = new Schema({
  name:          { type: String, required: true, trim: true, maxlength: 120 },
  email:         { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
  organisation:  { type: String, required: true, trim: true, maxlength: 200 },
  requestedRole: { type: String, enum: ROLES, default: 'Field Agent' },
  reason:        { type: String, default: '', maxlength: 1000 },
  status:        { type: String, enum: ['pending', 'approved', 'declined'], default: 'pending' },
  note:          { type: String, default: '', maxlength: 500 },     // decline reason / admin note
  decidedBy:     { type: Types.ObjectId, ref: 'User', default: null },
  decidedByName: { type: String, default: '' },
  decidedAt:     { type: Date, default: null },
  userId:        { type: Types.ObjectId, ref: 'User', default: null },  // account created on approval
}, { timestamps: true });

accessRequestSchema.index({ status: 1, createdAt: -1 });
accessRequestSchema.index({ email: 1, status: 1 });

accessRequestSchema.statics.ROLES = ROLES;

module.exports = mongoose.model('AccessRequest', accessRequestSchema);
