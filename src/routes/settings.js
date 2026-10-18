'use strict';
const router   = require('express').Router();
const Settings = require('../models/Settings');
const { authenticate, requireRole } = require('../middleware/auth');
const { auditLog } = require('../middleware/auditMiddleware');

// GET /api/settings
router.get('/', authenticate, async (req, res, next) => {
  try {
    let settings = await Settings.findOne({ _singleton: 'global' }).lean();
    if (!settings) settings = await Settings.create({});
    res.json({ settings });
  } catch (err) { next(err); }
});

// PUT /api/settings
router.put('/',
  authenticate, requireRole('System Admin'),
  auditLog('SETTINGS_CHANGED', 'System'),
  async (req, res, next) => {
    try {
      // Only real settings fields — the body used to be $set wholesale, so
      // a client could overwrite _singleton, timestamps, etc.
      const ALLOWED = ['platformName', 'organisation', 'coordinateSystem', 'defaultMapCenter',
                       'defaultZoom', 'featureToggles', 'exportFormats'];
      const update = {};
      for (const k of ALLOWED) if (req.body[k] !== undefined) update[k] = req.body[k];
      const settings = await Settings.findOneAndUpdate(
        { _singleton: 'global' },
        { $set: { ...update, updatedBy: req.user._id } },
        { new: true, upsert: true }
      ).lean();
      res.json({ settings });
    } catch (err) { next(err); }
  }
);

module.exports = router;
