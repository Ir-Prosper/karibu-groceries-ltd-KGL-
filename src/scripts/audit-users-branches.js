/*
 * Audits user/branch authorization consistency in MongoDB.
 *
 * Checks:
 * - User roles are valid.
 * - Directors do not require a branch.
 * - Managers/sales agents have an existing branch.
 * - User status and branch status are valid values.
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../models/User');
const Branch = require('../models/Branch');

dotenv.config({ quiet: true });

const VALID_ROLES = new Set(['director', 'manager', 'sales_agent']);
const VALID_STATUS = new Set(['active', 'inactive']);

async function run() {
  const mongoUri = String(process.env.MONGO_URI || '').trim();
  if (!mongoUri) {
    throw new Error('MONGO_URI is missing. Set it in .env before running this script.');
  }

  await mongoose.connect(mongoUri);

  const users = await User.find().select('full_name email role branch status read_only').lean();
  const branches = await Branch.find().select('name status').lean();
  const branchByName = new Map(branches.map((branch) => [String(branch.name || '').trim().toLowerCase(), branch]));

  const issues = [];

  for (const user of users) {
    const role = String(user.role || '').trim();
    const branch = String(user.branch || '').trim();
    const status = String(user.status || '').trim();
    const tag = `${user.email || user.full_name || user._id}`;

    if (!VALID_ROLES.has(role)) {
      issues.push(`[ROLE] ${tag}: invalid role "${role}"`);
    }

    if (!VALID_STATUS.has(status)) {
      issues.push(`[STATUS] ${tag}: invalid user status "${status}"`);
    }

    if (role === 'director') {
      continue;
    }

    if (!branch) {
      issues.push(`[BRANCH] ${tag}: missing branch for role "${role}"`);
      continue;
    }

    const branchDoc = branchByName.get(branch.toLowerCase());
    if (!branchDoc) {
      issues.push(`[BRANCH] ${tag}: assigned to non-existent branch "${branch}"`);
      continue;
    }

    const branchStatus = String(branchDoc.status || '').trim();
    if (!VALID_STATUS.has(branchStatus)) {
      issues.push(`[BRANCH STATUS] Branch "${branchDoc.name}" has invalid status "${branchStatus}"`);
    }
  }

  console.log(`Users scanned: ${users.length}`);
  console.log(`Branches scanned: ${branches.length}`);
  console.log(`Issues found: ${issues.length}`);

  if (issues.length > 0) {
    console.log('\nAuthorization data issues:');
    for (const issue of issues) {
      console.log(`- ${issue}`);
    }
  } else {
    console.log('No authorization data issues detected.');
  }
}

run()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`Audit failed: ${err.message}`);
    try {
      await mongoose.disconnect();
    } catch (_) {
      // Ignore disconnect failures in error path.
    }
    process.exit(1);
  });
