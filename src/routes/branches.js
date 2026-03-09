/*
 * Branch routes (director-only):
 * - List, create, update, and delete branches.
 * - Ensure default branches are present.
 * - Cascade deactivation to non-director users in inactive branches.
 */

const express = require('express');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { verifyToken, allowRoles, blockReadOnly } = require('../middleware/auth');

const router = express.Router();
const UNSAFE_HTML_PATTERN = /[<>`]/;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasUnsafeHtmlChars(value) {
  return UNSAFE_HTML_PATTERN.test(String(value || ''));
}

// Ensure default branches exist once DB is available.
async function ensureDefaultBranches() {
  const defaults = [
    {
      name: 'Maganjo',
      location: 'Kampala, Uganda',
      contact: '0771234567',
      email: 'maganjo@karibugroceries.com',
      manager: 'Prosper IRAKOZE',
      status: 'active'
    },
    {
      name: 'Matugga',
      location: 'Wakiso District, Uganda',
      contact: '0772345678',
      email: 'matugga@karibugroceries.com',
      manager: 'Chris NKURUNZIZA',
      status: 'active'
    }
  ];

  for (const branch of defaults) {
    await Branch.updateOne(
      { name: branch.name },
      { $setOnInsert: branch },
      { upsert: true }
    );

    // Backfill older records that existed before contact/email were enforced.
    await Branch.updateOne(
      {
        name: branch.name,
        $or: [{ contact: { $exists: false } }, { contact: '' }, { contact: null }]
      },
      { $set: { contact: branch.contact } }
    );

    await Branch.updateOne(
      {
        name: branch.name,
        $or: [{ email: { $exists: false } }, { email: '' }, { email: null }]
      },
      { $set: { email: branch.email } }
    );
  }
}

router.get('/', verifyToken, allowRoles('director'), async (req, res) => {
  try {
    await ensureDefaultBranches();
    const branches = await Branch.find().sort({ createdAt: 1 });
    console.log(`[BRANCHES GET] Returning ${branches.length} branches`);
    res.json(branches);
  } catch (err) {
    console.error('[BRANCHES GET ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/', verifyToken, allowRoles('director'), blockReadOnly, async (req, res) => {
  try {
    const { name, location, contact, email, manager } = req.body;

    if (!name || !location || !contact) {
      return res.status(400).json({ error: 'Name, location, and contact are required' });
    }
    if ([name, location, email, manager].some((value) => hasUnsafeHtmlChars(value))) {
      return res.status(400).json({ error: 'Text fields contain invalid characters' });
    }

    const exists = await Branch.findOne({
      name: new RegExp(`^${escapeRegex(name.trim())}$`, 'i')
    });
    if (exists) {
      return res.status(400).json({ error: 'A branch with this name already exists' });
    }

    const newBranch = await Branch.create({
      name,
      location,
      contact,
      email: email || '',
      manager: manager || '',
      status: 'active'
    });

    console.log(`[BRANCH CREATED] ${name} at ${location}`);
    res.status(201).json(newBranch);
  } catch (err) {
    console.error('[BRANCH CREATE ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', verifyToken, allowRoles('director'), blockReadOnly, async (req, res) => {
  try {
    const { name, location, contact, email, manager, status } = req.body;
    if ([name, location, email, manager].some((value) => value !== undefined && hasUnsafeHtmlChars(value))) {
      return res.status(400).json({ error: 'Text fields contain invalid characters' });
    }

    const currentBranch = await Branch.findById(req.params.id);
    if (!currentBranch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    const updates = {};
    if (name) updates.name = name;
    if (location) updates.location = location;
    if (contact) updates.contact = contact;
    if (email !== undefined) updates.email = email;
    if (manager !== undefined) updates.manager = manager;
    if (status) updates.status = status;

    const updatedBranch = await Branch.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (status === 'inactive') {
      const branchNames = new Set([currentBranch.name, updatedBranch.name]);
      const result = await User.updateMany(
        { branch: { $in: [...branchNames] }, role: { $ne: 'director' } },
        { $set: { status: 'inactive' } }
      );
      console.log(`[BRANCH UPDATE] Deactivated ${result.modifiedCount || 0} users for ${updatedBranch.name}`);
    }

    // Intentionally do not auto-reactivate users when a branch is reactivated.
    // Director must manually reactivate users one by one for security/audit control.

    console.log(`[BRANCH UPDATED] ${updatedBranch.name}`);
    res.json(updatedBranch);
  } catch (err) {
    console.error('[BRANCH UPDATE ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', verifyToken, allowRoles('director'), blockReadOnly, async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.id);

    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }

    if (branch.name === 'Maganjo' || branch.name === 'Matugga') {
      return res.status(403).json({ error: 'Cannot delete default branches. Deactivate instead.' });
    }

    await Branch.findByIdAndDelete(req.params.id);

    console.log(`[BRANCH DELETED] ${branch.name}`);
    res.json({ message: 'Branch deleted successfully' });
  } catch (err) {
    console.error('[BRANCH DELETE ERROR]', err);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
