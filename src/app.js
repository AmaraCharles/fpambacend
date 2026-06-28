'use strict';
const http        = require('http');
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const morgan      = require('morgan');

const env           = require('./config/env');
const { connectDB } = require('./config/db');
const { getRedis }  = require('./config/redis');
const { initRealtime } = require('./sockets/realtime');

// Routes
const authRoute      = require('./routes/auth');
const assetsRoute    = require('./routes/assets');
const photosRoute    = require('./routes/photos');
const excelRoute     = require('./routes/excel');
const spatialRoute   = require('./routes/spatial');
const analyticsRoute = require('./routes/analytics_routes');   // ← FIXED: was ./routes/analytics
const ocrRoute       = require('./routes/ocr');
const exportRoute    = require('./routes/export');
const documentsRoute = require('./routes/documents');
const usersRoute     = require('./routes/users');
const auditRoute     = require('./routes/audit');
const settingsRoute  = require('./routes/settings');

// ✅ MDA ROUTE ADDED
const mdaRoute       = require('./routes/mda_routes');

const app = express();

// ── Security & compression ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (origin, cb) => {
    const allowed = !origin
      || origin === env.CLIENT_URL
      ||origin === "https://fpam.vercel.app"
      ||origin === "https://fpam.fmhud.gov.ng"
      || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    cb(null, allowed);
  },
  credentials: true,
}));
app.use(compression());

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check (no auth) ────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date() }));

// ── API routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',      authRoute);
app.use('/api/assets',    assetsRoute);
app.use('/api/assets',    exportRoute);
app.use('/api/assets/spatial', spatialRoute);

// 👇 MDA ROUTE MOUNTED HERE
app.use('/api/mdas', mdaRoute);

// File sub-routes (mergeParams enabled in each router)
app.use('/api/assets/:assetId/photos',     photosRoute);
app.use('/api/assets/:assetId/documents', documentsRoute);
app.use('/api/assets/:assetId/excel',     excelRoute);

app.use('/api/analytics', analyticsRoute);   // ← now points to analytics_routes.js
app.use('/api/ocr',       ocrRoute);
app.use('/api/users/role-config', require('./routes/role_config_routes'));
app.use('/api/users',     usersRoute);
app.use('/api/audit',     auditRoute);
app.use('/api/settings',  settingsRoute);

// Extra asset routes (relationships, lifecycle, bulk-update, completeness)
app.use('/api/assets', require('./routes/asset_extras_routes'));

// Inspection routes
app.use('/api/inspections', require('./routes/inspection_routes'));
app.use('/api/assets/:assetId/inspections', require('./routes/inspection_routes'));

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const message = env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  if (status === 500) console.error('[Error]', err);

  res.status(status).json({ error: message });
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function start() {
  await connectDB();
  await mdaRoute.autoSeedMdas();   // seeds 31 MDAs on first run if collection empty

  const server = http.createServer(app);
  initRealtime(server);

  server.listen(env.PORT, () => {
    console.log(`[AssetSpatial] API running on port ${env.PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal) => {
    console.log(`[AssetSpatial] ${signal} received — shutting down`);
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

start().catch((err) => {
  console.error('[AssetSpatial] Failed to start:', err);
  process.exit(1);
});

module.exports = app;