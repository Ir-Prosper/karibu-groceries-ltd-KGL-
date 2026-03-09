/*
 * Creates read-only test users for dashboard walkthroughs.
 *
 * Accounts created (if missing):
 * - directortest@karibu.com (director)
 * - managertest@karibu.com (manager, Maganjo)
 * - agenttest@karibu.com (sales_agent, Maganjo)
 *
 * Default password can be overridden via --password=...
 * Usage:
 *   node src/scripts/create-readonly-test-users.js
 *   node src/scripts/create-readonly-test-users.js --password="YourStrongPass123!"
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');
const User = require('../models/User');
const Branch = require('../models/Branch');

dotenv.config({ quiet: true });

const args = process.argv.slice(2);
const passwordArg = args.find((arg) => arg.startsWith('--password='));
const testPassword = (passwordArg ? passwordArg.split('=').slice(1).join('=') : '').trim() || '123456';

async function ensureBranch(name) {
  const branch = await Branch.findOne({ name }).select('_id name status').lean();
  if (!branch) {
    throw new Error(`Required branch "${name}" not found. Create the branch first.`);
  }
  if (branch.status !== 'active') {
    throw new Error(`Required branch "${name}" is inactive. Activate it first.`);
  }
}

async function upsertUser({ full_name, email, role, branch }) {
  const existing = await User.findOne({ email });
  if (existing) {
    existing.full_name = full_name;
    existing.role = role;
    existing.branch = branch;
    existing.status = 'active';
    existing.read_only = true;
    existing.password_hash = testPassword;
    await existing.save();
    return { email, created: false };
  }

  await User.create({
    full_name,
    email,
    password_hash: testPassword,
    role,
    branch,
    status: 'active',
    read_only: true
  });
  return { email, created: true };
}

async function run() {
  const mongoUri = String(process.env.MONGO_URI || '').trim();
  if (!mongoUri) {
    throw new Error('MONGO_URI is missing. Set it in .env before running this script.');
  }

  await mongoose.connect(mongoUri);
  await ensureBranch('Maganjo');

  const legacyEmails = [
    'test.director@karibugroceries.com',
    'test.manager@karibugroceries.com',
    'test.sales@karibugroceries.com'
  ];
  await User.deleteMany({ email: { $in: legacyEmails } });

  const accounts = [
    { full_name: 'Test Director (Read Only)', email: 'directortest@karibu.com', role: 'director', branch: null },
    { full_name: 'Test Manager (Read Only)', email: 'managertest@karibu.com', role: 'manager', branch: 'Maganjo' },
    { full_name: 'Test Sales Agent (Read Only)', email: 'agenttest@karibu.com', role: 'sales_agent', branch: 'Maganjo' }
  ];

  const results = [];
  for (const account of accounts) {
    results.push(await upsertUser(account));
  }

  console.log('Read-only test users ready:');
  for (const result of results) {
    console.log(`- ${result.email} (${result.created ? 'created' : 'updated'})`);
  }
  console.log(`Password: ${testPassword}`);
}

run()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error(`Create test users failed: ${err.message}`);
    try {
      await mongoose.disconnect();
    } catch (_) {
      // Ignore disconnect failure in error path.
    }
    process.exit(1);
  });
