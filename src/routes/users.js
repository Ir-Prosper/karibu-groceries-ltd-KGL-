/*
 * User management routes (director-only):
 * - List users.
 * - Create manager/sales-agent accounts.
 * - Update status/profile/role/branch.
 * - Delete non-director accounts.
 */

const express = require('express');
const User = require('../models/User');
const Branch = require('../models/Branch');
const { verifyToken, allowRoles } = require('../middleware/auth');

const router = express.Router();

router.get('/', verifyToken, allowRoles('director'), async (req, res) => {
  try {
    const users = await User.find().select('-password_hash').sort({ created_at: -1 });
    return res.json(users);
  } catch (err) {
    console.error('[USERS GET]', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', verifyToken, allowRoles('director'), async (req, res) => {
  try {
    const { full_name, email, password, role, branch } = req.body;
    const normalizedRole = role === 'agent' ? 'sales_agent' : role;

    console.log('[USERS CREATE] Received:', { full_name, email, role: normalizedRole, branch });

    if (!full_name || !email || !password || !normalizedRole) {
      return res.status(400).json({ error: 'Full name, email, password and role are required' });
    }

    if (normalizedRole !== 'director' && !branch) {
      return res.status(400).json({ error: 'Branch is required for managers and agents' });
    }

    if (normalizedRole !== 'director') {
      const branchExists = await Branch.findOne({ name: branch }).select('_id status');
      if (!branchExists) {
        return res.status(400).json({ error: `Branch "${branch}" does not exist` });
      }
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const user = new User({
      full_name,
      email,
      password_hash: password,
      role: normalizedRole,
      branch: normalizedRole === 'director' ? null : branch,
      created_at: new Date()
    });

    await user.save();
    console.log(`[USER CREATED] ${full_name} (${normalizedRole}) @ ${branch || 'All Branches'}`);

    const userObj = user.toObject();
    delete userObj.password_hash;

    return res.status(201).json(userObj);
  } catch (err) {
    console.error('[USER CREATE ERROR]', err);
    if (err.code === 11000) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', verifyToken, allowRoles('director'), async (req, res) => {
  try {
    const { full_name, email, role, branch, phone, status } = req.body;
    const normalizedRole = role === undefined
      ? undefined
      : (role === 'agent' ? 'sales_agent' : role);

    console.log('[USERS UPDATE] Updating:', req.params.id);

    const currentUser = await User.findById(req.params.id).select('role full_name');
    if (!currentUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (currentUser.role === 'director') {
      return res.status(403).json({ error: 'Director account is protected and cannot be edited/deactivated.' });
    }

    const updates = {};
    if (full_name) updates.full_name = full_name;
    if (email) updates.email = email;
    if (phone) updates.phone = phone;

    if (role !== undefined) {
      if (!normalizedRole || !['director', 'manager', 'sales_agent'].includes(normalizedRole)) {
        return res.status(400).json({ error: 'Invalid role. Use director, manager, or sales_agent.' });
      }
      updates.role = normalizedRole;
    }

    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ error: 'Status must be active or inactive' });
      }
      updates.status = status;
    }

    if (updates.role === 'director') {
      updates.branch = null;
    } else if (branch !== undefined) {
      const branchExists = await Branch.findOne({ name: branch }).select('_id');
      if (!branchExists) {
        return res.status(400).json({ error: `Branch "${branch}" does not exist` });
      }
      updates.branch = branch;
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    ).select('-password_hash');

    console.log(`[USER UPDATED] ${user.full_name}`);
    return res.json(user);
  } catch (err) {
    console.error('[USER UPDATE ERROR]', err);
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', verifyToken, allowRoles('director'), async (req, res) => {
  try {
    const existing = await User.findById(req.params.id).select('role full_name');
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (existing.role === 'director') {
      return res.status(403).json({ error: 'Director account is protected and cannot be deleted.' });
    }

    const user = await User.findByIdAndDelete(req.params.id);
    console.log(`[USER DELETED] ${user.full_name}`);
    return res.json({ message: 'User deleted successfully' });
  } catch (err) {
    console.error('[USER DELETE ERROR]', err);
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
