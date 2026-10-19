'use strict';
// ── INVENTORY ROUTES ──────────────────────────────────────────────────────────
// Mount at: app.use('/api/assets/:assetId/inventory', require('./routes/inventory_routes'));
// Mount BEFORE the generic assets.js catch-all router, same rule as me_routes.js.
//
//   GET    /api/assets/:assetId/inventory                — list items (filterable)
//   GET    /api/assets/:assetId/inventory/summary        — counts by category / defects
//   POST   /api/assets/:assetId/inventory                — add one item manually
//   PUT    /api/assets/:assetId/inventory/:itemId        — edit one item
//   DELETE /api/assets/:assetId/inventory/:itemId        — delete one item
//   POST   /api/assets/:assetId/inventory/import-preview — upload Excel, return
//                                                           parsed draft rows (NOT saved)
//   POST   /api/assets/:assetId/inventory/import-commit  — save a confirmed/edited
//                                                           batch of draft rows
//   GET    /api/assets/:assetId/inventory/export          — download current
//                                                           inventory as .xlsx

const router  = require('express').Router({ mergeParams: true });
const multer  = require('multer');
const ExcelJS = require('exceljs');
const { Types } = require('mongoose');
const Asset   = require('../models/Asset');

const { authenticate }                    = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');
const { scopeFilter }                     = require('../middleware/scopeFilter');
const { auditLog }                        = require('../middleware/auditMiddleware');

const auth = [authenticate, resolvePermissions, scopeFilter];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 }, // 15MB — plenty for an inventory sheet
});

// Accepts assetId, FGN assetCode or Mongo _id without CastErrors.
const assetQuery = require('../services/assetService').idQuery;

// Only these fields may be set from a request, coerced to valid values —
// the body used to be copied onto the item wholesale (including addedBy /
// editedBy) and saved without validation.
function cleanItem(body) {
  const out = {};
  const str = k => { if (body[k] !== undefined) out[k] = String(body[k] ?? '').trim(); };
  ['roomName', 'floorLevel', 'item', 'description', 'roomDimension', 'brandName', 'dimensionOfDamage', 'comment'].forEach(str);
  if (body.location !== undefined) out.location = coerceLocation(body.location);
  if (body.category !== undefined) out.category = coerceCategory(body.category);
  if (body.quantity !== undefined) out.quantity = Math.max(0, coerceNumber(body.quantity));
  if (body.quantityNotFunctioning !== undefined) out.quantityNotFunctioning = Math.max(0, coerceNumber(body.quantityNotFunctioning));
  if (body.hasDefect !== undefined) out.hasDefect = typeof body.hasDefect === 'boolean' ? body.hasDefect : coerceBool(body.hasDefect);
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// HEADER MAPPING — tolerant of real-world header variants
// ═══════════════════════════════════════════════════════════════════════════
// Normalizes a header cell ("Interal/ External", "QTY NOT FUNCTIONING", etc.)
// down to a bare alnum key so minor spacing/punctuation differences between
// sheets still match the same canonical field.
function normalizeHeader(h) {
  return String(h || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

// Canonical field -> array of normalized header aliases that should map to it.
const HEADER_ALIASES = {
  location:               ['INTERALEXTERNAL', 'INTERNALEXTERNAL', 'INTEXT'],
  roomName:               ['ROOMNAMENUMBERS', 'ROOMNAME', 'ROOMNUMBER'],
  floorLevel:             ['FLOORLEVEL', 'FLOOR'],
  category:               ['CATEGORY'],
  item:                   ['ITEM'],
  description:            ['DESCRIPTION'],
  roomDimension:          ['ROOMDIMENSION', 'DIMENSION'],
  brandName:              ['BRANDNAME', 'BRAND'],
  quantity:               ['QUANTITY', 'QTY'],
  quantityNotFunctioning: ['QUANTITYNOTFUNCTIONING', 'QTYNOTFUNCTIONING', 'QUANTITYNOTFUNCTIONING'],
  dimensionOfDamage:      ['DIMENSIONOFDAMAGESDEFECT', 'DIMENSIONOFDAMAGEDEFECT', 'DAMAGEDIMENSION'],
  hasDefect:              ['DEFECTSFAULTYN', 'DEFECTFAULTYN', 'DEFECTSYN', 'FAULTYN'],
  comment:                ['COMMENT', 'COMMENTS', 'REMARK', 'REMARKS'],
};

function buildColumnMap(headerRow) {
  const map = {}; // columnIndex -> canonicalField
  headerRow.forEach((cell, idx) => {
    const norm = normalizeHeader(cell);
    if (!norm) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (aliases.includes(norm)) { map[idx] = field; break; }
    }
  });
  return map;
}

function coerceCategory(raw) {
  const v = String(raw || '').toUpperCase().trim();
  if (v.startsWith('MECH')) return 'MECHANICAL';
  if (v.startsWith('ELEC')) return 'ELECTRICAL';
  if (v.startsWith('STRUCT')) return 'STRUCTURAL';
  return 'OTHER';
}

function coerceLocation(raw) {
  const v = String(raw || '').toUpperCase().trim();
  return v.startsWith('EXT') ? 'EXTERNAL' : 'INTERNAL';
}

function coerceBool(raw) {
  const v = String(raw || '').toUpperCase().trim();
  return v === 'Y' || v === 'YES' || v === 'TRUE';
}

function coerceNumber(raw) {
  const n = parseFloat(String(raw ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parses an uploaded workbook buffer into draft inventory rows.
 * Walks EVERY worksheet in the file (source sheets like the FPAM template
 * often split MECHANICAL / ELECTRICAL / STRUCTURAL across separate sheets
 * or continue the same header across multiple print pages within one sheet).
 */
async function parseInventoryWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);

  const drafts = [];
  const warnings = [];

  wb.worksheets.forEach((ws) => {
    // Find the header row — scan first 5 rows for one that matches >= 4 known fields
    let headerRowIdx = null;
    let colMap = {};
    for (let r = 1; r <= Math.min(5, ws.rowCount); r++) {
      const rowVals = ws.getRow(r).values.map(v => (v && v.text) || v || '');
      const map = buildColumnMap(rowVals);
      if (Object.keys(map).length >= 4) { headerRowIdx = r; colMap = map; break; }
    }
    if (headerRowIdx === null) {
      warnings.push(`Sheet "${ws.name}": no recognizable header row found — skipped.`);
      return;
    }

    for (let r = headerRowIdx + 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const rowVals = row.values;
      if (!rowVals || rowVals.every(v => v === null || v === undefined || v === '')) continue;

      const draft = {
        location: 'INTERNAL', roomName: '', floorLevel: '', category: 'OTHER',
        item: '', description: '', roomDimension: '', brandName: '',
        quantity: 0, quantityNotFunctioning: 0, dimensionOfDamage: '',
        hasDefect: false, comment: '',
        sourceRow: r, sourceSheet: ws.name,
      };

      Object.entries(colMap).forEach(([idx, field]) => {
        const raw = rowVals[Number(idx)];
        const cellVal = (raw && raw.text) || raw || '';
        switch (field) {
          case 'location':               draft.location = coerceLocation(cellVal); break;
          case 'category':               draft.category = coerceCategory(cellVal); break;
          case 'quantity':               draft.quantity = coerceNumber(cellVal); break;
          case 'quantityNotFunctioning': draft.quantityNotFunctioning = coerceNumber(cellVal); break;
          case 'hasDefect':               draft.hasDefect = coerceBool(cellVal); break;
          default:                        draft[field] = String(cellVal).trim();
        }
      });

      // Skip fully-blank item rows (common on sheets with trailing empty rows)
      if (!draft.item && !draft.description && !draft.roomName) continue;

      drafts.push(draft);
    }
  });

  return { drafts, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', ...auth, async (req, res, next) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.assetId))
      .select('assetId inventoryItems').lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    let items = asset.inventoryItems || [];
    const { category, hasDefect, location } = req.query;
    if (category)  items = items.filter(i => i.category === category);
    if (location)  items = items.filter(i => i.location === location);
    if (hasDefect !== undefined) {
      const want = hasDefect === 'true';
      items = items.filter(i => Boolean(i.hasDefect) === want);
    }

    res.json({ items, total: items.length });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════════
router.get('/summary', ...auth, async (req, res, next) => {
  try {
    const asset = await Asset.findOne(assetQuery(req.params.assetId))
      .select('inventoryItems').lean();
    if (!asset) return res.status(404).json({ error: 'Asset not found' });

    const items = asset.inventoryItems || [];
    const byCategory = {};
    let defectCount = 0;
    let totalQty = 0;
    let notFunctioningQty = 0;

    items.forEach(i => {
      byCategory[i.category] = (byCategory[i.category] || 0) + 1;
      if (i.hasDefect) defectCount++;
      totalQty += i.quantity || 0;
      notFunctioningQty += i.quantityNotFunctioning || 0;
    });

    res.json({
      total: items.length,
      defectCount,
      totalQty,
      notFunctioningQty,
      byCategory,
    });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ADD ONE
// ═══════════════════════════════════════════════════════════════════════════
router.post('/',
  ...auth,
  requirePerm('canEditInventory'),
  auditLog('INVENTORY_ITEM_ADDED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await Asset.findOne(assetQuery(req.params.assetId));
      if (!asset) return res.status(404).json({ error: 'Asset not found' });

      const item = { ...cleanItem(req.body), addedBy: req.user._id };
      asset.inventoryItems.push(item);
      await asset.save({ validateBeforeSave: false });

      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `Inventory item "${item.item || item.description || 'item'}" added`;
      res.status(201).json({ item: asset.inventoryItems[asset.inventoryItems.length - 1] });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE ONE
// ═══════════════════════════════════════════════════════════════════════════
router.put('/:itemId',
  ...auth,
  requirePerm('canEditInventory'),
  auditLog('INVENTORY_ITEM_UPDATED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await Asset.findOne(assetQuery(req.params.assetId));
      if (!asset) return res.status(404).json({ error: 'Asset not found' });

      const sub = asset.inventoryItems.id(req.params.itemId);
      if (!sub) return res.status(404).json({ error: 'Inventory item not found' });

      Object.assign(sub, cleanItem(req.body), { editedBy: req.user._id });
      await asset.save({ validateBeforeSave: false });

      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `Inventory item ${req.params.itemId} updated`;
      res.json({ item: sub });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// DELETE ONE
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:itemId',
  ...auth,
  requirePerm('canEditInventory'),
  auditLog('INVENTORY_ITEM_DELETED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await Asset.findOne(assetQuery(req.params.assetId));
      if (!asset) return res.status(404).json({ error: 'Asset not found' });

      const sub = asset.inventoryItems.id(req.params.itemId);
      if (!sub) return res.status(404).json({ error: 'Inventory item not found' });

      sub.deleteOne();
      await asset.save({ validateBeforeSave: false });

      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `Inventory item ${req.params.itemId} deleted`;
      res.json({ success: true });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT — PREVIEW (parse only, nothing saved yet)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/import-preview',
  ...auth,
  requirePerm('canEditInventory'),
  upload.single('file'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const { drafts, warnings } = await parseInventoryWorkbook(req.file.buffer);

      res.json({
        drafts,
        warnings,
        total: drafts.length,
        filename: req.file.originalname,
      });
    } catch (err) {
      res.status(422).json({ error: 'Could not parse workbook: ' + err.message });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// IMPORT — COMMIT (user has reviewed/edited the preview, now save it)
// ═══════════════════════════════════════════════════════════════════════════
router.post('/import-commit',
  ...auth,
  requirePerm('canEditInventory'),
  auditLog('INVENTORY_IMPORTED', 'Asset'),
  async (req, res, next) => {
    try {
      const { items, sourceFilename } = req.body;
      if (!Array.isArray(items) || !items.length) {
        return res.status(400).json({ error: 'No items provided' });
      }

      const asset = await Asset.findOne(assetQuery(req.params.assetId));
      if (!asset) return res.status(404).json({ error: 'Asset not found' });

      const toInsert = items.map(i => ({
        location:               i.location || 'INTERNAL',
        roomName:                i.roomName || '',
        floorLevel:              i.floorLevel || '',
        category:                i.category || 'OTHER',
        item:                    i.item || '',
        description:             i.description || '',
        roomDimension:           i.roomDimension || '',
        brandName:               i.brandName || '',
        quantity:                Number(i.quantity) || 0,
        quantityNotFunctioning:  Number(i.quantityNotFunctioning) || 0,
        dimensionOfDamage:       i.dimensionOfDamage || '',
        hasDefect:               Boolean(i.hasDefect),
        comment:                 i.comment || '',
        sourceRow:               i.sourceRow,
        addedBy:                 req.user._id,
      }));

      asset.inventoryItems.push(...toInsert);
      await asset.save({ validateBeforeSave: false });

      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `Imported ${toInsert.length} inventory items from "${sourceFilename || 'upload'}"`;
      res.status(201).json({ inserted: toInsert.length, total: asset.inventoryItems.length });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT — regenerate a fresh .xlsx from the live structured data
// ═══════════════════════════════════════════════════════════════════════════
router.get('/export',
  ...auth,
  auditLog('INVENTORY_EXPORTED', 'Asset'),
  async (req, res, next) => {
    try {
      const asset = await Asset.findOne(assetQuery(req.params.assetId))
        .select('assetId name inventoryItems').lean();
      if (!asset) return res.status(404).json({ error: 'Asset not found' });

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Inventory');

      ws.columns = [
        { header: 'INTERNAL/EXTERNAL',              key: 'location',               width: 16 },
        { header: 'ROOM NAME / NUMBERS',             key: 'roomName',               width: 22 },
        { header: 'FLOOR LEVEL',                     key: 'floorLevel',             width: 14 },
        { header: 'CATEGORY',                        key: 'category',               width: 14 },
        { header: 'ITEM',                            key: 'item',                   width: 18 },
        { header: 'DESCRIPTION',                     key: 'description',            width: 26 },
        { header: 'ROOM DIMENSION',                  key: 'roomDimension',          width: 16 },
        { header: 'BRAND NAME',                      key: 'brandName',              width: 16 },
        { header: 'QUANTITY',                        key: 'quantity',               width: 10 },
        { header: 'QUANTITY NOT FUNCTIONING',        key: 'quantityNotFunctioning', width: 12 },
        { header: 'DIMENSION OF DAMAGES/DEFECT',     key: 'dimensionOfDamage',      width: 20 },
        { header: 'DEFECTS/FAULT (Y/N)',             key: 'hasDefectYN',            width: 12 },
        { header: 'COMMENT',                         key: 'comment',                width: 18 },
      ];
      ws.getRow(1).font = { bold: true };

      (asset.inventoryItems || []).forEach(i => {
        ws.addRow({
          location: i.location, roomName: i.roomName, floorLevel: i.floorLevel,
          category: i.category, item: i.item, description: i.description,
          roomDimension: i.roomDimension, brandName: i.brandName,
          quantity: i.quantity, quantityNotFunctioning: i.quantityNotFunctioning,
          dimensionOfDamage: i.dimensionOfDamage,
          hasDefectYN: i.hasDefect ? 'Y' : 'N', comment: i.comment,
        });
      });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${asset.assetId}_inventory.xlsx"`);

      res.locals.auditEntityId = asset.assetId;
      res.locals.auditDetail   = `Inventory exported (${(asset.inventoryItems || []).length} items)`;

      await wb.xlsx.write(res);
      res.end();
    } catch (err) { next(err); }
  }
);

module.exports = router;