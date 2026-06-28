'use strict';
const Asset          = require('../models/Asset');
const turf           = require('@turf/turf');
const AssetCodeIndex = require('../utils/assetCodeIndex');
const Mda            = require('../models/Mda');

// Roles whose own captures skip the approval queue entirely and are
// treated as verified the moment they're saved. Per product decision,
// only System Admin (the "super admin") gets this — Sub-Head and
// Supervisor captures still go through review like a Field Agent's would.
const AUTO_APPROVE_ROLES = ['System Admin'];

// ── ID generation ─────────────────────────────────────────────────────────────
// Previously sorted by createdAt to find "the last" asset and incremented its
// number. That breaks the moment any asset has a backdated/preserved
// createdAt (e.g. bulk imports carrying the original field-survey date) —
// the most-recently-inserted document isn't necessarily the highest-numbered
// one, so this could hand out an assetId that's already taken. Find the
// actual maximum numeric suffix in use instead, via aggregation so it scales
// without pulling every document to the app server.
async function nextAssetId() {
  const result = await Asset.aggregate([
    { $match: { assetId: { $regex: /^AST-\d+$/ } } },
    { $project: {
        num: { $toInt: { $substrCP: ['$assetId', 4, { $subtract: [{ $strLenCP: '$assetId' }, 4] }] } },
    }},
    { $sort: { num: -1 } },
    { $limit: 1 },
  ]);
  const max = result[0]?.num;
  return Number.isInteger(max) ? `AST-${max + 1}` : 'AST-1001';
}

// ── Asset code generation ─────────────────────────────────────────────────────
async function generateAssetCode({ mda, type, state, captureDate }) {
  // Load MDA list to resolve short codes
  const mdaList = await Mda.find({ active: true }, { name: 1, shortName: 1 }).lean().catch(() => []);

  const year   = captureDate ? new Date(captureDate).getFullYear() : new Date().getFullYear();
  const branch = AssetCodeIndex.getBranchCode(state);

  // Count existing assets with the same MDA + type + branch + year to get next seq
  const mdaCode  = AssetCodeIndex.mdaToCode(mda, mdaList);
  const typeCode = AssetCodeIndex.TYPE_CODES[type] || 'UNK';
  const prefix   = `FGN-${mdaCode}-${typeCode}-${branch}-${year}-`;

  const count = await Asset.countDocuments({
    assetCode: { $regex: `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` },
  });

  return AssetCodeIndex.buildAssetCode({ mda, type, state, year, seq: count + 1, mdaList });
}

// ── Spatial computation ───────────────────────────────────────────────────────
function computeSpatial(data) {
  if (data.geomType === 'Polygon' && data.geometry) {
    try {
      data.area = Math.round(turf.area(turf.polygon(data.geometry.coordinates || [data.geometry])));
    } catch (_) {}
  }
  if (data.geomType === 'Linear' && data.geometry) {
    try {
      data.area = Math.round(turf.length(turf.lineString(data.geometry.coordinates || [data.geometry]), { units: 'meters' }));
    } catch (_) {}
  }
  return data;
}

// ── Normalise file objects so frontend always gets _id ────────────────────────
// Schema stores fileId (GridFS ObjectId). We expose _id = fileId so the
// frontend's _fileId() helper (f._id || f.id || f.fileId) always finds it.
function normaliseFileRef(f) {
  if (!f) return f;
  const obj = f.toObject ? f.toObject() : { ...f };
  obj._id          = obj._id          || obj.fileId;
  obj.originalname = obj.originalname || obj.filename;
  obj.contentType  = obj.contentType  || obj.mimeType;
  obj.length       = obj.length       || obj.sizeBytes;
  obj.uploadDate   = obj.uploadDate   || obj.uploadedAt;
  return obj;
}

function normaliseAsset(asset) {
  if (!asset) return asset;
  asset.photos    = (asset.photos    || []).map(normaliseFileRef);
  asset.documents = (asset.documents || []).map(normaliseFileRef);
  // Expose xlDatasets as 'excel' so GET /assets/:id/excel responses match
  // what the frontend expects (r.files || r.excel)
  asset.excel     = (asset.xlDatasets || []).map(f => ({
    ...normaliseFileRef(f),
    _id: f._id || f.fileId,
  }));
  return asset;
}

// ── createAsset ───────────────────────────────────────────────────────────────
// `role` is the capturing user's role at the time of the request — pass
// req.user.role from the route handler. Used purely to decide whether this
// capture needs Sub-Head/Supervisor/Admin review before it counts as part
// of the verified registry (see AUTO_APPROVE_ROLES above).
async function createAsset(body, userId, role) {
  const MAX_RETRIES = 5;
  let lastErr;

  const autoApprove = AUTO_APPROVE_ROLES.includes(role);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const assetId   = await nextAssetId();
    const assetCode = await generateAssetCode({
      mda:         body.mda,
      type:        body.type,
      state:       body.state,
      captureDate: body.captureDate,
    });

    const data = computeSpatial({
      ...body,
      assetId,
      assetCode,
      capturedBy: userId,
      location: {
        type: 'Point',
        coordinates: body.coordinates,
      },
      approvalStatus: autoApprove ? 'Approved' : 'Pending',
      submittedBy:    autoApprove ? undefined  : userId,
      reviewedBy:     autoApprove ? userId      : undefined,
      reviewedAt:     autoApprove ? new Date()  : undefined,
    });
    delete data.coordinates;

    try {
      const asset = await Asset.create(data);
      return normaliseAsset(asset.toObject());
    } catch (err) {
      // Duplicate assetId or assetCode — most likely two requests racing for
      // the same next ID / sequence number. assetCode's seq is derived from
      // countDocuments on a prefix match, which has the same race exposure
      // nextAssetId used to. Recompute both and retry rather than a 500.
      const dupField = err?.code === 11000 ? Object.keys(err.keyPattern || {})[0] : null;
      if (dupField === 'assetId' || dupField === 'assetCode') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ── listAssets ────────────────────────────────────────────────────────────────
async function listAssets({
  type, condition, state, lga, geomType, status, approvalStatus,
  page = 1, limit = 50,
  scopeFilter = {},
} = {}) {
  const _page  = Math.max(1, parseInt(page,  10) || 1);
  const _limit = Math.min(200, parseInt(limit, 10) || 50);
  const skip   = (_page - 1) * _limit;

  const filter = { ...scopeFilter };
  if (type)      filter.type      = type;
  if (condition) filter.condition = condition;
  if (state)     filter.state     = state;
  if (lga)       filter.lga       = lga;
  if (geomType)  filter.geomType  = geomType;
  if (status)    filter.status    = status;

  // ── Approval gate ──────────────────────────────────────────────────────
  // The main registry (dashboard, map, asset list, exports) should never
  // show unverified data by default. Existing/legacy assets have no
  // approvalStatus value at all, so we exclude by *what we don't want*
  // ($nin Pending/Rejected) rather than filtering for 'Approved' — a strict
  // equality filter would incorrectly hide every asset that predates this
  // field. Callers that explicitly want the pending/rejected queue (the
  // approvals routes) pass approvalStatus directly; 'all' bypasses the gate.
  if (approvalStatus === 'all') {
    // no filter — full unfiltered view
  } else if (approvalStatus) {
    filter.approvalStatus = approvalStatus;
  } else {
    filter.approvalStatus = { $nin: ['Pending', 'Rejected'] };
  }

  const [assets, total] = await Promise.all([
    Asset.find(filter).skip(skip).limit(_limit).sort({ createdAt: -1 }).lean(),
    Asset.countDocuments(filter),
  ]);

  return {
    assets: assets.map(normaliseAsset),
    total,
    page:   _page,
    pages:  Math.ceil(total / _limit),
  };
}

// ── getAsset ──────────────────────────────────────────────────────────────────
async function getAsset(id) {
  // Support lookup by assetId (AST-XXXX), assetCode (FGN-...), or MongoDB _id
  let query;
  if (id.startsWith('AST-') || id.startsWith('FGN-')) query = { assetId: id };
  else                                                   query = { _id: id };

  const asset = await Asset.findOne(query)
    .populate('capturedBy', 'name email role')
    .populate('submittedBy', 'name email role')
    .populate('reviewedBy', 'name email role')
    .lean();
  return normaliseAsset(asset);
}

// ── updateAsset ───────────────────────────────────────────────────────────────
async function updateAsset(id, body) {
  const query = (id.startsWith('AST-') || id.startsWith('FGN-')) ? { assetId: id } : { _id: id };

  // Strip fields that must never be overwritten via $set
  const {
    previousCondition,
    conditionHistory: _ch,
    _id, __v,
    assetId:    _aid,
    capturedBy: _cb,
    photos:     _p,
    documents:  _d,
    xlDatasets: _xl,
    excel:      _ex,
    approvalStatus:   _as,
    submittedBy:      _sb,
    reviewedBy:       _rb,
    reviewedAt:       _ra,
    rejectionReason:  _rr,
    ...fields
  } = body;

  const data = computeSpatial({ ...fields });

  if (body.coordinates && Array.isArray(body.coordinates)) {
    data.location = { type: 'Point', coordinates: body.coordinates };
    delete data.coordinates;
  }

  const update = { $set: data };

  if (previousCondition && fields.condition && previousCondition !== fields.condition) {
    update.$push = {
      conditionHistory: {
        from:      previousCondition,
        to:        fields.condition,
        changedAt: new Date(),
      },
    };
  }

  const asset = await Asset.findOneAndUpdate(query, update, {
    new:           true,
    runValidators: false,
  }).lean();

  return normaliseAsset(asset);
}

// ── deleteAsset ───────────────────────────────────────────────────────────────
async function deleteAsset(id) {
  const query = (id.startsWith('AST-') || id.startsWith('FGN-')) ? { assetId: id } : { _id: id };
  return Asset.findOneAndDelete(query).lean();
}

// ── searchAssets ──────────────────────────────────────────────────────────────
async function searchAssets(q, scopeFilter = {}) {
  // Use regex so partial matches work from the first character typed.
  // $text requires complete words; regex matches substrings instantly.
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'i');

  const assets = await Asset.find({
    ...scopeFilter,
    approvalStatus: { $nin: ['Pending', 'Rejected'] },
    $or: [
      { name:      re },
      { assetId:   re },
      { assetCode: re },
      { state:     re },
      { lga:       re },
      { mda:       re },
      { type:      re },
      { address:   re },
      { notes:     re },
    ],
  })
    .limit(100)
    .sort({ createdAt: -1 })
    .lean();

  return assets.map(normaliseAsset);
}

// ── Approval workflow ─────────────────────────────────────────────────────────

// listPendingApprovals — used by the new asset-approvals routes.
// `status` defaults to 'Pending'; pass 'Rejected' / 'Approved' / 'all' to
// view other buckets (e.g. a Field Agent checking on their own rejected items).
async function listPendingApprovals({ status = 'Pending', page = 1, limit = 50, scopeFilter = {} } = {}) {
  const _page  = Math.max(1, parseInt(page,  10) || 1);
  const _limit = Math.min(200, parseInt(limit, 10) || 50);
  const skip   = (_page - 1) * _limit;

  const filter = { ...scopeFilter };
  if (status && status !== 'all') filter.approvalStatus = status;

  const [assets, total] = await Promise.all([
    Asset.find(filter)
      .populate('submittedBy', 'name email role')
      .populate('capturedBy',  'name email role')
      .populate('reviewedBy',  'name email role')
      .skip(skip).limit(_limit).sort({ createdAt: -1 }).lean(),
    Asset.countDocuments(filter),
  ]);

  return {
    assets: assets.map(normaliseAsset),
    total,
    page:   _page,
    pages:  Math.ceil(total / _limit),
  };
}

// approveAsset — marks a Pending asset as Approved. Returns null if the
// asset doesn't exist; throws a tagged error if it's not currently Pending
// or if the reviewer is the same person who submitted it (no self-approval).
async function approveAsset(id, reviewerId) {
  const query = (id.startsWith('AST-') || id.startsWith('FGN-')) ? { assetId: id } : { _id: id };
  const asset = await Asset.findOne(query);
  if (!asset) return null;

  if (asset.approvalStatus !== 'Pending') {
    const err = new Error(`Asset is ${asset.approvalStatus}, not Pending`);
    err.statusCode = 400;
    throw err;
  }
  if (asset.submittedBy && asset.submittedBy.toString() === reviewerId.toString()) {
    const err = new Error('You cannot approve an asset you submitted yourself');
    err.statusCode = 403;
    throw err;
  }

  asset.approvalStatus = 'Approved';
  asset.reviewedBy      = reviewerId;
  asset.reviewedAt       = new Date();
  asset.rejectionReason  = undefined;
  await asset.save();
  return normaliseAsset(asset.toObject());
}

// rejectAsset — marks a Pending asset as Rejected with an optional reason.
async function rejectAsset(id, reviewerId, reason) {
  const query = (id.startsWith('AST-') || id.startsWith('FGN-')) ? { assetId: id } : { _id: id };
  const asset = await Asset.findOne(query);
  if (!asset) return null;

  if (asset.approvalStatus !== 'Pending') {
    const err = new Error(`Asset is ${asset.approvalStatus}, not Pending`);
    err.statusCode = 400;
    throw err;
  }
  if (asset.submittedBy && asset.submittedBy.toString() === reviewerId.toString()) {
    const err = new Error('You cannot reject an asset you submitted yourself');
    err.statusCode = 403;
    throw err;
  }

  asset.approvalStatus  = 'Rejected';
  asset.reviewedBy       = reviewerId;
  asset.reviewedAt        = new Date();
  asset.rejectionReason   = reason || '';
  await asset.save();
  return normaliseAsset(asset.toObject());
}

// approvalsSummary — counts for a dashboard / sidebar badge.
async function approvalsSummary(scopeFilter = {}) {
  const [pending, approved, rejected] = await Promise.all([
    Asset.countDocuments({ ...scopeFilter, approvalStatus: 'Pending' }),
    Asset.countDocuments({ ...scopeFilter, approvalStatus: 'Approved' }),
    Asset.countDocuments({ ...scopeFilter, approvalStatus: 'Rejected' }),
  ]);
  return { pending, approved, rejected };
}

module.exports = {
  createAsset, listAssets, getAsset, updateAsset, deleteAsset, searchAssets, generateAssetCode,
  listPendingApprovals, approveAsset, rejectAsset, approvalsSummary,
};