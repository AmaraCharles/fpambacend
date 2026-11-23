'use strict';
// ── NEWS ──────────────────────────────────────────────────────────────────────
// Mount at: app.use('/api/news', require('./routes/news_routes'));
//
// Public (no sign-in):
//   GET    /api/news               — published articles, newest first (?limit=&page=&category=)
//   GET    /api/news/ticker        — headlines for the "Latest News" ticker
//   GET    /api/news/:slug         — one published article
// System Admin and Supervisor:
//   GET    /api/news/manage/all    — everything, drafts included
//   GET    /api/news/manage/:id/cover — cover image preview (drafts too)
//   POST   /api/news               — create (draft unless status: 'published')
//   PATCH  /api/news/:id           — edit / publish / unpublish
//   DELETE /api/news/:id
//   POST   /api/news/:id/cover     — upload a cover image (multipart field "photo")
//   DELETE /api/news/:id/cover
// Cover images are served by GET /api/public/photos/:fileId once published.

const router = require('express').Router();
const News = require('../models/News');
const { authenticate } = require('../middleware/auth');
const { resolvePermissions } = require('../middleware/resolvePermissions');
const { auditLog } = require('../middleware/auditMiddleware');
const { photoUploader } = require('../middleware/upload');
const { publicReadLimiter } = require('../middleware/rateLimiter');
const photoSvc = require('../services/photoService');

const NEWS_ROLES = ['System Admin', 'Supervisor'];
const canManageNews = req => NEWS_ROLES.includes(req.user.role);
function requireNews(req, res, next) {
  if (!canManageNews(req)) return res.status(403).json({ error: 'Only System Admins and Supervisors can manage news' });
  next();
}
const staff = [authenticate, resolvePermissions, requireNews];

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const coverUrl = n => (n.cover?.fileId ? `/public/photos/${n.cover.fileId}` : null);
function publicView(n, withBody) {
  const out = {
    slug: n.slug, title: n.title, category: n.category, summary: n.summary, byline: n.byline,
    publishedAt: n.publishedAt, cover: coverUrl(n), coverCaption: n.cover?.caption || '',
  };
  if (withBody) out.body = n.body;
  return out;
}

function slugify(title) {
  const base = String(title).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 70) || 'news';
  return base;
}
async function uniqueSlug(title, exceptId) {
  const base = slugify(title);
  let slug = base;
  for (let i = 2; await News.exists({ slug, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }); i++) slug = `${base}-${i}`;
  return slug;
}

function fields(b) {
  const out = {};
  if (b.title !== undefined) out.title = str(b.title, 200);
  if (b.category !== undefined) out.category = b.category;
  if (b.summary !== undefined) out.summary = str(b.summary, 400);
  if (b.body !== undefined) out.body = str(b.body, 30000);
  if (b.byline !== undefined) out.byline = str(b.byline, 200);
  if (b.coverCaption !== undefined) out['cover.caption'] = str(b.coverCaption, 200);
  if (b.inTicker !== undefined) out.inTicker = !!b.inTicker;
  return out;
}
const wrap = fn => async (req, res) => {
  try { await fn(req, res); }
  catch (err) { res.status(err.name === 'ValidationError' ? 422 : 500).json({ error: err.message }); }
};

// ── Public ───────────────────────────────────────────────────────────────────
router.get('/', publicReadLimiter, wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 50);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const q = { status: 'published' };
  if (req.query.category && News.CATEGORIES.includes(req.query.category)) q.category = req.query.category;
  const [items, total] = await Promise.all([
    News.find(q).sort({ publishedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    News.countDocuments(q),
  ]);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ news: items.map(n => publicView(n)), total, page, pages: Math.ceil(total / limit) });
}));

router.get('/ticker', publicReadLimiter, wrap(async (_req, res) => {
  const items = await News.find({ status: 'published', inTicker: true }, { title: 1, slug: 1, publishedAt: 1 })
    .sort({ publishedAt: -1 }).limit(10).lean();
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ items: items.map(n => ({ title: n.title, slug: n.slug })) });
}));

// ── Staff ────────────────────────────────────────────────────────────────────
router.get('/manage/all', ...staff, wrap(async (_req, res) => {
  const items = await News.find({}).sort({ updatedAt: -1 }).limit(500).lean();
  res.json({ news: items.map(n => ({ ...n, coverUrl: coverUrl(n) })), categories: News.CATEGORIES });
}));

// Cover preview for staff (drafts aren't served publicly).
router.get('/manage/:id/cover', ...staff, wrap(async (req, res) => {
  const n = await News.findById(req.params.id, { cover: 1 }).lean().catch(() => null);
  if (!n?.cover?.fileId || !(await photoSvc.streamPhoto(n.cover.fileId, res))) return res.status(404).end();
}));

router.get('/:slug', publicReadLimiter, wrap(async (req, res) => {
  const n = await News.findOne({ slug: String(req.params.slug), status: 'published' }).lean();
  if (!n) return res.status(404).json({ error: 'Article not found' });
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ article: publicView(n, true) });
}));

router.post('/', ...staff, auditLog('NEWS_CREATED', 'News'), wrap(async (req, res) => {
  const f = fields(req.body || {});
  if (!f.title) return res.status(422).json({ error: 'Give the article a title' });
  const publish = req.body?.status === 'published';
  if (publish && !f.body && !f.summary) return res.status(422).json({ error: 'Add a summary or body before publishing' });
  const caption = f['cover.caption']; delete f['cover.caption'];
  const n = await News.create({
    ...f, cover: { caption: caption || '' }, slug: await uniqueSlug(f.title),
    status: publish ? 'published' : 'draft', publishedAt: publish ? (req.body.publishedAt ? new Date(req.body.publishedAt) : new Date()) : null,
    createdBy: req.user._id, updatedBy: req.user._id,
  });
  res.locals.auditEntityId = n.slug;
  res.status(201).json({ news: { ...n.toObject(), coverUrl: coverUrl(n) } });
}));

router.patch('/:id', ...staff, auditLog('NEWS_UPDATED', 'News'), wrap(async (req, res) => {
  const n = await News.findById(req.params.id).catch(() => null);
  if (!n) return res.status(404).json({ error: 'Article not found' });
  const b = req.body || {};
  const f = fields(b);
  if (f.title !== undefined && !f.title) return res.status(422).json({ error: 'Give the article a title' });
  n.set(f);
  // Slug follows the title only while unpublished, so shared links keep working.
  if (f.title && n.status === 'draft') n.slug = await uniqueSlug(f.title, n._id);
  if (b.status === 'published' && n.status !== 'published') {
    if (!n.body && !n.summary) return res.status(422).json({ error: 'Add a summary or body before publishing' });
    n.status = 'published';
    n.publishedAt = b.publishedAt ? new Date(b.publishedAt) : new Date();
  } else if (b.status === 'draft') {
    n.status = 'draft';
  } else if (b.publishedAt && n.status === 'published') {
    n.publishedAt = new Date(b.publishedAt);
  }
  n.updatedBy = req.user._id;
  await n.save();
  res.locals.auditEntityId = n.slug;
  res.json({ news: { ...n.toObject(), coverUrl: coverUrl(n) } });
}));

router.delete('/:id', ...staff, auditLog('NEWS_DELETED', 'News'), wrap(async (req, res) => {
  const n = await News.findById(req.params.id).catch(() => null);
  if (!n) return res.status(404).json({ error: 'Article not found' });
  if (n.cover?.fileId) await photoSvc.deletePhoto(n.cover.fileId).catch(() => {});
  await n.deleteOne();
  res.locals.auditEntityId = n.slug;
  res.json({ ok: true });
}));

router.post('/:id/cover', ...staff, photoUploader.single('photo'), auditLog('NEWS_COVER_SET', 'News'), wrap(async (req, res) => {
  const n = await News.findById(req.params.id).catch(() => null);
  if (!n) return res.status(404).json({ error: 'Article not found' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const stored = await photoSvc.storePhoto(req.file, `news-${n._id}`, req.user._id.toString());
  const old = n.cover?.fileId;
  n.cover = { fileId: stored.fileId, caption: n.cover?.caption || '' };
  await n.save();
  if (old) await photoSvc.deletePhoto(old).catch(() => {});
  res.locals.auditEntityId = n.slug;
  res.json({ news: { ...n.toObject(), coverUrl: coverUrl(n) } });
}));

router.delete('/:id/cover', ...staff, wrap(async (req, res) => {
  const n = await News.findById(req.params.id).catch(() => null);
  if (!n) return res.status(404).json({ error: 'Article not found' });
  if (n.cover?.fileId) await photoSvc.deletePhoto(n.cover.fileId).catch(() => {});
  n.cover = { fileId: null, caption: n.cover?.caption || '' };
  await n.save();
  res.json({ news: { ...n.toObject(), coverUrl: null } });
}));

module.exports = router;
