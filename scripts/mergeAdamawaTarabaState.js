'use strict';
/**
 * mergeAdamawaTarabaState.js
 * ─────────────────────────────────────────────────────────────────────────
 * Changes every asset whose state is the combined value "Adamawa and Taraba"
 * to just "Taraba".
 *
 *   node scripts/mergeAdamawaTarabaState.js            # dry run — shows what would change
 *   node scripts/mergeAdamawaTarabaState.js --apply    # makes the change
 *
 * Connects with the same MONGO_URI / MONGO_DB_NAME as the app (.env).
 *
 * Matching is forgiving about case, spacing and "and" vs "&" ("Adamawa and
 * Taraba", "ADAMAWA & TARABA", "Adamawa  and Taraba "…). The dry run lists
 * every distinct spelling it found, plus any other state values mentioning
 * both names that it did NOT match, so nothing is changed by surprise.
 *
 * dupKey: assets carry dupKey = "name|state|mda" (lower-cased) with a unique
 * index, normally recomputed by the model's pre-validate hook. A bulk update
 * bypasses that hook, so this script recomputes dupKey itself. If an asset
 * with the same name and MDA already exists under "Taraba", changing this one
 * would duplicate it and violate the index — those are skipped and listed for
 * manual review instead.
 *
 * Asset codes are not touched: a code is a permanent identifier (it is on
 * printed documents and referenced by inspection codes), so codes that were
 * minted with the combined state keep their existing branch segment.
 *
 * Safe to re-run: once applied there is nothing left to match.
 */

const mongoose = require('mongoose');
const env = require('../src/config/env');

const TARGET = 'Taraba';
const COMBINED = /^\s*adamawa\s*(and|&)\s*taraba\s*$/i;
const APPLY = process.argv.includes('--apply');

const dupKeyOf = (name, state, mda) =>
  [name, state, mda].map(s => String(s).trim().toLowerCase()).join('|');

async function run() {
  await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
  const db = mongoose.connection.db;
  const assets = db.collection('assets');
  console.log(`[merge-state] Connected to database "${db.databaseName}"${APPLY ? '' : ' — DRY RUN (add --apply to make changes)'}`);

  // What's actually in the data, so the match can be checked by eye.
  const spellings = await assets.aggregate([
    { $match: { state: { $regex: 'adamawa', $options: 'i' } } },
    { $match: { state: { $regex: 'taraba', $options: 'i' } } },
    { $group: { _id: '$state', n: { $sum: 1 } } },
  ]).toArray();
  const matched = spellings.filter(s => COMBINED.test(s._id || ''));
  const unmatched = spellings.filter(s => !COMBINED.test(s._id || ''));
  console.log('[merge-state] Will change:', matched.length ? matched.map(s => `"${s._id}" (${s.n})`).join(', ') : 'nothing');
  if (unmatched.length) {
    console.log('[merge-state] Mentions both states but NOT matched (left alone):',
      unmatched.map(s => `"${s._id}" (${s.n})`).join(', '));
  }
  if (!matched.length) return;

  const docs = await assets.find(
    { state: { $in: matched.map(s => s._id) } },
    { projection: { name: 1, state: 1, mda: 1, parentId: 1, assetId: 1, assetCode: 1 } },
  ).toArray();

  const ops = [];
  const conflicts = [];
  const plannedKeys = new Map();     // two combined-state assets that would collide with each other
  for (const a of docs) {
    // Same rule as computeDupKey() in src/models/Asset.js.
    const key = !a.parentId && a.name && a.mda ? dupKeyOf(a.name, TARGET, a.mda) : null;
    if (key) {
      const clash = await assets.findOne({ dupKey: key, _id: { $ne: a._id } }, { projection: { assetId: 1, assetCode: 1 } });
      const twin = plannedKeys.get(key);
      if (clash || twin) {
        conflicts.push({ a, other: clash || twin });
        continue;
      }
      plannedKeys.set(key, a);
    }
    ops.push({ updateOne: { filter: { _id: a._id }, update: { $set: { state: TARGET, dupKey: key } } } });
  }

  console.log(`[merge-state] ${docs.length} asset(s) found; ${ops.length} to update, ${conflicts.length} skipped.`);
  docs.slice(0, 20).forEach(a => console.log(`   ${a.assetId || a._id}  ${a.assetCode || ''}  "${a.name}"  (${a.mda || 'no MDA'})`));
  if (docs.length > 20) console.log(`   … and ${docs.length - 20} more`);
  if (conflicts.length) {
    console.log('[merge-state] SKIPPED — an asset with the same name and MDA already exists in Taraba (review by hand):');
    conflicts.forEach(({ a, other }) => console.log(`   ${a.assetId || a._id} "${a.name}" (${a.mda}) duplicates ${other.assetId || other._id}`));
  }

  if (!APPLY) { console.log('[merge-state] Dry run only. Re-run with --apply to make these changes.'); return; }
  if (!ops.length) return;

  const result = await assets.bulkWrite(ops, { ordered: false });
  console.log(`[merge-state] Updated ${result.modifiedCount} asset(s) to state "${TARGET}".`);

  await db.collection('auditlogs').insertOne({
    action: 'BULK_UPDATE', entityType: 'System', entityId: 'state-merge',
    detail: `State "Adamawa and Taraba" → "${TARGET}" on ${result.modifiedCount} asset(s)${conflicts.length ? `; ${conflicts.length} skipped as duplicates` : ''}`,
    metadata: { script: 'mergeAdamawaTarabaState.js', assetIds: docs.filter(d => !conflicts.some(c => c.a._id.equals(d._id))).map(d => d.assetId || String(d._id)) },
    ts: new Date(),
  });
}

run()
  .catch(err => { console.error('[merge-state] Failed:', err.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
