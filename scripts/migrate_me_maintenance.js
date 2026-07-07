'use strict';
/**
 * migrate_me_maintenance.js
 * 
 * One-time script: writes a maintenanceLogs entry for every M&E report
 * that is Cleared or Not Cleared but has no corresponding maintenance log.
 * 
 * Run from your backend root:
 *   node migrate_me_maintenance.js
 */

const mongoose = require('mongoose');
require('dotenv').config({ path: './src/config/.env' });

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/assetspatial';

const MONTHS = ['January','February','March','April','May','June','July',
                'August','September','October','November','December'];

async function run() {
  console.log('Connecting to', MONGO_URI);
  await mongoose.connect(MONGO_URI);
  console.log('Connected\n');

  const Asset = mongoose.connection.collection('assets');

  // Find all assets with cleared M&E reports
  const assets = await Asset.find({
    'meReports': { $elemMatch: { status: { $in: ['Cleared', 'Not Cleared'] } } }
  }).toArray();

  console.log(`Found ${assets.length} assets with cleared M&E reports\n`);

  let totalFixed = 0;

  for (const asset of assets) {
    const meReports   = asset.meReports || [];
    const maintLogs   = asset.maintenanceLogs || [];

    // Get IDs of reports already linked in maintenance logs
    const linkedIds = new Set(
      maintLogs
        .filter(l => l.meReportId)
        .map(l => String(l.meReportId))
    );

    // Also check by description prefix for old-style entries
    const hasDescPrefix = (desc) =>
      maintLogs.some(l => (l.desc || l.description || '').startsWith(
        (desc || '').slice(0, 30)
      ));

    const toAdd = [];

    for (const r of meReports) {
      if (!['Cleared', 'Not Cleared'].includes(r.status)) continue;
      if (linkedIds.has(String(r._id))) continue;

      const monthName = MONTHS[(r.reportMonth || 1) - 1] || '';
      const typeLabel = r.reportType === 'nhp' ? 'NHP' : 'Secretariat';
      const sat       = r.satisfactory !== false;
      const desc      = `M&E Clearance Certificate — ${monthName} ${r.reportYear} (${typeLabel}) · ${sat ? 'Satisfactory ✓' : 'Unsatisfactory ✗'}`;

      if (hasDescPrefix(desc)) continue; // already exists by description

      toAdd.push({
        _id:          new mongoose.Types.ObjectId(),
        date:         r.clearanceDate || r.updatedAt || new Date(),
        desc,
        tech:         r.facilityManagerName || 'M&E Supervisor',
        cost:         0,
        amount:       0,
        meReportId:   String(r._id),
        meReportLink: `me.html?asset=${encodeURIComponent(asset.assetId || String(asset._id))}`,
      });
    }

    if (toAdd.length === 0) continue;

    await Asset.updateOne(
      { _id: asset._id },
      { $push: { maintenanceLogs: { $each: toAdd } } }
    );

    console.log(`✔ ${asset.name || asset.assetId} — added ${toAdd.length} maintenance log(s)`);
    totalFixed += toAdd.length;
  }

  console.log(`\nDone. ${totalFixed} maintenance log entries written across ${assets.length} assets.`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
