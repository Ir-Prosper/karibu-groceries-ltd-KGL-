/*
 * Dedupe procurement records by branch + produce name.
 *
 * Dry run (default):
 * - Reports groups where the same produce name appears in multiple records.
 * - Highlights mixed-type groups (same name with different types).
 *
 * Apply mode (--apply):
 * - Picks one keeper record per duplicate group.
 * - Merges cumulative tonnage and remaining stock into keeper.
 * - Repoints ProcurementHistory entries to keeper.
 * - Deletes duplicate procurement records.
 *
 * Usage:
 *   node src/scripts/dedupe-produce-by-branch.js
 *   node src/scripts/dedupe-produce-by-branch.js --branch="Maganjo"
 *   node src/scripts/dedupe-produce-by-branch.js --apply
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Procurement = require('../models/Procurement');
const ProcurementHistory = require('../models/ProcurementHistory');

dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const branchArg = args.find((arg) => arg.startsWith('--branch='));
const branchFilter = branchArg ? branchArg.split('=').slice(1).join('=').trim() : '';

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeType(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function keyName(value) {
  return normalizeName(value).toLowerCase();
}

function keyType(value) {
  return normalizeType(value).toLowerCase();
}

function pickCanonicalType(records) {
  const stats = new Map();
  for (const record of records) {
    const type = normalizeType(record.type);
    if (!type) continue;
    const k = type.toLowerCase();
    const remaining = Number(record.remaining_kg ?? record.tonnage_kg ?? 0);
    if (!stats.has(k)) {
      stats.set(k, { label: type, count: 0, remaining: 0 });
    }
    const row = stats.get(k);
    row.count += 1;
    row.remaining += Math.max(0, Number.isFinite(remaining) ? remaining : 0);
  }
  const rows = Array.from(stats.values());
  if (rows.length === 0) return '';
  rows.sort((a, b) => {
    if (b.remaining !== a.remaining) return b.remaining - a.remaining;
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });
  return rows[0].label;
}

function pickKeeper(records, canonicalType) {
  const typeKey = keyType(canonicalType);
  const typed = records.filter((r) => keyType(r.type) === typeKey);
  const pool = typed.length > 0 ? typed : records;
  return pool.sort((a, b) => {
    const aRem = Number(a.remaining_kg ?? a.tonnage_kg ?? 0);
    const bRem = Number(b.remaining_kg ?? b.tonnage_kg ?? 0);
    if (bRem !== aRem) return bRem - aRem;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  })[0];
}

async function run() {
  const mongoUri = String(process.env.MONGO_URI || '').trim();
  if (!mongoUri) {
    throw new Error('MONGO_URI is missing. Set it in .env before running this script.');
  }

  await mongoose.connect(mongoUri);

  const query = branchFilter ? { branch: branchFilter } : {};
  const docs = await Procurement.find(query)
    .select('_id name type branch tonnage_kg remaining_kg price_to_sell createdAt')
    .lean();

  if (docs.length === 0) {
    console.log('No procurement records found for the selected scope.');
    return;
  }

  const groups = new Map();
  for (const doc of docs) {
    const name = normalizeName(doc.name);
    const branch = String(doc.branch || '').trim();
    if (!name || !branch) continue;
    const key = `${branch.toLowerCase()}|${keyName(name)}`;
    if (!groups.has(key)) {
      groups.set(key, { branch, name, records: [] });
    }
    groups.get(key).records.push(doc);
  }

  const duplicateGroups = Array.from(groups.values()).filter((group) => group.records.length > 1);
  const mixedTypeGroups = duplicateGroups.filter((group) => {
    const typeSet = new Set(group.records.map((record) => keyType(record.type)).filter(Boolean));
    return typeSet.size > 1;
  });

  console.log(`Scanned records: ${docs.length}`);
  console.log(`Produce groups: ${groups.size}`);
  console.log(`Duplicate groups: ${duplicateGroups.length}`);
  console.log(`Mixed-type groups: ${mixedTypeGroups.length}`);

  if (duplicateGroups.length > 0) {
    console.log('\nDuplicate produce groups:');
    for (const group of duplicateGroups) {
      const types = [...new Set(group.records.map((record) => normalizeType(record.type)).filter(Boolean))];
      console.log(`- Branch="${group.branch}" Produce="${group.name}" Records=${group.records.length} Types=[${types.join(', ')}]`);
    }
  }

  if (!applyChanges) {
    console.log('\nDry run only. Re-run with --apply to merge and delete duplicates.');
    return;
  }

  let mergedGroups = 0;
  let deletedRecords = 0;
  let movedHistoryRows = 0;

  for (const group of duplicateGroups) {
    const canonicalType = pickCanonicalType(group.records);
    const keeper = pickKeeper(group.records, canonicalType);
    const duplicates = group.records.filter((record) => String(record._id) !== String(keeper._id));
    if (duplicates.length === 0) continue;

    const totalTonnage = group.records.reduce((sum, record) => sum + Number(record.tonnage_kg || 0), 0);
    const totalRemaining = group.records.reduce((sum, record) => sum + Number(record.remaining_kg ?? record.tonnage_kg ?? 0), 0);
    const canonicalName = normalizeName(group.name);
    const priceToSell = Number(
      keeper.price_to_sell ??
      group.records.find((record) => Number(record.price_to_sell || 0) > 0)?.price_to_sell ??
      1000
    );

    await Procurement.updateOne(
      { _id: keeper._id },
      {
        $set: {
          name: canonicalName,
          type: canonicalType || normalizeType(keeper.type),
          tonnage_kg: Math.max(1000, Math.round(totalTonnage)),
          remaining_kg: Math.max(0, Math.round(totalRemaining)),
          price_to_sell: Math.max(1000, Math.round(priceToSell))
        }
      }
    );

    const duplicateIds = duplicates.map((record) => record._id);
    const historyResult = await ProcurementHistory.updateMany(
      { procurement_id: { $in: duplicateIds } },
      {
        $set: {
          procurement_id: keeper._id,
          name: canonicalName,
          type: canonicalType || normalizeType(keeper.type),
          branch: group.branch
        }
      }
    );
    movedHistoryRows += Number(historyResult.modifiedCount || 0);

    const deleteResult = await Procurement.deleteMany({ _id: { $in: duplicateIds } });
    deletedRecords += Number(deleteResult.deletedCount || 0);
    mergedGroups += 1;
  }

  console.log('\nApply mode complete.');
  console.log(`Merged groups: ${mergedGroups}`);
  console.log(`Deleted duplicate procurement records: ${deletedRecords}`);
  console.log(`Repointed procurement history rows: ${movedHistoryRows}`);
}

run()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`Dedupe failed: ${err.message}`);
    try {
      await mongoose.disconnect();
    } catch (_) {
      // Ignore disconnect failure in error path.
    }
    process.exit(1);
  });
