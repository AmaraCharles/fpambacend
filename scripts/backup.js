'use strict';
/**
 * backup.js — logical backup of every collection to a local file.
 *
 *   node scripts/backup.js                    # writes backups/fpamas-backup-<time>.json
 *   node scripts/backup.js --out my.json
 *   node scripts/backup.js --with-files       # also include photo/document contents (GridFS chunks; can be large)
 *
 * Uses MONGO_URI / MONGO_DB_NAME from .env, like the app. The file is MongoDB
 * Extended JSON (ObjectIds and dates are kept exactly) and is the same format
 * as Settings → System health → "Download backup". Restore with
 * scripts/restore.js. The file contains password hashes — store it securely.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { BSON } = require('mongodb');
const env = require('../src/config/env');

const arg = name => { const i = process.argv.indexOf(name); return i === -1 ? null : process.argv[i + 1]; };
const withFiles = process.argv.includes('--with-files');

async function run() {
  await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
  const db = mongoose.connection.db;
  const cols = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map(c => c.name).filter(n => !n.startsWith('system.') && (withFiles || !n.endsWith('.chunks'))).sort();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = arg('--out') || path.join('backups', `fpamas-backup-${stamp}.json`);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const ws = fs.createWriteStream(out);
  const write = s => new Promise(r => (ws.write(s) ? r() : ws.once('drain', r)));

  await write(`{"meta":${JSON.stringify({ createdAt: new Date(), database: db.databaseName, collections: cols, format: 'mongodb-extended-json-v2', excludes: withFiles ? null : 'GridFS file contents (*.chunks)' })},"collections":{`);
  let total = 0;
  for (let i = 0; i < cols.length; i++) {
    await write(`${i ? ',' : ''}${JSON.stringify(cols[i])}:[`);
    let n = 0;
    for await (const doc of db.collection(cols[i]).find({})) {
      await write((n ? ',' : '') + BSON.EJSON.stringify(doc, { relaxed: false }));
      n++;
    }
    await write(']');
    console.log(`[backup] ${cols[i]}: ${n}`);
    total += n;
  }
  await write('}}');
  await new Promise(r => ws.end(r));
  console.log(`[backup] ${total} documents from ${cols.length} collections → ${out}`);
}

run().catch(err => { console.error('[backup] Failed:', err.message); process.exitCode = 1; }).finally(() => mongoose.disconnect());
