'use strict';
const mongoose = require('mongoose');
const { Schema, Types } = mongoose;

// News and press releases for the public website (news.html and the "Latest
// News" ticker on every public page). Written on the dashboard by staff with
// news rights (routes/news_routes.js). Body is plain text: a blank line starts
// a new paragraph, "## " a heading, "> " a quote.
const CATEGORIES = ['Press Release', 'Announcement', 'Project Update', 'Event', 'Notice'];

const newsSchema = new Schema({
  title:    { type: String, required: true, trim: true, maxlength: 200 },
  slug:     { type: String, required: true, unique: true },
  category: { type: String, enum: CATEGORIES, default: 'Press Release' },
  summary:  { type: String, default: '', maxlength: 400 },
  body:     { type: String, default: '', maxlength: 30000 },
  byline:   { type: String, default: '', maxlength: 200 },        // e.g. "Director, Press & Public Relations"
  cover: {
    fileId:  { type: Types.ObjectId, default: null },             // in the photos GridFS bucket
    caption: { type: String, default: '', maxlength: 200 },
  },
  status:      { type: String, enum: ['draft', 'published'], default: 'draft' },
  publishedAt: { type: Date, default: null },
  inTicker:    { type: Boolean, default: true },                  // show the headline in the ticker
  createdBy:   { type: Types.ObjectId, ref: 'User' },
  updatedBy:   { type: Types.ObjectId, ref: 'User' },
}, { timestamps: true });

newsSchema.index({ status: 1, publishedAt: -1 });

newsSchema.statics.CATEGORIES = CATEGORIES;

module.exports = mongoose.model('News', newsSchema);
