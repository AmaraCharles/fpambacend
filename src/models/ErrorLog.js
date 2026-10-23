'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

// Server 500s and browser errors reported by the dashboard, for the System
// health page. Kept 30 days.
const errorLogSchema = new Schema({
  source:    { type: String, enum: ['server', 'client'], required: true },
  message:   { type: String, required: true },
  stack:     String,
  url:       String,          // request path (server) or page URL (client)
  method:    String,
  status:    Number,
  user:      { type: Types.ObjectId, ref: 'User' },
  userAgent: String,
  ip:        String,
  release:   String,          // dashboard build id, when the client sends one
  at:        { type: Date, default: Date.now },
}, { versionKey: false });

errorLogSchema.index({ at: -1 });
errorLogSchema.index({ at: 1 }, { expireAfterSeconds: 30 * 86400 });

module.exports = mongoose.model('ErrorLog', errorLogSchema);
