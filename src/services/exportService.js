'use strict';
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const Asset   = require('../models/Asset');

// Columns included in CSV exports, in order. 'condition' was previously
// excluded at FPAM's request; it has been reinstated alongside mda/assessed
// so exports carry the same fields the registry table shows.
const ASSET_FIELDS = [
  'assetId', 'assetCode', 'name', 'type', 'geomType', 'mda', 'condition', 'assessed',
  'material', 'state', 'lga', 'address', 'status', 'captureDate', 'createdAt',
];

// PDF exports are rendered row-by-row (not streamed from a DB cursor into a
// giant table the way CSV/XLSX are), so keep this bounded to avoid producing
// a multi-thousand-page file or timing out the request. Bulk exports (a
// user-selected set of assets) will almost always be well under this.
const PDF_ROW_LIMIT = 2000;

// scopeFilter and extraFilter may both carry a top-level $or (role scope vs.
// "assetId or assetCode"), so spreading them together would let one silently
// overwrite the other. $and keeps both conditions.
function combine(scopeFilter = {}, extraFilter = {}) {
  return { $and: [scopeFilter || {}, extraFilter || {}] };
}

async function sendJSON(res, scopeFilter = {}, extraFilter = {}) {
  const assets = await Asset.find(combine(scopeFilter, extraFilter)).lean();
  res.set('Content-Disposition', 'attachment; filename="assets_export.json"');
  res.json({ assets });
}

/**
 * Stream CSV directly to response. Handles 100k+ assets.
 */
async function streamCSV(res, scopeFilter = {}, extraFilter = {}) {
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', 'attachment; filename="assets_export.csv"');

  const headers = [...ASSET_FIELDS, 'lat', 'lng', 'notes', 'valuation_NGN'];
  res.write(headers.join(',') + '\n');

  const cursor = Asset.find(combine(scopeFilter, extraFilter)).lean().cursor();
  for await (const asset of cursor) {
    const [lng, lat] = asset.location?.coordinates || [null, null];
    const row = [
      ...ASSET_FIELDS.map((f) => csvCell(asset[f])),
      lat ?? '', lng ?? '',
      csvCell(asset.notes),
      asset.valuation?.amount || '',
    ];
    res.write(row.join(',') + '\n');
  }
  res.end();
}

/**
 * Stream GeoJSON FeatureCollection. Compatible with QGIS / ArcGIS.
 */
async function streamGeoJSON(res, scopeFilter = {}, extraFilter = {}) {
  res.set('Content-Type', 'application/geo+json');
  res.set('Content-Disposition', 'attachment; filename="assets_export.geojson"');

  res.write('{"type":"FeatureCollection","features":[\n');
  let first = true;
  const cursor = Asset.find(combine(scopeFilter, extraFilter)).lean().cursor();
  for await (const asset of cursor) {
    const feature = {
      type: 'Feature',
      geometry: asset.geometry || {
        type: 'Point',
        coordinates: asset.location?.coordinates || [0, 0],
      },
      properties: {
        assetId:   asset.assetId,
        assetCode: asset.assetCode,
        name:      asset.name,
        type:      asset.type,
        mda:       asset.mda,
        condition: asset.condition,
        assessed:  asset.assessed,
        state:     asset.state,
        lga:       asset.lga,
        status:    asset.status,
      },
    };
    res.write((first ? '' : ',\n') + JSON.stringify(feature));
    first = false;
  }
  res.write('\n]}');
  res.end();
}

// Excel forbids * ? : \ / [ ] in sheet names and caps them at 31 chars —
// "Land / Property" alone used to make every XLSX export unreadable.
function sheetName(raw, used) {
  let base = String(raw || 'Unspecified').replace(/[*?:\\/\[\]]/g, '-').trim().slice(0, 31) || 'Unspecified';
  let name = base, n = 2;
  while (used.has(name.toLowerCase())) name = `${base.slice(0, 28)} ${n++}`;
  used.add(name.toLowerCase());
  return name;
}

/**
 * Stream XLSX — one sheet per asset type actually present in the result set
 * (including legacy/unknown types, which previously were silently dropped).
 */
async function streamXLSX(res, scopeFilter = {}, extraFilter = {}) {
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="assets_export.xlsx"');

  const query = combine(scopeFilter, extraFilter);
  const types = (await Asset.distinct('type', query)).sort((a, b) => String(a || '').localeCompare(String(b || '')));

  const wb   = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
  const used = new Set();
  const columns = [
    { header: 'Asset ID',   key: 'assetId',   width: 14 },
    { header: 'Asset Code', key: 'assetCode', width: 30 },
    { header: 'Name',       key: 'name',      width: 30 },
    { header: 'MDA',        key: 'mda',       width: 30 },
    { header: 'Condition',  key: 'condition', width: 11 },
    { header: 'Assessed',   key: 'assessed',  width: 12 },
    { header: 'State',      key: 'state',     width: 14 },
    { header: 'LGA',        key: 'lga',       width: 14 },
    { header: 'Status',     key: 'status',    width: 16 },
    { header: 'Latitude',   key: 'lat',       width: 12 },
    { header: 'Longitude',  key: 'lng',       width: 12 },
  ];

  if (!types.length) {
    const ws = wb.addWorksheet('Assets');
    ws.columns = columns;
    await ws.commit();
  }

  for (const type of types) {
    const ws = wb.addWorksheet(sheetName(type, used));
    ws.columns = columns;

    // distinct() returns null for assets with no type — match those explicitly.
    const typeFilter = type == null ? { type: { $in: [null, ''] } } : { type };
    const cursor = Asset.find({ $and: [query, typeFilter] }).lean().cursor();
    for await (const asset of cursor) {
      const [lng, lat] = asset.location?.coordinates || [null, null];
      ws.addRow({
        assetId: asset.assetId, assetCode: asset.assetCode, name: asset.name,
        mda: asset.mda, condition: asset.condition, assessed: asset.assessed,
        state: asset.state, lga: asset.lga, status: asset.status, lat, lng,
      }).commit();
    }
    await ws.commit();
  }

  await wb.commit();
}

/**
 * Stream a formatted PDF table of assets. Bounded to PDF_ROW_LIMIT rows —
 * callers exceeding that should be pointed to CSV/XLSX instead.
 */
async function streamPDF(res, scopeFilter = {}, extraFilter = {}) {
  const query = combine(scopeFilter, extraFilter);
  const total = await Asset.countDocuments(query);

  if (total > PDF_ROW_LIMIT) {
    res.status(413).json({
      error: `PDF export is limited to ${PDF_ROW_LIMIT} assets (matched ${total}). Use CSV or XLSX for larger exports.`,
    });
    return;
  }

  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', 'attachment; filename="assets_export.pdf"');

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  doc.pipe(res);

  // Widths sum to 782pt — the printable width of landscape A4 at 30pt margins.
  const columns = [
    { key: 'name',      label: 'Name',            width: 170 },
    { key: 'type',      label: 'Type',            width: 95 },
    { key: 'mda',       label: 'MDA',             width: 150 },
    { key: 'state',     label: 'State',           width: 75 },
    { key: 'lga',       label: 'LGA',             width: 80 },
    { key: 'condition', label: 'Condition',       width: 62 },
    { key: 'status',    label: 'Status',          width: 70 },
    { key: 'valuation', label: 'Valuation (NGN)', width: 80 },
  ];
  const tableLeft  = doc.page.margins.left;
  const tableWidth = columns.reduce((s, c) => s + c.width, 0);
  const rowHeight  = 20;

  function drawHeader() {
    doc.fillColor('#0B2545')
      .fontSize(16)
      .text('AssetSpatial — Federal Public Asset Export', tableLeft, 30);
    doc.fontSize(9).fillColor('#5A6A7A')
      .text(`Generated ${new Date().toLocaleString('en-NG')}  •  ${total} asset${total === 1 ? '' : 's'}`, tableLeft, 52);
    doc.moveDown();

    let y = doc.y + 8;
    doc.rect(tableLeft, y, tableWidth, rowHeight).fill('#0B2545');
    let x = tableLeft;
    doc.fontSize(9).fillColor('#FFFFFF');
    for (const col of columns) {
      doc.text(col.label, x + 4, y + 6, { width: col.width - 8, ellipsis: true, lineBreak: false });
      x += col.width;
    }
    return y + rowHeight;
  }

  let y = drawHeader();
  let rowIndex = 0;

  const cursor = Asset.find(query).lean().cursor();
  for await (const asset of cursor) {
    if (y + rowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 30 });
      y = drawHeader();
    }

    if (rowIndex % 2 === 1) {
      doc.rect(tableLeft, y, tableWidth, rowHeight).fill('#F4F6F9');
    }

    let x = tableLeft;
    doc.fontSize(8.5).fillColor('#1A1A1A');
    const values = {
      name:      asset.name || '',
      type:      asset.type || '',
      mda:       asset.mda || '',
      state:     asset.state || '',
      lga:       asset.lga || '',
      condition: asset.condition || '',
      status:    asset.status || '',
      valuation: asset.valuation?.amount ? Number(asset.valuation.amount).toLocaleString('en-NG') : '',
    };
    for (const col of columns) {
      doc.text(String(values[col.key]), x + 4, y + 6, { width: col.width - 8, ellipsis: true, lineBreak: false });
      x += col.width;
    }

    y += rowHeight;
    rowIndex += 1;
  }

  doc.end();
}

function csvCell(val) {
  if (val == null) return '';
  const str = String(val instanceof Date ? val.toISOString() : val);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

module.exports = { sendJSON, streamCSV, streamGeoJSON, streamXLSX, streamPDF };
