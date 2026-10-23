'use strict';
// OpenAPI 3 description of the API, served at /api/docs (interactive) and
// /api/docs/openapi.json. Keep the ROUTES table in step with src/routes/*.

const bearer = [{ bearerAuth: [] }];
const json = schema => ({ required: true, content: { 'application/json': { schema } } });
const obj = (props, required = []) => ({ type: 'object', properties: props, ...(required.length ? { required } : {}) });
const str = { type: 'string' };
const upload = field => ({ required: true, content: { 'multipart/form-data': { schema: obj({ [field]: { type: 'string', format: 'binary' } }, [field]) } } });

// [method, path, tag, summary, options]
const ROUTES = [
  // Auth
  ['post', '/auth/login', 'Auth', 'Sign in. Returns { token, user }, or { mfaRequired, mfaToken } when two-step sign-in is on.', { auth: false, body: json(obj({ email: str, password: str }, ['email', 'password'])) }],
  ['post', '/auth/mfa/verify', 'Auth', 'Second step: authenticator code (or a recovery code) → { token, user }.', { auth: false, body: json(obj({ mfaToken: str, code: str }, ['mfaToken', 'code'])) }],
  ['post', '/auth/mfa/setup', 'Auth', 'Start two-step setup: returns a secret and otpauth:// URL for the authenticator app.'],
  ['post', '/auth/mfa/enable', 'Auth', 'Confirm setup with a code; returns 8 one-time recovery codes.', { body: json(obj({ code: str }, ['code'])) }],
  ['post', '/auth/mfa/disable', 'Auth', 'Turn two-step sign-in off (requires password).', { body: json(obj({ password: str }, ['password'])) }],
  ['post', '/auth/logout', 'Auth', 'Record a sign-out.'],
  ['post', '/auth/logout-all', 'Auth', 'Sign out on every device (revokes all tokens).'],
  ['get', '/auth/me', 'Auth', 'The signed-in user.'],
  ['post', '/auth/forgot-password', 'Auth', 'Email a one-hour reset link (always answers the same way).', { auth: false, body: json(obj({ email: str })) }],
  ['post', '/auth/reset-password', 'Auth', 'Set a new password with the emailed token; signs out every session.', { auth: false, body: json(obj({ token: str, password: str }, ['token', 'password'])) }],
  ['post', '/auth/change-password', 'Auth', 'Change own password; other sessions end, returns a fresh token.', { body: json(obj({ currentPassword: str, newPassword: str }, ['currentPassword', 'newPassword'])) }],
  // Users
  ['get', '/users', 'Users', 'List users (System Admin).'],
  ['post', '/users', 'Users', 'Create a user; sendCredentials emails the login details.'],
  ['get', '/users/{id}', 'Users', 'One user.'],
  ['put', '/users/{id}', 'Users', 'Update a user (role, division, MDA, phone, active…).'],
  ['put', '/users/{id}/permissions', 'Users', 'Per-user permission overrides.'],
  ['delete', '/users/{id}', 'Users', 'Deactivate a user (ends their sessions).'],
  ['post', '/users/{id}/reset-password', 'Users', 'Admin password reset: { password?, sendEmail? }.'],
  ['post', '/users/{id}/reset-mfa', 'Users', 'Turn off a user\'s two-step sign-in (lost phone).'],
  ['get', '/users/role-config', 'Users', 'Role default permissions.'],
  ['put', '/users/role-config/{role}', 'Users', 'Change a role\'s defaults.'],
  ['post', '/users/role-config/reset', 'Users', 'Restore built-in role defaults.'],
  // Assets
  ['get', '/assets', 'Assets', 'List / filter / page the registry.'],
  ['get', '/assets/search', 'Assets', 'Quick search by name/ID.'],
  ['post', '/assets', 'Assets', 'Capture an asset (state must be a recognised state).'],
  ['get', '/assets/{id}', 'Assets', 'One asset (assetId, assetCode or _id).'],
  ['put', '/assets/{id}', 'Assets', 'Partial update.'],
  ['delete', '/assets/{id}', 'Assets', 'Delete an asset.'],
  ['get', '/assets/approvals', 'Approvals', 'Captures by approval status.'],
  ['get', '/assets/approvals/summary', 'Approvals', 'Pending / approved / rejected counts.'],
  ['post', '/assets/{id}/approve', 'Approvals', 'Approve a capture.'],
  ['post', '/assets/{id}/reject', 'Approvals', 'Reject a capture with a reason.'],
  ['get', '/assets/files', 'Files', 'Every photo/document/spreadsheet across assets.'],
  ['post', '/assets/{id}/photos', 'Files', 'Upload a photo (content-checked; virus-scanned when ClamAV is configured).', { body: upload('photo') }],
  ['get', '/assets/{id}/photos/{fileId}', 'Files', 'Download a photo.'],
  ['delete', '/assets/{id}/photos/{fileId}', 'Files', 'Delete a photo.'],
  ['post', '/assets/{id}/documents', 'Files', 'Upload a document.', { body: upload('file') }],
  ['get', '/assets/{id}/documents/{fileId}', 'Files', 'Download a document.'],
  ['delete', '/assets/{id}/documents/{fileId}', 'Files', 'Delete a document.'],
  ['post', '/assets/{id}/excel', 'Files', 'Attach a spreadsheet.', { body: upload('file') }],
  ['post', '/assets/{id}/maintenance', 'Assets', 'Log maintenance.'],
  ['delete', '/assets/{id}/maintenance/{logId}', 'Assets', 'Delete a maintenance entry.'],
  ['put', '/assets/{id}/valuation', 'Assets', 'Update valuation.'],
  ['get', '/assets/{id}/relationships', 'Assets', 'Parent / component links.'],
  ['post', '/assets/{id}/relationships/link', 'Assets', 'Link a component.'],
  ['get', '/assets/{id}/lifecycle', 'Assets', 'Lifecycle stage and history.'],
  ['post', '/assets/{id}/lifecycle/transition', 'Assets', 'Move to another lifecycle stage.'],
  ['post', '/assets/bulk-update', 'Assets', 'Bulk field update.'],
  ['get', '/assets/completeness', 'Assets', 'Completeness report.'],
  ['get', '/assets/export', 'Assets', 'Export (CSV/XLSX/GeoJSON/PDF).'],
  ['get', '/assets/{assetId}/inventory', 'Inventory', 'Inventory items.'],
  ['post', '/assets/{assetId}/inventory', 'Inventory', 'Add an item.'],
  ['get', '/assets/{id}/me-reports', 'M&E', 'M&E reports for an asset.'],
  ['post', '/assets/{id}/me-reports', 'M&E', 'File an M&E report.'],
  ['get', '/assets/me-reports/all', 'M&E', 'All M&E reports.'],
  // Inspections
  ['get', '/inspections', 'Inspections', 'List inspections.'],
  ['get', '/inspections/summary', 'Inspections', 'Overdue / pending / upcoming counts.'],
  ['post', '/inspections', 'Inspections', 'Schedule an inspection.'],
  ['post', '/inspections/{id}/submit', 'Inspections', 'Submit the report.'],
  ['post', '/inspections/{id}/approve', 'Inspections', 'Approve the report (updates the asset).'],
  ['post', '/inspections/{id}/reject', 'Inspections', 'Reject the report.'],
  // Form requests
  ['get', '/form-requests', 'Form requests', 'List (MDA Agents see their own MDA only).'],
  ['post', '/form-requests', 'Form requests', 'Create / submit a compliance form.'],
  ['patch', '/form-requests/{id}', 'Form requests', 'Edit a draft, or review (reviewers).'],
  ['post', '/form-requests/{id}/attachments', 'Form requests', 'Upload a supporting document.', { body: upload('file') }],
  ['post', '/form-requests/{id}/issue-certificate', 'Form requests', 'Issue the certificate.'],
  ['get', '/form-requests/{id}/certificate', 'Form requests', 'Download the certificate.'],
  // Notifications
  ['get', '/notifications', 'Notifications', 'Latest 50 in-app notifications + unread count. Also pushed live over socket.io ("notification" event).'],
  ['post', '/notifications/{id}/read', 'Notifications', 'Mark one read.'],
  ['post', '/notifications/read-all', 'Notifications', 'Mark all read.'],
  ['delete', '/notifications', 'Notifications', 'Clear all.'],
  // Data quality
  ['get', '/data-quality/summary', 'Data quality', 'Counts per issue type and the bad state / MDA spellings.'],
  ['get', '/data-quality/issues', 'Data quality', 'Assets with an issue (?type=, ?value=, ?mine=1, ?page=).'],
  ['post', '/data-quality/fix-state', 'Data quality', 'Rename a state spelling everywhere: { from, to }.'],
  ['post', '/data-quality/fix-mda', 'Data quality', 'Rename an MDA spelling everywhere: { from, to }.'],
  ['post', '/data-quality/assign', 'Data quality', 'Assign assets to someone to fix: { assetIds, userId, note }.'],
  ['post', '/data-quality/verify', 'Data quality', 'Mark fixes verified: { assetIds }.'],
  // System
  ['get', '/system/ping', 'System', 'Public liveness + database check (for uptime monitors).', { auth: false }],
  ['get', '/system/health', 'System', 'Detailed health (System Admin).'],
  ['post', '/system/client-errors', 'System', 'Report a browser error.', { auth: false }],
  ['get', '/system/errors', 'System', 'Recent server and browser errors (System Admin).'],
  ['get', '/system/backup', 'System', 'Download a full database backup as Extended JSON (System Admin).'],
  ['get', '/system/enums', 'System', 'Allowed values: states, asset types, conditions…'],
  // Other
  ['get', '/analytics/dashboard', 'Analytics', 'Dashboard KPIs.'],
  ['get', '/audit', 'Audit', 'Audit log (paged, filterable).'],
  ['get', '/settings', 'Settings', 'Platform settings.'],
  ['put', '/settings', 'Settings', 'Update settings.'],
  ['get', '/mdas', 'MDAs', 'MDA list.'],
  ['post', '/mdas', 'MDAs', 'Add an MDA.'],
  ['post', '/ocr/scan', 'OCR', 'Scan a document image.', { body: upload('file') }],
  ['get', '/assets/spatial/near', 'Spatial', 'Assets near a point.'],
];

function buildSpec(serverUrl = '/api') {
  const paths = {};
  for (const [method, path, tag, summary, opts = {}] of ROUTES) {
    const params = [...path.matchAll(/\{(\w+)\}/g)].map(m => ({ name: m[1], in: 'path', required: true, schema: str }));
    (paths[path] ||= {})[method] = {
      tags: [tag], summary,
      ...(params.length ? { parameters: params } : {}),
      ...(opts.body ? { requestBody: opts.body } : {}),
      ...(opts.auth === false ? { security: [] } : {}),
      responses: { 200: { description: 'OK' }, 401: { description: 'Not signed in / session ended' }, 403: { description: 'Not allowed' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'FPAMAS API',
      version: '1.0',
      description: 'Federal Public Asset Management API. Send `Authorization: Bearer <token>` from /auth/login. Money values are naira unless noted; dates are ISO 8601.',
    },
    servers: [{ url: serverUrl }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    security: bearer,
    paths,
  };
}

const DOCS_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>FPAMAS API</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css"></head>
<body><div id="ui"></div><script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js"></script>
<script>SwaggerUIBundle({ url: 'openapi.json', dom_id: '#ui', persistAuthorization: true });</script></body></html>`;

// Swagger UI loads from cdnjs, so this page gets its own CSP (helmet's default blocks it).
const DOCS_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; img-src 'self' data: https:; connect-src 'self'";

module.exports = { buildSpec, DOCS_HTML, DOCS_CSP, ROUTES };
