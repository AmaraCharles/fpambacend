'use strict';
// In-app notifications for the signed-in user.
//   GET    /api/notifications           — latest 50 + unread count
//   POST   /api/notifications/:id/read  — mark one read
//   POST   /api/notifications/read-all  — mark all read
//   DELETE /api/notifications           — clear all
const router = require('express').Router();
const { Types } = require('mongoose');
const Notification = require('../models/Notification');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const [notifications, unread] = await Promise.all([
      Notification.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50).lean(),
      Notification.countDocuments({ user: req.user._id, readAt: null }),
    ]);
    res.json({ notifications, unread });
  } catch (err) { next(err); }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await Notification.updateMany({ user: req.user._id, readAt: null }, { readAt: new Date() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/read', async (req, res, next) => {
  try {
    if (!Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ error: 'Not found' });
    await Notification.updateOne({ _id: req.params.id, user: req.user._id }, { readAt: new Date() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/', async (req, res, next) => {
  try {
    await Notification.deleteMany({ user: req.user._id });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
