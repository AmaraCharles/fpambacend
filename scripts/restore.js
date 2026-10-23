'use strict';
/**
 * restore.js — load a backup made by scripts/backup.js or the dashboard's
 * "Download backup" into the database in MONGO_URI / MONGO_DB_NAME.
 *
 *   node scripts/restore.js backups/fpamas-backup-….json              # dry run: shows what's in the file
 *   node scripts/restore.js backups/fpamas-backup-….json --yes        # restore into empty collections only
 *   node scripts/restore.js backups/fpamas-backup-….json --yes --drop # REPLACE existing collections
 *   ... --only assets,users                                             # restore just some collections
 *
 * Without --drop, a collection that already has documents is skipped, so a
 * restore can't silently mix old and new data. Practise this on a spare
 * database (point MONGO_DB_NAME at e.g. assetspatial_restore_test) before you
 * ever need it for real.
 */
const fs = require('fs');
const mongoose = require('mongoose');
const { BSON } = require('mongodb');
const env = require('../src/config/env');

const file = process.argv[2];
const yes = process.argv.includes('--yes');
const drop = process.argv.includes('--drop');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx === -1 ? null : new Set(process.argv[onlyIdx + 1].split(','));

async function run() {
  if (!file || !fs.existsSync(file)) throw new Error('Usage: node scripts/restore.js <backup.json> [--yes] [--drop] [--only a,b]');
  // Backups are a single JSON object; Extended JSON keeps types exact.
  const data = BSON.EJSON.parse(fs.readFileSync(file, 'utf8'), { relaxed: false });
  const names = Object.keys(data.collections || {}).filter(n => !only || only.has(n));
  console.log(`[restore] Backup from ${data.meta?.createdAt} (database "${data.meta?.database}")`);
  names.forEach(n => console.log(`   ${n}: ${data.collections[n].length} documents`));

  await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
  const db = mongoose.connection.db;
  console.log(`[restore] Target database: "${db.databaseName}"${yes ? '' : ' — DRY RUN (add --yes to restore)'}`);
  if (!yes) return;

  for (const name of names) {
    const docs = data.collections[name];
    const col = db.collection(name);
    const existing = await col.estimatedDocumentCount();
    if (existing && !drop) { console.log(`[restore] ${name}: skipped — already has ${existing} documents (use --drop to replace)`); continue; }
    if (existing && drop) await col.deleteMany({});
    for (let i = 0; i < docs.length; i += 1000) await col.insertMany(docs.slice(i, i + 1000), { ordered: false });
    console.log(`[restore] ${name}: restored ${docs.length}`);
  }
  console.log('[restore] Done. Indexes are rebuilt by the app on its next start.');
}

run().catch(err => { console.error('[restore] Failed:', err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
