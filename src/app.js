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
const { corsOrigin } = require('./config/origins');
const ErrorLog = require('./models/ErrorLog');
const { buildSpec, DOCS_HTML, DOCS_CSP } = require('./docs/openapi');

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

// ✅ M&E ROUTES ADDED
const meRoute        = require('./routes/me_routes');

// ✅ INVENTORY ROUTE ADDED — Inventory tab (manual CRUD + Excel import/export)
const inventoryRoute = require('./routes/inventory_routes');
// Alongside your other route requires:
const formRequestsRoute = require('./routes/form_requests_routes');

// Alongside your other app.use() mounts (order doesn't matter here — this
// route isn't nested under /api/assets, so there's no catch-all collision
// risk like with me_routes.js):
const app = express();

// Trust proxy (Render/Reverse Proxy)
app.set("trust proxy", 1);

// ── Security & compression ────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: corsOrigin, credentials: true }));
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

// M&E routes MUST be mounted before assetsRoute — the assets router has a
// catch-all GET /:id that would swallow /:id/me-reports before meRoute sees it.
app.use('/api/assets', meRoute);

// Export routes MUST also be mounted before assetsRoute, and at the correct
// sub-path — exportRoute's internal paths ('/', '/bulk') are written assuming
// a base of '/api/assets/export', not '/api/assets'. Mounting it at
// '/api/assets' (as before) made '/' resolve to plain '/api/assets' and
// '/bulk' resolve to '/api/assets/bulk' — neither of which is
// '/api/assets/export' or '/api/assets/export/bulk', so those requests fell
// through every router and hit Express's default 404. Mounting it before
// assetsRoute also avoids assetsRoute's GET /:id catching '/api/assets/export'
// as id === 'export'.
app.use('/api/assets/export', exportRoute);

// Extra asset routes (relationships, lifecycle, bulk-update, completeness,
// health-extras) MUST also be mounted before assetsRoute, for the exact same
// reason as meRoute/exportRoute above. Several of this router's paths are a
// single segment off /api/assets — /health-extras, /completeness,
// /bulk-update — and assetsRoute's GET /:id catch-all was swallowing those
// as if "health-extras"/"completeness" were an asset ID, 404ing before this
// router ever saw the request. That silently broke the frontend's
// /health-extras capability probe (js/api_additions.js), which meant
// AS_BACKEND.relationships/lifecycle/bulkUpdate/completeness never flipped
// to true — so js/lifecycle.js's relationship linking silently fell back to
// localStorage-only and never reached the database at all.
app.use('/api/assets', require('./routes/asset_extras_routes'));

app.use('/api/assets',    assetsRoute);
app.use('/api/assets/spatial', spatialRoute);

// 👇 MDA ROUTE MOUNTED HERE
app.use('/api/mdas', mdaRoute);

// File sub-routes (mergeParams enabled in each router)
app.use('/api/assets/:assetId/photos',     photosRoute);
app.use('/api/assets/:assetId/documents', documentsRoute);
app.use('/api/assets/:assetId/excel',     excelRoute);

// 👇 INVENTORY ROUTE MOUNTED HERE — same nested-resource pattern as
// photos/documents/excel above (mergeParams, /:assetId/inventory/*)
app.use('/api/assets/:assetId/inventory', inventoryRoute);

app.use('/api/analytics', analyticsRoute);   // ← now points to analytics_routes.js
app.use('/api/ocr',       ocrRoute);
app.use('/api/users/role-config', require('./routes/role_config_routes'));
app.use('/api/users',     usersRoute);
app.use('/api/audit',     auditRoute);
app.use('/api/settings',  settingsRoute);

// Inspection routes
app.use('/api/inspections', require('./routes/inspection_routes'));
app.use('/api/assets/:assetId/inspections', require('./routes/inspection_routes'));

app.use('/api/assets/files', require('./routes/files_route'));

app.use('/api/form-requests', formRequestsRoute);

app.use('/api/notifications', require('./routes/notifications_routes'));
app.use('/api/system',        require('./routes/system_routes'));
app.use('/api/data-quality',  require('./routes/data_quality_routes'));

// API documentation (OpenAPI + Swagger UI)
app.get('/api/docs/openapi.json', (_req, res) => res.json(buildSpec('/api')));
app.get(['/api/docs', '/api/docs/'], (_req, res) => {
  res.setHeader('Content-Security-Policy', DOCS_CSP);
  res.type('html').send(DOCS_HTML);
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const message = env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  if (status === 500) {
    console.error('[Error]', err);
    // Kept for the System health page (30 days).
    ErrorLog.create({
      source: 'server', message: String(err.message || err).slice(0, 1000), stack: String(err.stack || '').slice(0, 8000),
      url: _req.originalUrl, method: _req.method, status, user: _req.user?._id, ip: _req.ip,
    }).catch(() => {});
  }

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

// Tests import the app without starting a server (they connect to their own
// in-memory database); `node src/app.js` and any non-test run start it.
if (require.main === module || process.env.NODE_ENV !== 'test') {
  start().catch((err) => {
    console.error('[AssetSpatial] Failed to start:', err);
    process.exit(1);
  });
}

module.exports = app;