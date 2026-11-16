'use strict';
// ── PUBLIC (no sign-in) ───────────────────────────────────────────────────────
// Mount at: app.use('/api/public', require('./routes/public_routes'));
//
// GET  /api/public/assets/:id           — the few details printed on an asset's QR label
// POST /api/public/assets/:id/reports   — report a problem with an asset
//
// Used by the page a scanned QR label opens (dashboard /a/<assetId>). Only
// non-sensitive fields are returned, and both endpoints are rate-limited per IP.

const crypto = require('crypto');
const router = require('express').Router();
const Asset = require('../models/Asset');
const PublicReport = require('../models/PublicReport');
const { idQuery } = require('../services/assetService');
const { publicReadLimiter, publicReportLimiter } = require('../middleware/rateLimiter');
const notify = require('../services/notify');

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
