'use strict';
const Joi = require('joi');

/**
 * Returns an Express middleware that validates req.body against a Joi schema.
 */
function validateBody(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false, stripUnknown: true });
    if (error) {
      return res.status(422).json({
        error: 'Validation failed',
        details: error.details.map((d) => d.message),
      });
    }
    req.body = value;
    next();
  };
}

function validateQuery(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.query, { abortEarly: false, allowUnknown: true });
    if (error) {
      return res.status(422).json({
        error: 'Invalid query parameters',
        details: error.details.map((d) => d.message),
      });
    }
    req.query = value;
    next();
  };
}

// ── Shared schemas ────────────────────────────────────────────────────────────

const coordinatesSchema = Joi.array().items(Joi.number()).length(2).required()
  .description('[longitude, latitude]');

const schemas = {
  // Auth
  login: Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  // Asset creation / update
  asset: Joi.object({
    name:        Joi.string().required(),
    type:        Joi.string().valid('Infrastructure', 'Land / Property', 'Utility', 'Environmental', 'Equipment').required(),
    geomType:    Joi.string().valid('Point', 'Polygon', 'Linear').default('Point'),
    coordinates: coordinatesSchema,
    geometry:    Joi.object(),            // GeoJSON for polygon/linear
    condition:   Joi.string().valid('Good', 'Fair', 'Poor', 'Critical'),
    material:    Joi.string().allow(''),
    elevation:   Joi.number(),
    notes:       Joi.string().allow(''),
    typeData:    Joi.object().default({}),
    mda:         Joi.string().allow(''),
    state:       Joi.string().allow(''),
    lga:         Joi.string().allow(''),
    address:     Joi.string().allow(''),
    status:      Joi.string().valid('Active', 'Under Maintenance', 'Decommissioned', 'Disputed', 'Recovered'),
    captureDate: Joi.date(),
    qrPayload:   Joi.string().allow(''),
  }),

  // User creation
  createUser: Joi.object({
    name:     Joi.string().required(),
    email:    Joi.string().email().required(),
    role:     Joi.string().valid('Field Agent', 'Sub-Head', 'Supervisor', 'GIS Analyst', 'System Admin').required(),
    password: Joi.string().min(8).required(),
    color:    Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/),
    zone:     Joi.string().allow(''),
    states:   Joi.array().items(Joi.string()),
    lgas:     Joi.array().items(Joi.string()),
  }),

  // User update
  updateUser: Joi.object({
    name:   Joi.string(),
    role:   Joi.string().valid('Field Agent', 'Sub-Head', 'Supervisor', 'GIS Analyst', 'System Admin'),
    color:  Joi.string().pattern(/^#[0-9A-Fa-f]{6}$/),
    zone:   Joi.string().allow(''),
    states: Joi.array().items(Joi.string()),
    lgas:   Joi.array().items(Joi.string()),
  }),

  // Permission overrides — short key names matching the frontend and User model
  permissions: Joi.object({
    canCreate:         Joi.boolean(),
    canEdit:           Joi.boolean(),
    canDelete:         Joi.boolean(),
    canApprove:        Joi.boolean(),
    canExport:         Joi.boolean(),
    canViewAll:        Joi.boolean(),
    canManageUsers:    Joi.boolean(),
    canViewAudit:      Joi.boolean(),
    canManageSettings: Joi.boolean(),
  }),

  // Maintenance log entry
  maintenanceLog: Joi.object({
    date: Joi.date().required(),
    desc: Joi.string().required(),
    tech: Joi.string().allow(''),
    cost: Joi.number().min(0),
  }),

  // Valuation
  valuation: Joi.object({
    amount:   Joi.number().required(),
    currency: Joi.string().default('NGN'),
    valuedAt: Joi.date(),
    method:   Joi.string().valid('Replacement Cost', 'Market Comparable', 'Depreciated'),
  }),

  // Asset approval / rejection
  assetReject: Joi.object({
    reason: Joi.string().allow('').max(1000),
  }),
};

module.exports = { validateBody, validateQuery, schemas };