'use strict';
// ── PUBLIC (no sign-in) ───────────────────────────────────────────────────────
// Mount at: app.use('/api/public', require('./routes/public_routes'));
//
// GET  /api/public/assets/:id           — the few details printed on an asset's QR label
// POST /api/public/assets/:id/reports   — report a problem with an asset
// GET  /api/public/gallery              — assets staff chose to show on the website gallery
// GET  /api/public/photos/:fileId       — a gallery photo or a published news cover image
//
// Used by the page a scanned QR label opens (dashboard /a/<assetId>). Only
// non-sensitive fields are returned, and both endpoints are rate-limited per IP.

const crypto = require('crypto');
const router = require('express').Router();
const Asset = require('../models/Asset');
const PublicReport = require('../models/PublicReport');
const { idQuery } = require('../services/assetService');
const { publicReadLimiter, publicReportLimiter, publicPhotoLimiter } = require('../middleware/rateLimiter');
const notify = require('../services/notify');
const News = require('../models/News');
const photoSvc = require('../services/photoService');
const { Types } = require('mongoose');
const { BLOCKED_TYPES, generalPhotos } = require('./gallery_routes');

const PUBLIC_FIELDS = { assetId: 1, assetCode: 1, name: 1, type: 1, mda: 1, state: 1, lga: 1 };

function publicView(a) {
  return { assetId: a.assetId, assetCode: a.assetCode || null, name: a.name, type: a.type || '', mda: a.mda || '', state: a.state || '', lga: a.lga || '' };
}

router.get('/assets/:id', publicReadLimiter, async (req, res) => {
  try {
    const asset = await Asset.findOne(idQuery(req.params.id), PUBLIC_FIELDS).lean();
    if (!asset) return res.status(404).json({ error: 'No asset with that ID is on the register' });
    res.json({ asset: publicView(asset), categories: PublicReport.CATEGORIES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Gallery ──────────────────────────────────────────────────────────────────
// Viewer details only: name, type, state/LGA, caption and general photos.
// Never MDA, condition, values, coordinates, documents or M&E report photos.
router.get('/gallery', publicReadLimiter, async (_req, res) => {
  try {
    const assets = await Asset.find(
      { 'publicGallery.enabled': true, type: { $nin: BLOCKED_TYPES }, approvalStatus: { $in: ['Approved', null] } },
      { name: 1, type: 1, state: 1, lga: 1, 'publicGallery.caption': 1, photos: 1, 'meReports._id': 1 },
    ).sort({ 'publicGallery.updatedAt': -1 }).limit(200).lean();
    const items = assets.map(a => ({
      id: String(a._id),
      name: a.name, type: a.type || '', state: a.state || '', lga: a.lga || '',
      caption: a.publicGallery?.caption || '',
      photos: generalPhotos(a).slice(0, 8).map(p => `/public/photos/${p.fileId}`),
    })).filter(i => i.photos.length);
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/photos/:fileId', publicPhotoLimiter, async (req, res) => {
  try {
    if (!Types.ObjectId.isValid(req.params.fileId)) return res.status(404).end();
    const fileId = new Types.ObjectId(req.params.fileId);
    const asset = await Asset.findOne(
      { 'publicGallery.enabled': true, type: { $nin: BLOCKED_TYPES }, 'photos.fileId': fileId },
      { photos: 1, 'meReports._id': 1 },
    ).lean();
    const allowed = (asset && generalPhotos(asset).some(p => String(p.fileId) === String(fileId)))
      || await News.exists({ status: 'published', 'cover.fileId': fileId });
    if (!allowed) return res.status(404).end();
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');   // shown on the public site's own domain
    if (!(await photoSvc.streamPhoto(fileId, res))) res.status(404).end();
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: err.message }); }
});

const str = (v, max) => String(v ?? '').trim().slice(0, max);

function newRef() {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `RPT-${d}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

router.post('/assets/:id/reports', publicReportLimiter, async (req, res) => {
  try {
    const b = req.body || {};
    // Honeypot: a hidden field people never fill in. Bots that do get a normal
    // looking answer and nothing is stored.
    if (b.website) return res.status(201).json({ ref: newRef() });

    const category = str(b.category, 80);
    const description = str(b.description, 2000);
    const severity = ['Low', 'Medium', 'High'].includes(b.severity) ? b.severity : 'Medium';
    if (!PublicReport.CATEGORIES.includes(category)) return res.status(422).json({ error: 'Choose what kind of problem it is' });
    if (description.length < 10) return res.status(422).json({ error: 'Describe the problem in a sentence or two' });
    const email = str(b.email, 160);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(422).json({ error: 'That email address does not look right' });

    const asset = await Asset.findOne(idQuery(req.params.id), PUBLIC_FIELDS).lean();
    if (!asset) return res.status(404).json({ error: 'No asset with that ID is on the register' });

    const lat = Number(b.lat), lng = Number(b.lng);
    const location = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;

    let report;
    for (let attempt = 0; attempt < 3 && !report; attempt++) {
      try {
        report = await PublicReport.create({
          ref: newRef(), assetId: asset.assetId, assetName: asset.name, mda: asset.mda || '', state: asset.state || '',
          category, severity, description,
          reporter: { name: str(b.name, 120), phone: str(b.phone, 30), email },
          location, status: 'New', history: [{ status: 'New', by: 'Public', note: 'Reported via QR scan' }],
        });
      } catch (err) { if (err.code !== 11000) throw err; }   // ref collision: try another
    }
    notify.publicReportSubmitted(report);
    res.status(201).json({ ref: report.ref });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
