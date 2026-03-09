/*
 * One-time data cleanup for procurement produce consistency.
 *
 * Default mode (no --apply):
 * - Reports produce names that exist with multiple types in the same branch.
 * - Reports name/type casing/spacing mismatches that can be normalized.
 *
 * Apply mode (--apply):
 * - Normalizes conflicting records to one canonical name/type per produce key per branch.
 *
 * Usage:
 *   node src/scripts/fix-produce-conflicts.js
 *   node src/scripts/fix-produce-conflicts.js --branch="Maganjo"
 *   node src/scripts/fix-produce-conflicts.js --apply
 *   node src/scripts/fix-produce-conflicts.js --apply --strategy=stock
 *   node src/scripts/fix-produce-conflicts.js --apply --strategy=count
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const Procurement = require('../models/Procurement');

dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const applyChanges = args.includes('--apply');
const branchArg = args.find((arg) => arg.startsWith('--branch='));
const strategyArg = args.find((arg) => arg.startsWith('--strategy='));

const branchFilter = branchArg ? branchArg.split('=').slice(1).join('=').trim() : '';
const strategyRaw = strategyArg ? strategyArg.split('=').slice(1).join('=').trim().toLowerCase() : 'stock';
const strategy = strategyRaw === 'count' ? 'count' : 'stock';

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeType(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function keyOf(value) {
  return normalizeName(value).toLowerCase();
}

function pickCanonicalType(records, mode) {
  const stats = new Map();

  for (const record of records) {
    const label = normalizeType(record.type);
    if (!label) continue;
    const key = label.toLowerCase();
    const available = Number(
      record.remaining_kg !== undefined && record.remaining_kg !== null
        ? record.remaining_kg
        : record.tonnage_kg
    );

    if (!stats.has(key)) {
      stats.set(key, { label, count: 0, stock: 0 });
    }

    const row = stats.get(key);
    row.count += 1;
    row.stock += Math.max(0, Number.isFinite(available) ? available : 0);
  }

  const rows = Array.from(stats.values());
  if (rows.length === 0) return '';

  rows.sort((a, b) => {
    if (mode === 'count') {
      if (b.count !== a.count) return b.count - a.count;
      if (b.stock !== a.stock) return b.stock - a.stock;
      return a.label.localeCompare(b.label);
    }
    if (b.stock !== a.stock) return b.stock - a.stock;
    if (b.count !== a.count) return b.count - a.count;
    return a.label.localeCompare(b.label);
  });

  return rows[0].label;
}

function pickCanonicalName(records, canonicalType) {
  const candidates = records.filter(
    (record) => normalizeType(record.type).toLowerCase() === canonicalType.toLowerCase()
  );
  const source = candidates.length > 0 ? candidates : records;
  const ranked = source
    .map((record) => {
      const name = normalizeName(record.name);
      const available = Number(
        record.remaining_kg !== undefined && record.remaining_kg !== null
          ? record.remaining_kg
          : record.tonnage_kg
      );
      return {
        name,
        stock: Math.max(0, Number.isFinite(available) ? available : 0)
      };
    })
    .filter((x) => x.name);

  if (ranked.length === 0) return '';

  ranked.sort((a, b) => {
    if (b.stock !== a.stock) return b.stock - a.stock;
    return a.name.localeCompare(b.name);
  });

  return ranked[0].name;
}

async function run() {
  const mongoUri = String(process.env.MONGO_URI || '').trim();
  if (!mongoUri) {
    throw new Error('MONGO_URI is missing. Set it in .env before running this script.');
  }

  await mongoose.connect(mongoUri);

  const query = branchFilter ? { branch: branchFilter } : {};
  const docs = await Procurement.find(query).select('_id name type branch tonnage_kg remaining_kg').lean();

  if (docs.length === 0) {
    console.log('No procurement records found for the selected scope.');
    return;
  }

  const groups = new Map();
  for (const doc of docs) {
    const nameKey = keyOf(doc.name);
    if (!nameKey) continue;
    const branch = String(doc.branch || '').trim();
    const key = `${branch.toLowerCase()}|${nameKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        branch,
        nameKey,
        records: []
      });
    }
    groups.get(key).records.push(doc);
  }

  const conflicts = [];
  const fixes = [];

  for (const group of groups.values()) {
    const canonicalType = pickCanonicalType(group.records, strategy);
    const canonicalName = pickCanonicalName(group.records, canonicalType);

    const typeSet = new Set(group.records.map((r) => normalizeType(r.type).toLowerCase()).filter(Boolean));
    const typeLabels = Array.from(
      new Map(
        group.records
          .map((r) => normalizeType(r.type))
          .filter(Boolean)
          .map((label) => [label.toLowerCase(), label])
      ).values()
    );

    const changedRecords = group.records.filter((record) => {
      const nextName = canonicalName || normalizeName(record.name);
      const nextType = canonicalType || normalizeType(record.type);
      return normalizeName(record.name) !== nextName || normalizeType(record.type) !== nextType;
    });

    if (typeSet.size > 1) {
      conflicts.push({
        branch: group.branch,
        key: group.nameKey,
        types: typeLabels,
        records: group.records.length
      });
    }

    if (changedRecords.length > 0) {
      fixes.push({
        branch: group.branch,
        key: group.nameKey,
        canonicalName,
        canonicalType,
        ids: changedRecords.map((r) => String(r._id)),
        count: changedRecords.length
      });
    }
  }

  console.log(`Scanned records: ${docs.length}`);
  console.log(`Detected groups: ${groups.size}`);
  console.log(`Type conflicts: ${conflicts.length}`);
  console.log(`Normalizable groups: ${fixes.length}`);

  if (conflicts.length > 0) {
    console.log('\nConflicting produce/type groups:');
    for (const conflict of conflicts) {
      console.log(
        `- Branch="${conflict.branch}" Produce="${conflict.key}" Types=[${conflict.types.join(', ')}] Records=${conflict.records}`
      );
    }
  }

  if (!applyChanges) {
    console.log('\nDry run only. Re-run with --apply to write fixes.');
    return;
  }

  let updated = 0;
  for (const fix of fixes) {
    const setDoc = {};
    if (fix.canonicalName) setDoc.name = fix.canonicalName;
    if (fix.canonicalType) setDoc.type = fix.canonicalType;
    if (Object.keys(setDoc).length === 0) continue;

    const result = await Procurement.updateMany(
      { _id: { $in: fix.ids } },
      { $set: setDoc }
    );
    updated += Number(result.modifiedCount || 0);
  }

  console.log(`\nApply mode complete. Updated records: ${updated}`);
}

run()
  .then(() => mongoose.disconnect())
  .then(() => {
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(`Cleanup failed: ${err.message}`);
    try {
      await mongoose.disconnect();
    } catch (disconnectError) {
      // Ignore disconnect error in failure path.
    }
    process.exit(1);
  });
