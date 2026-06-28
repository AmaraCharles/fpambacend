'use strict';
const router  = require('express').Router();
const { Readable } = require('stream');
const { authenticate }                    = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');
const { scopeFilter }                     = require('../middleware/scopeFilter');
const { auditLog }                        = require('../middleware/auditMiddleware');
const { validateBody, schemas }           = require('../middleware/validate');
const { photoUploader, documentUploader, excelUploader } = require('../middleware/upload');
const { getBuckets }                      = require('../config/gridfs');
const assetSvc                            = require('../services/assetService');
const { emitNewAsset }                    = require('../sockets/realtime');
const Asset                               = require('../models/Asset');
const { ObjectId }                        = require('mongodb');

const auth = [authenticate, resolvePermissions, scopeFilter];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toObjectId(str) {
  try { return new ObjectId(str); } catch { return null; }
}

function assetQuery(id) {
  if (id.startsWith('AST-') || id.startsWith('FGN-'))
    return { assetId: id };
  return { _id: id };
}
/** Write a multer memory buffer into a GridFS bucket. Returns file metadata. */
function uploadToGridFS(bucket, file, metadata = {}) {
  return new Promise((resolve, reject) => {
    const stream = bucket.openUploadStream(file.originalname, {
      contentType: file.mimetype,
      metadata,
    });
    Readable.from(file.buffer).pipe(stream);
    stream.on('finish', () => resolve({
      _id:         stream.id,          // GridFS file _id
      fileId:      stream.id,          // alias — stored in asset file refs
      filename:    file.originalname,
      originalname: file.originalname,
      contentType: file.mimetype,
      length:      file.size,
      uploadDate:  new Date(),
    }));
    stream.on('error', reject);
  });
}

/**
 * Resolve the GridFS ObjectId for a file given the ID the frontend sent.
 * The frontend may send either:
 *   (a) the GridFS fileId  — use directly
 *   (b) the subdoc _id     — look it up from the asset's file array
 *
 * @param {string} paramId   - the :fileId from the URL
 * @param {string} assetId   - the :id from the URL
 * @param {string} arrayField - 'photos' | 'documents' | 'xlDatasets'
 */
async function resolveGridFSId(paramId, assetId, arrayField) {
  const oid = toObjectId(paramId);
  if (!oid) return null;

  // Try direct GridFS lookup first
  const bucket = getBuckets()[arrayField === 'xlDatasets' ? 'excel'
                              : arrayField === 'photos'    ? 'photos'
                              : 'documents'];
  const direct = await bucket.find({ _id: oid }).limit(1).toArray();
  if (direct.length) return oid; // paramId IS the GridFS fileId

  // paramId is the subdoc _id — look up the real fileId from the asset
  const asset = await Asset.findOne(
    assetQuery(assetId),
    { [arrayField]: 1 }
  ).lean();
  if (!asset) return null;

  const refs = asset[arrayField] || [];
  const ref  = refs.find(r =>
    String(r._id)    === paramId ||
    String(r.fileId) === paramId
  );
  return ref ? toObjectId(String(ref.fileId || ref._id)) : null;
}

/** Stream a GridFS file to the HTTP response. */
async function streamFromGridFS(bucketName, gridfsId, res) {
  const bucket = getBuckets()[bucketName];
  const files  = await bucket.find({ _id: gridfsId }).limit(1).toArray();
  if (!files.length) return res.status(404).json({ error: 'File not found in GridFS' });

  const file = files[0];
  res.set('Content-Type',        file.contentType || 'application/octet-stream');
  res.set('Content-Disposition', `inline; filename="${encodeURIComponent(file.filename)}"`);
  res.set('Content-Length',      file.length);
  res.set('Cache-Control',       'private, max-age=3600');
  bucket.openDownloadStream(gridfsId).pipe(res);
}

// ── ASSET CRUD ────────────────────────────────────────────────────────────────

router.get('/', ...auth, async (req, res, next) => {
  try {
    const result = await assetSvc.listAssets({ ...req.query, scopeFilter: req.scopeFilter });
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/search', ...auth, async (req, res, next) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Query parameter q is required' });
    const assets = await assetSvc.searchAssets(q, req.scopeFilter);
    res.json({ assets });
  } catch (err) { next(err); }
});

router.post('/',
  ...auth, requirePerm('canCreateAssets'), validateBody(schemas.asset),
  auditLog('ASSET_CREATED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await assetSvc.createAsset(req.body, req.user._id);
      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `${asset.name} captured`;
      emitNewAsset(asset);
      res.status(201).json({ asset });
    } catch (err) { next(err); }
  }
);

router.get('/:id', ...auth, async (req, res, next) => {
  try {
    const asset = await assetSvc.getAsset(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    res.json({ asset });
  } catch (err) { next(err); }
});

// validateBody(schemas.asset) intentionally removed — partial updates omit
// required fields and would 422. assetService.updateAsset handles field safety.
router.put('/:id',
  ...auth, requirePerm('canEditAssets'),
  auditLog('ASSET_UPDATED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await assetSvc.updateAsset(req.params.id, req.body);
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.locals.auditDetail = `${asset.name} updated`;
      res.json({ asset });
    } catch (err) { next(err); }
  }
);

router.delete('/:id',
  ...auth, requirePerm('canDeleteAssets'),
  auditLog('ASSET_DELETED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await assetSvc.deleteAsset(req.params.id);
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.locals.auditDetail = `${asset.name} deleted`;
      res.json({ message: 'Asset deleted' });
    } catch (err) { next(err); }
  }
);

// ── PHOTOS ────────────────────────────────────────────────────────────────────

router.get('/:id/photos', ...auth, async (req, res, next) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id), 'photos').lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    // Normalise every photo ref so _id = fileId (GridFS id) for the frontend
    const photos = (asset.photos || []).map(p => ({
      ...p,
      _id:         p.fileId || p._id,   // GridFS id takes priority
      fileId:      p.fileId || p._id,
      originalname: p.originalname || p.filename,
      contentType:  p.contentType  || p.mimeType,
      length:       p.length       || p.sizeBytes,
      uploadDate:   p.uploadedAt,
    }));
    res.json({ photos });
  } catch (err) { next(err); }
});

router.get('/:id/photos/:fileId', ...auth, async (req, res, next) => {
  try {
    const gridfsId = await resolveGridFSId(req.params.fileId, req.params.id, 'photos');
    if (!gridfsId) return res.status(404).json({ error: 'Photo not found' });
    await streamFromGridFS('photos', gridfsId, res);
  } catch (err) { next(err); }
});

router.post('/:id/photos',
  ...auth, requirePerm('canEditAssets'),
  photoUploader.single('photo'),
  auditLog('PHOTO_UPLOADED', 'Asset'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const { photos } = getBuckets();
      const gridFile   = await uploadToGridFS(photos, req.file, { assetId: req.params.id });

      const fileRef = {
        fileId:      gridFile.fileId,   // GridFS _id
        filename:    req.file.originalname,
        originalname: req.file.originalname,
        mimeType:    req.file.mimetype,
        contentType: req.file.mimetype,
        sizeBytes:   req.file.size,
        length:      req.file.size,
        uploadedAt:  new Date(),
      };

      const asset = await Asset.findOneAndUpdate(
        assetQuery(req.params.id),
        { $push: { photos: fileRef } },
        { new: true }
      ).lean();
      if (!asset) return res.status(404).json({ error: 'Asset not found' });

      res.locals.auditDetail = `Photo uploaded for ${asset.name}`;
      // Return the photo with _id = fileId so frontend can reference it
      res.status(201).json({ photo: { ...fileRef, _id: gridFile.fileId }, asset });
    } catch (err) { next(err); }
  }
);

router.delete('/:id/photos/:fileId',
  ...auth, requirePerm('canEditAssets'),
  async (req, res, next) => {
    try {
      const gridfsId = await resolveGridFSId(req.params.fileId, req.params.id, 'photos');
      if (gridfsId) {
        try { await getBuckets().photos.delete(gridfsId); } catch (_) {}
      }
      await Asset.findOneAndUpdate(
        assetQuery(req.params.id),
        { $pull: { photos: {
          $or: [
            { fileId: toObjectId(req.params.fileId) },
            { _id:    toObjectId(req.params.fileId) },
          ]
        }}},
        { new: true }
      );
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// ── DOCUMENTS ─────────────────────────────────────────────────────────────────

router.get('/:id/documents', ...auth, async (req, res, next) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id), 'documents').lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const documents = (asset.documents || []).map(d => ({
      ...d,
      _id:         d.fileId || d._id,
      fileId:      d.fileId || d._id,
      originalname: d.originalname || d.filename,
      contentType:  d.contentType  || d.mimeType,
      length:       d.length       || d.sizeBytes,
      uploadDate:   d.uploadedAt,
    }));
    res.json({ documents });
  } catch (err) { next(err); }
});

router.get('/:id/documents/:fileId', ...auth, async (req, res, next) => {
  try {
    const gridfsId = await resolveGridFSId(req.params.fileId, req.params.id, 'documents');
    if (!gridfsId) return res.status(404).json({ error: 'Document not found' });
    await streamFromGridFS('documents', gridfsId, res);
  } catch (err) { next(err); }
});

router.post('/:id/documents',
  ...auth, requirePerm('canEditAssets'),
  documentUploader.single('file'),
  auditLog('DOCUMENT_UPLOADED', 'Asset'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const { documents } = getBuckets();
      const gridFile = await uploadToGridFS(documents, req.file, { assetId: req.params.id });
      const fileRef  = {
        fileId: gridFile.fileId, filename: req.file.originalname,
        originalname: req.file.originalname, mimeType: req.file.mimetype,
        contentType: req.file.mimetype, sizeBytes: req.file.size,
        length: req.file.size, uploadedAt: new Date(),
      };
      const asset = await Asset.findOneAndUpdate(
        assetQuery(req.params.id), { $push: { documents: fileRef } }, { new: true }
      ).lean();
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.status(201).json({ document: { ...fileRef, _id: gridFile.fileId }, asset });
    } catch (err) { next(err); }
  }
);

router.delete('/:id/documents/:fileId', ...auth, requirePerm('canEditAssets'),
  async (req, res, next) => {
    try {
      const gridfsId = await resolveGridFSId(req.params.fileId, req.params.id, 'documents');
      if (gridfsId) { try { await getBuckets().documents.delete(gridfsId); } catch (_) {} }
      await Asset.findOneAndUpdate(assetQuery(req.params.id), {
        $pull: { documents: { $or: [
          { fileId: toObjectId(req.params.fileId) },
          { _id:    toObjectId(req.params.fileId) },
        ]}}
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// ── EXCEL ─────────────────────────────────────────────────────────────────────

router.get('/:id/excel', ...auth, async (req, res, next) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.id), 'xlDatasets').lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const excel = (asset.xlDatasets || []).map(f => ({
      ...f,
      _id:         f.fileId || f._id,
      fileId:      f.fileId || f._id,
      originalname: f.originalname || f.filename,
      contentType:  f.contentType  || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      length:       f.length       || f.sizeBytes,
      uploadDate:   f.uploadedAt,
    }));
    res.json({ excel, files: excel });
  } catch (err) { next(err); }
});

router.get('/:id/excel/:fileId', ...auth, async (req, res, next) => {
  try {
    const gridfsId = await resolveGridFSId(req.params.fileId, req.params.id, 'xlDatasets');
    if (!gridfsId) return res.status(404).json({ error: 'Excel file not found' });
    await streamFromGridFS('excel', gridfsId, res);
  } catch (err) { next(err); }
});

router.post('/:id/excel',
  ...auth, requirePerm('canEditAssets'),
  excelUploader.single('file'),
  auditLog('EXCEL_UPLOADED', 'Asset'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const { excel } = getBuckets();
      const gridFile  = await uploadToGridFS(excel, req.file, { assetId: req.params.id });
      const fileRef   = {
        fileId: gridFile.fileId, filename: req.file.originalname,
        originalname: req.file.originalname, contentType: req.file.mimetype,
        sizeBytes: req.file.size, length: req.file.size, uploadedAt: new Date(),
      };
      const asset = await Asset.findOneAndUpdate(
        assetQuery(req.params.id), { $push: { xlDatasets: fileRef } }, { new: true }
      ).lean();
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.status(201).json({ file: { ...fileRef, _id: gridFile.fileId }, asset });
    } catch (err) { next(err); }
  }
);

router.delete('/:id/excel/:fileId', ...auth, requirePerm('canEditAssets'),
  async (req, res, next) => {
    try {
      const gridfsId = await resolveGridFSId(req.params.fileId, req.params.id, 'xlDatasets');
      if (gridfsId) { try { await getBuckets().excel.delete(gridfsId); } catch (_) {} }
      await Asset.findOneAndUpdate(assetQuery(req.params.id), {
        $pull: { xlDatasets: { $or: [
          { fileId: toObjectId(req.params.fileId) },
          { _id:    toObjectId(req.params.fileId) },
        ]}}
      });
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

// ── MAINTENANCE ───────────────────────────────────────────────────────────────

router.post('/:id/maintenance',
  ...auth, validateBody(schemas.maintenanceLog),
  auditLog('MAINTENANCE_LOGGED', 'Asset'),
  async (req, res, next) => {
    try {
      const log   = { ...req.body, loggedBy: req.user._id };
      const asset = await Asset.findOneAndUpdate(
        assetQuery(req.params.id), { $push: { maintenanceLogs: log } }, { new: true }
      ).lean();
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.locals.auditDetail = `Maintenance logged for ${asset.name}`;
      res.status(201).json({ asset });
    } catch (err) { next(err); }
  }
);

router.delete('/:id/maintenance/:logId',
  ...auth, requirePerm('canEditAssets'),
  auditLog('MAINTENANCE_DELETED', 'Asset'),
  async (req, res, next) => {
    try {
      const oid = toObjectId(req.params.logId);
      let asset;
      if (oid) {
        asset = await Asset.findOneAndUpdate(
          assetQuery(req.params.id),
          { $pull: { maintenanceLogs: { _id: oid } } },
          { new: true }
        ).lean();
      } else {
        // Fallback: treat as array index
        const doc = await Asset.findOne(assetQuery(req.params.id));
        if (!doc) return res.status(404).json({ error: 'Asset not found' });
        doc.maintenanceLogs.splice(+req.params.logId, 1);
        await doc.save();
        asset = doc.toObject();
      }
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.json({ asset });
    } catch (err) { next(err); }
  }
);

// ── VALUATION ─────────────────────────────────────────────────────────────────

router.put('/:id/valuation',
  ...auth, requirePerm('canEditAssets'), validateBody(schemas.valuation),
  auditLog('VALUATION_UPDATED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await Asset.findOneAndUpdate(
        assetQuery(req.params.id), { $set: { valuation: req.body } }, { new: true }
      ).lean();
      if (!asset) return res.status(404).json({ error: 'Asset not found' });
      res.json({ asset });
    } catch (err) { next(err); }
  }
);

module.exports = router;