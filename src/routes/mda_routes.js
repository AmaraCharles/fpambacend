/**
 * AssetSpatial — MDA Routes
 * Mount at: app.use('/api/mdas', require('./routes/mda_routes'));
 *
 * GET    /api/mdas              — list all active MDAs
 * POST   /api/mdas              — create one (Admin only)
 * PUT    /api/mdas/:id          — update one (Admin only)
 * DELETE /api/mdas/:id          — soft-delete / deactivate (Admin only)
 * POST   /api/mdas/import-csv   — bulk import from CSV text body (Admin only)
 * POST   /api/mdas/seed         — seed 31 default MDAs if collection is empty (Admin only)
 */

const router  = require('express').Router();
const Mda     = require('../models/Mda');
const MDA_SEED = require('../seeds/mdaSeed');

// ── Auth middleware — same pattern as every other route in this project ───────
const { authenticate }                    = require('../middleware/auth');
const { resolvePermissions, requirePerm } = require('../middleware/resolvePermissions');

const requireAuth  = authenticate;
const requireAdmin = (req, res, next) => {
  if (req.user && (req.user.role === 'System Admin' || req.user.role === 'admin')) return next();
  return res.status(403).json({ error: 'Admin only' });
};

// ── GET /api/mdas — public to all authenticated users ────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    // ?includeInactive=1 (System Admin only) also returns deactivated MDAs,
    // so they can be found and reactivated — otherwise a deleted MDA was
    // invisible and re-adding its name failed with "already exists".
    const isAdmin = req.user && (req.user.role === 'System Admin' || req.user.role === 'admin');
    const filter = req.query.includeInactive === '1' && isAdmin ? {} : { active: true };
    if (req.query.category) filter.category = req.query.category;
    const mdas = await Mda.find(filter).sort({ name: 1 }).lean();
    res.json({ mdas });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mdas — create one ──────────────────────────────────────────────
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, shortName, category } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const mda = await Mda.create({
      name: name.trim(),
      shortName: (shortName || '').trim(),
      category: category || 'Ministry',
      createdBy: req.user?._id,
    });
    res.status(201).json({ mda });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'MDA with that name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/mdas/:id — update ───────────────────────────────────────────────
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { name, shortName, category, active } = req.body;
    const update = {};
    if (name      !== undefined) update.name      = name.trim();
    if (shortName !== undefined) update.shortName = shortName.trim();
    if (category  !== undefined) update.category  = category;
    if (active    !== undefined) update.active     = active;

    const mda = await Mda.findByIdAndUpdate(
      req.params.id,
      { $set: update },
      { new: true, runValidators: false }
    );
    if (!mda) return res.status(404).json({ error: 'MDA not found' });
    res.json({ mda });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/mdas/:id — soft delete (sets active:false) ──────────────────
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const mda = await Mda.findByIdAndUpdate(
      req.params.id,
      { $set: { active: false } },
      { new: true }
    );
    if (!mda) return res.status(404).json({ error: 'MDA not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mdas/import-csv — bulk import ──────────────────────────────────
// Body: { csv: "Name,ShortName,Category\nFed Min of Works,FMWH,Ministry\n..." }
// OR:   { names: ["Fed Min of Works", "EFCC", ...] }  (simple name-only array)
router.post('/import-csv', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { csv, names } = req.body;
    let rows = [];

    if (names && Array.isArray(names)) {
      // Simple array of name strings
      rows = names
        .map(n => ({ name: String(n).trim(), shortName: '', category: 'Ministry' }))
        .filter(r => r.name);
    } else if (csv) {
      // Parse CSV — first line may or may not be a header
      const lines = String(csv).split(/\r?\n/).filter(l => l.trim());
      // Detect header: if first line contains 'name' (case-insensitive), skip it
      const startIdx = lines[0].toLowerCase().includes('name') ? 1 : 0;
      for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        if (!parts[0]) continue;
        rows.push({
          name:      parts[0],
          shortName: parts[1] || '',
          category:  ['Ministry','Department','Agency','Commission','Other'].includes(parts[2])
                       ? parts[2] : 'Ministry',
        });
      }
    } else {
      return res.status(400).json({ error: 'Provide csv string or names array' });
    }

    if (!rows.length) return res.status(400).json({ error: 'No valid rows found' });

    // Upsert — insert new, skip existing names
    let created = 0, skipped = 0;
    for (const row of rows) {
      try {
        await Mda.create({ ...row, createdBy: req.user?._id });
        created++;
      } catch (e) {
        if (e.code === 11000) skipped++; // duplicate
        else throw e;
      }
    }

    res.json({ ok: true, created, skipped, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/mdas/seed — seed defaults if empty ─────────────────────────────
router.post('/seed', requireAuth, requireAdmin, async (req, res) => {
  try {
    const count = await Mda.countDocuments();
    if (count > 0 && !req.body.force) {
      return res.json({ ok: true, message: `Collection already has ${count} MDAs. Pass force:true to re-seed.`, seeded: 0 });
    }
    let seeded = 0;
    for (const row of MDA_SEED) {
      try {
        await Mda.create(row);
        seeded++;
      } catch (e) {
        if (e.code !== 11000) throw e;
      }
    }
    res.json({ ok: true, seeded });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-seed helper — call this from your main server startup ───────────────
async function autoSeedMdas() {
  try {
    const count = await Mda.countDocuments();
    if (count === 0) {
      let seeded = 0;
      for (const row of MDA_SEED) {
        try { await Mda.create(row); seeded++; } catch {}
      }
      console.log(`[MDA] Auto-seeded ${seeded} MDAs`);
    }
  } catch (e) {
    console.error('[MDA] Auto-seed error:', e.message);
  }
}

router.autoSeedMdas = autoSeedMdas;
module.exports = router;