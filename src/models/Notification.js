'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

// In-app notifications, one document per recipient. Created by
// services/notify.js alongside the emails, and pushed live over socket.io.
const notificationSchema = new Schema({
  user:   { type: Types.ObjectId, ref: 'User', required: true },
  type:   { type: String, required: true },        // e.g. ASSET_DECIDED
  title:  { type: String, required: true },
  body:   { type: String, default: '' },
  link:   { type: String, default: null },          // dashboard route, e.g. /assets/AST-1001
  icon:   { type: String, default: 'fa-bell' },
  color:  { type: String, default: '#4A90D9' },
  readAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

notificationSchema.index({ user: 1, createdAt: -1 });
// Old notifications clean themselves up after 90 days.
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });

module.exports = mongoose.model('Notification', notificationSchema);
