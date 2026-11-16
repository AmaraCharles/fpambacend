'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

// Building Training & Maintenance division: planned (preventive) maintenance,
// maintenance work orders, and training sessions. Completing a work order
// writes an entry to the asset's maintenance log and, for a planned task,
// moves the plan's next due date on.

const FREQUENCIES = { Weekly: 7, Monthly: 30, Quarterly: 91, Biannual: 182, Annual: 365 };
const CATEGORIES = ['Electrical', 'Mechanical', 'Plumbing', 'Civil / structural', 'Cleaning & sanitation', 'Horticulture', 'Security', 'Fire safety', 'Generator & power', 'Other'];

const planSchema = new Schema({
  assetId:    { type: String, required: true },
  assetName:  { type: String, default: '' },
  task:       { type: String, required: true, maxlength: 200 },
  category:   { type: String, enum: CATEGORIES, default: 'Other' },
  frequency:  { type: String, enum: Object.keys(FREQUENCIES), required: true },
  nextDue:    { type: Date, required: true },
  lastDone:   { type: Date, default: null },
  assignedTo: { type: String, default: '' },
  notes:      { type: String, default: '' },
  active:     { type: Boolean, default: true },
  createdBy:  { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });
planSchema.index({ active: 1, nextDue: 1 });
planSchema.index({ assetId: 1 });

const WO_STATUSES = ['Open', 'In progress', 'Completed', 'Cancelled'];
const workOrderSchema = new Schema({
  ref:         { type: String, required: true, unique: true },  // WO-20261116-1A2B
  assetId:     { type: String, required: true },
  assetName:   { type: String, default: '' },
  title:       { type: String, required: true, maxlength: 200 },
  description: { type: String, default: '', maxlength: 4000 },
  category:    { type: String, enum: CATEGORIES, default: 'Other' },
  priority:    { type: String, enum: ['Low', 'Medium', 'High', 'Urgent'], default: 'Medium' },
  status:      { type: String, enum: WO_STATUSES, default: 'Open' },
  assignedTo:  { type: String, default: '' },
  dueDate:     { type: Date, default: null },
  cost:        { type: Number, min: 0, default: null },
  completedAt: { type: Date, default: null },
  completionNote: { type: String, default: '' },
  source: {
    type: { type: String, enum: ['manual', 'plan', 'report'], default: 'manual' },
    id:   { type: Types.ObjectId, default: null },
  },
  createdBy:     { type: Types.ObjectId, ref: 'User' },
  createdByName: { type: String, default: '' },
}, { timestamps: true });
workOrderSchema.index({ status: 1, dueDate: 1 });
workOrderSchema.index({ assetId: 1, createdAt: -1 });

const trainingSchema = new Schema({
  title:       { type: String, required: true, maxlength: 200 },
  topic:       { type: String, default: '' },
  date:        { type: Date, required: true },
  durationHours: { type: Number, min: 0, default: null },
  venue:       { type: String, default: '' },
  assetId:     { type: String, default: '' },    // building where it was held, if on the register
  assetName:   { type: String, default: '' },
  facilitator: { type: String, default: '' },
  attendees:   [{ name: { type: String, required: true }, organisation: { type: String, default: '' }, _id: false }],
  notes:       { type: String, default: '' },
  createdBy:   { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });
trainingSchema.index({ date: -1 });

module.exports = {
  MaintenancePlan: mongoose.model('MaintenancePlan', planSchema),
  WorkOrder:       mongoose.model('WorkOrder', workOrderSchema),
  TrainingSession: mongoose.model('TrainingSession', trainingSchema),
  FREQUENCIES, CATEGORIES, WO_STATUSES,
};
