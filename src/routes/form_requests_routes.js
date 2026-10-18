'use strict';
// ── FORM REQUESTS ROUTES ──────────────────────────────────────────────────────
// Mount at: app.use('/api/form-requests', require('./routes/form_requests_routes'));
//
//   GET    /api/form-requests                    — list (scoped: MDA Agent sees own MDA only)
//   GET    /api/form-requests/:id                — single request detail
//   POST   /api/form-requests                    — create/submit
//   PATCH  /api/form-requests/:id                — update (draft edit, or FPAM review action)
//   POST   /api/form-requests/:id/attachments    — upload a supporting document
//   POST   /api/form-requests/:id/issue-certificate — mark certificate issued + attach PDF
//   POST   /api/form-requests/:id/mark-physical-issued — record physical copy handed out
//   DELETE /api/form-requests/:id                — delete a Draft (submitter or FPAM)
//
// AUTHORIZATION MODEL (the core of this feature):
//   - MDA Agent: canSubmitFormRequests only. Can create/view/edit-while-draft
//     requests for THEIR OWN mda ONLY — mda is forced server-side from
//     req.user.mda on every create, never trusted from the request body.
//   - Supervisor / Sub-Head / System Admin: canReviewFormRequests. Can view
//     ALL requests across every MDA, create a request on behalf of ANY MDA
//     of their choosing, review/approve/reject/defer, and issue certificates.

const router  = require('express').Router();
const multer  = require('multer');
const FormRequest = require('../models/FormRequest');

const { authenticate }                    = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');
const { auditLog }                        = require('../middleware/auditMiddleware');
const photoSvc = require('../services/photoService');  // reused for generic GridFS storage

const auth = [authenticate, resolvePermissions];

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 15 * 1024 * 1024 },
});

const REVIEWER_ROLES = ['Supervisor', 'Sub-Head', 'System Admin'];
// Which FormRequest field holds each form type's data.
const FIELD_MAP = {
  // NOTE: this intentionally duplicates form_field_defs.js's
  // FORM_DATA_FIELD — form_field_defs.js is a frontend-only file
  // (served as a <script> tag to mda_portal.html/form_requests.html)
  // and isn't deployed to the backend at all, so this route file has
  // no filesystem path to it and can't require() it. This map has to
  // be kept in sync by hand whenever a form type is added or
  // renamed — both this file AND form_field_defs.js need the update,
  // as happened when SECURITY_SERVICES_COST_TEMPLATE and
  // JANITORIAL_SERVICES_COST_TEMPLATE were added.
  MAINTENANCE_COMPLIANCE_DECLARATION: 'complianceDeclaration',
  ASSET_INVENTORY_DECLARATION:        'inventoryDeclaration',
  PREVENTIVE_MAINTENANCE_SCHEDULE:    'pmSchedule',
  MAINTENANCE_ACTIVITY_REPORT:        'activityReport',
  MAINTENANCE_INCIDENT_REPORT:        'incidentReport',
  MAINTENANCE_WORK_ORDER:             'workOrder',
  ASSET_CONDITION_ASSESSMENT:         'conditionAssessment',
  SERVICE_PROVIDER_CERTIFICATION:     'providerCertification',
  BUDGET_ALLOCATION_UTILIZATION:      'budgetAllocation',
  TRAINING_CAPACITY_BUILDING:         'trainingCompliance',
  HSE_COMPLIANCE_CHECKLIST:           'hseChecklist',
  AUDIT_RESPONSE_CORRECTIVE_ACTION:   'auditResponse',
  CERTIFICATION_REQUEST:              'certificationRequest',
  EQUIPMENT_CALIBRATION_CERTIFICATE:  'calibrationSubmission',
  EQUIPMENT_DISPOSAL_DECOMMISSIONING: 'disposalDecommissioning',
  SECURITY_SERVICES_COST_TEMPLATE:    'securityServicesCost',
  JANITORIAL_SERVICES_COST_TEMPLATE:  'janitorialServicesCost',
};

function isReviewer(req) {
  return REVIEWER_ROLES.includes(req.user.role) && req.permissions?.canReviewFormRequests === true;
}

// ── Scope filter — the heart of the access model ──────────────────────────────
function scopeQuery(req) {
  if (req.user.role === 'MDA Agent') {
    // Hard server-side lock — an MDA Agent can NEVER see another MDA's
    // requests, regardless of what query params are sent.
    return { mda: req.user.mda };
  }
  // FPAM reviewers see everything; optional ?mda= filter for convenience.
  const q = {};
  if (req.query.mda) q.mda = req.query.mda;
  if (req.query.status) q.status = req.query.status;
  if (req.query.formType) q.formType = req.query.formType;
  return q;
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST
// ═══════════════════════════════════════════════════════════════════════════
router.get('/', ...auth, async (req, res, next) => {
  try {
    const requests = await FormRequest.find(scopeQuery(req))
      .sort({ createdAt: -1 })
      .populate('submittedBy', 'name email')
      .populate('reviewedBy', 'name')
      .lean();
    res.json({ requests, total: requests.length });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET ONE
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id', ...auth, async (req, res, next) => {
  try {
    const request = await FormRequest.findById(req.params.id)
      .populate('submittedBy', 'name email')
      .populate('reviewedBy', 'name')
      .lean();
    if (!request) return res.status(404).json({ error: 'Request not found' });

    // Defense-in-depth: even though list is scoped, block direct-by-id access
    // to another MDA's request for an MDA Agent.
    if (req.user.role === 'MDA Agent' && request.mda !== req.user.mda) {
      return res.status(403).json({ error: 'Not authorized to view this request' });
    }

    res.json({ request });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════
router.post('/',
  ...auth,
  auditLog('FORM_REQUEST_SUBMITTED', 'FormRequest'),
  async (req, res, next) => {
    try {
      // Either an MDA Agent (canSubmitFormRequests) or an FPAM reviewer may
      // create a request — checked explicitly here rather than via
      // requirePerm(), since submit-vs-review are two different permissions
      // that both grant creation rights, and combining them cleanly depends
      // on requirePerm's exact signature.
      const canCreate = req.permissions?.canSubmitFormRequests === true || isReviewer(req);
      if (!canCreate) {
        return res.status(403).json({ error: 'Not authorized to submit form requests' });
      }

      const { formType, linkedAssetId, status, attachments, ...formData } = req.body;

      if (!FormRequest.FORM_TYPES.includes(formType)) {
        return res.status(400).json({ error: 'Invalid formType' });
      }

      // MDA lock — the whole point of the access model.
      let mda;
      if (req.user.role === 'MDA Agent') {
        mda = req.user.mda;
        if (!mda) return res.status(400).json({ error: 'Your account has no MDA assigned — contact your System Admin' });
      } else if (isReviewer(req)) {
        mda = req.body.mda;
        if (!mda) return res.status(400).json({ error: 'mda is required when creating on behalf of an MDA' });
      } else {
        return res.status(403).json({ error: 'Not authorized to submit form requests' });
      }

      const doc = new FormRequest({
        formType,
        mda,
        linkedAssetId: linkedAssetId || null,
        submittedBy:   req.user._id,
        status:        status === 'Draft' ? 'Draft' : 'Submitted',
      });

      // Map formType -> the correct embedded sub-document field name, e.g.
      // MAINTENANCE_COMPLIANCE_DECLARATION -> complianceDeclaration
      const field = FIELD_MAP[formType];
      doc[field] = formData[field] || formData;   // accept either nested or flat body shape

      await doc.save();

      res.locals.auditEntityId = String(doc._id);
      res.locals.auditDetail   = `${formType} submitted for ${mda}`;
      res.status(201).json({ request: doc });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE — draft edits (submitter) OR review action (FPAM reviewer)
// ═══════════════════════════════════════════════════════════════════════════
router.patch('/:id',
  ...auth,
  auditLog('FORM_REQUEST_UPDATED', 'FormRequest'),
  async (req, res, next) => {
    try {
      const request = await FormRequest.findById(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });

      const reviewing = isReviewer(req);
      const isOwner = String(request.submittedBy) === String(req.user._id);

      if (!reviewing && !isOwner) {
        return res.status(403).json({ error: 'Not authorized to modify this request' });
      }
      if (!reviewing && request.mda !== req.user.mda) {
        return res.status(403).json({ error: 'Not authorized to modify this request' });
      }
      // Submitters can only edit while still Draft — once Submitted, it's
      // locked pending FPAM review to preserve the integrity of what was
      // actually filed.
      if (!reviewing && request.status !== 'Draft') {
        return res.status(400).json({ error: 'This request has already been submitted and can no longer be edited' });
      }

      if (reviewing) {
        // Review action — status change, remarks, etc.
        const { status, reviewRemarks, reviewStatusDetail } = req.body;
        if (status) request.status = status;
        if (reviewRemarks !== undefined) request.reviewRemarks = reviewRemarks;
        if (reviewStatusDetail !== undefined) request.reviewStatusDetail = reviewStatusDetail;
        request.reviewedBy = req.user._id;
        request.reviewedAt = new Date();
      } else {
        // Owners may only change their own form data, the linked asset, and
        // move Draft -> Submitted. Previously the whole body was copied onto
        // the document, so an owner could send status:'Approved',
        // certificateIssued:true, reviewRemarks, etc. and approve or
        // "certify" their own request.
        const field = FIELD_MAP[request.formType];
        const { status, linkedAssetId } = req.body;
        const data = req.body[field];
        if (data && typeof data === 'object') request[field] = data;
        if (linkedAssetId !== undefined) request.linkedAssetId = linkedAssetId || null;
        if (status === 'Submitted') request.status = 'Submitted';
        else if (status && status !== 'Draft') {
          return res.status(403).json({ error: 'Only a reviewer can change the status beyond Submitted' });
        }
      }

      await request.save();

      res.locals.auditEntityId = String(request._id);
      res.locals.auditDetail   = reviewing
        ? `Reviewed — status set to ${request.status}`
        : `Draft updated`;
      res.json({ request });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// ATTACHMENTS
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:id/attachments',
  ...auth,
  upload.single('file'),
  auditLog('FORM_REQUEST_ATTACHMENT_ADDED', 'FormRequest'),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

      const request = await FormRequest.findById(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });

      const isOwner = String(request.submittedBy) === String(req.user._id);
      if (!isReviewer(req) && (!isOwner || request.mda !== req.user.mda)) {
        return res.status(403).json({ error: 'Not authorized' });
      }

      const result = await photoSvc.storeGenericFile(req.file, request._id.toString(), req.user._id.toString());

      request.attachments.push({
        fileId:       result.fileId,
        filename:     result.filename,
        originalname: req.file.originalname,
        contentType:  req.file.mimetype,
        sizeBytes:    req.file.size,
        label:        req.body.label || '',
      });
      await request.save();

      res.locals.auditEntityId = String(request._id);
      res.status(201).json({ attachment: request.attachments[request.attachments.length - 1] });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// ISSUE CERTIFICATE — PDF generated client-side (jsPDF, matching the M&E
// clearance-certificate pattern already in me.html), uploaded here for
// storage + record-keeping.
// ═══════════════════════════════════════════════════════════════════════════
router.post('/:id/issue-certificate',
  ...auth,
  requirePerm('canReviewFormRequests'),
  upload.single('certificate'),
  auditLog('CERTIFICATE_ISSUED', 'FormRequest'),
  async (req, res, next) => {
    try {
      const request = await FormRequest.findById(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });
      if (!req.file) return res.status(400).json({ error: 'No certificate PDF uploaded' });

      const result = await photoSvc.storeGenericFile(req.file, request._id.toString(), req.user._id.toString());

      request.certificateIssued   = true;
      request.certificateFileId   = result.fileId;
      request.certificateIssuedBy = req.user._id;
      request.certificateIssuedAt = new Date();
      request.certificateNumber   = req.body.certificateNumber
        || `FPAM/CERT/${new Date().getFullYear()}/${String(request._id).slice(-6).toUpperCase()}`;
      if (request.status !== 'Approved') request.status = 'Approved';

      await request.save();

      res.locals.auditEntityId = String(request._id);
      res.locals.auditDetail   = `Certificate ${request.certificateNumber} issued`;
      res.json({ request });
    } catch (err) { next(err); }
  }
);

// Record that the physical/printed copy was also handed out — per your
// process, a physical equivalent is issued alongside the digital PDF.
router.post('/:id/mark-physical-issued',
  ...auth,
  requirePerm('canReviewFormRequests'),
  auditLog('CERTIFICATE_PHYSICAL_COPY_ISSUED', 'FormRequest'),
  async (req, res, next) => {
    try {
      const request = await FormRequest.findById(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });

      request.physicalCopyIssued   = true;
      request.physicalCopyIssuedAt = new Date();
      await request.save();

      res.locals.auditEntityId = String(request._id);
      res.json({ request });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// DELETE — only a Draft may be deleted (submitter or FPAM)
// ═══════════════════════════════════════════════════════════════════════════
router.delete('/:id',
  ...auth,
  auditLog('FORM_REQUEST_DELETED', 'FormRequest'),
  async (req, res, next) => {
    try {
      const request = await FormRequest.findById(req.params.id);
      if (!request) return res.status(404).json({ error: 'Request not found' });

      const isOwner = String(request.submittedBy) === String(req.user._id);
      if (!isReviewer(req) && !isOwner) {
        return res.status(403).json({ error: 'Not authorized' });
      }
      if (request.status !== 'Draft') {
        return res.status(400).json({ error: 'Only Draft requests can be deleted' });
      }

      await request.deleteOne();
      res.locals.auditEntityId = req.params.id;
      res.json({ message: 'Request deleted' });
    } catch (err) { next(err); }
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// DOWNLOAD CERTIFICATE — streams the issued PDF. Scoped the same way as
// GET /:id: an MDA Agent can only pull a certificate belonging to their MDA.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id/certificate', ...auth, async (req, res, next) => {
  try {
    const request = await FormRequest.findById(req.params.id).lean();
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (req.user.role === 'MDA Agent' && request.mda !== req.user.mda) {
      return res.status(403).json({ error: 'Not authorized to view this certificate' });
    }
    if (!request.certificateIssued || !request.certificateFileId) {
      return res.status(404).json({ error: 'No certificate has been issued for this request' });
    }

    const found = await photoSvc.streamGenericFile(request.certificateFileId, res);
    if (!found) res.status(404).json({ error: 'Certificate file not found in storage' });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// DOWNLOAD ONE ATTACHMENT — the upload side of this (POST /:id/attachments
// above) has existed since the beginning, but there was never a matching
// download route, and neither mda_portal.js nor form_requests.js ever
// called it — the whole attachment feature had no way in OR out on the
// frontend. This is the "out" half; the frontend upload/download UI is a
// separate, larger addition.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id/attachments/:attachmentId', ...auth, async (req, res, next) => {
  try {
    const request = await FormRequest.findById(req.params.id).lean();
    if (!request) return res.status(404).json({ error: 'Request not found' });

    // Same ownership rule as the POST above: FPAM reviewers see everything,
    // an MDA Agent only their own MDA's requests.
    if (req.user.role === 'MDA Agent' && request.mda !== req.user.mda) {
      return res.status(403).json({ error: 'Not authorized to view this attachment' });
    }

    const attachment = (request.attachments || []).find(a => String(a._id) === req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    const found = await photoSvc.streamGenericFile(attachment.fileId, res);
    if (!found) res.status(404).json({ error: 'Attachment file not found in storage' });
  } catch (err) { next(err); }
});

// ═══════════════════════════════════════════════════════════════════════════
// FORM TYPE METADATA — lets the frontend build the form list dynamically
// ═══════════════════════════════════════════════════════════════════════════
router.get('/meta/form-types', ...auth, (req, res) => {
  res.json({ formTypes: FormRequest.FORM_TYPES, statuses: FormRequest.STATUS_VALUES });
});

module.exports = router;