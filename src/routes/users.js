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
const { verifyToken, allowRoles, blockReadOnly } = require('../middleware/auth');

const router = express.Router();
const UNSAFE_HTML_PATTERN = /[<>`]/;

function hasUnsafeHtmlChars(value) {
  return UNSAFE_HTML_PATTERN.test(String(value || ''));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNumber(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.min(Math.max(value, min), max);
}

async function buildUserSummary() {
  const [roleGroups, statusGroups, branchGroups] = await Promise.all([
    User.aggregate([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    User.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$status', 'active'] },
          count: { $sum: 1 }
        }
      }
    ]),
    User.aggregate([
      { $match: { role: { $ne: 'director' } } },
      {
        $group: {
          _id: '$branch',
          total: { $sum: 1 },
          active: {
            $sum: {
              $cond: [
                { $eq: [{ $ifNull: ['$status', 'active'] }, 'active'] },
                1,
                0
              ]
            }
          }
        }
      }
    ])
  ]);

  const byRole = roleGroups.reduce((acc, item) => {
    acc[item._id || 'unknown'] = item.count;
    return acc;
  }, {});

  const byStatus = statusGroups.reduce((acc, item) => {
    acc[item._id || 'active'] = item.count;
    return acc;
  }, {});

  const byBranch = branchGroups.reduce((acc, item) => {
    const key = item._id || 'Unassigned';
    acc[key] = {
      total: item.total || 0,
      active: item.active || 0
    };
    return acc;
  }, {});

  const total = Object.values(byRole).reduce((sum, count) => sum + count, 0);
  const active = byStatus.active || 0;

  return {
    total,
    active,
    byRole,
    byStatus,
    byBranch
  };
}

router.get('/', verifyToken, allowRoles('director'), async (req, res) => {
  try {
    const page = clampNumber(parseInt(req.query.page, 10) || 1, 1, 100000);
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isNaN(rawLimit) ? 10 : rawLimit;

    const query = {};
    const search = String(req.query.q || '').trim();
    const roleParam = String(req.query.role || '').trim().toLowerCase();
    const branchParam = String(req.query.branch || '').trim();
    const statusParam = String(req.query.status || '').trim().toLowerCase();

    if (search) {
      const matcher = new RegExp(escapeRegex(search), 'i');
      query.$or = [
        { full_name: matcher },
        { email: matcher },
        { branch: matcher }
      ];
    }

    if (roleParam) {
      const normalizedRole = roleParam === 'agent' ? 'sales_agent' : roleParam;
      query.role = normalizedRole;
    }

    if (branchParam) {
      query.branch = branchParam;
    }

    if (statusParam) {
      query.status = statusParam;
    }

    if (limit === 0) {
      const users = await User.find(query)
        .select('-password_hash')
        .sort({ created_at: -1 });
      const response = {
        users,
        total: users.length,
        page: 1,
        pages: 1
      };
      const summaryRequested = ['1', 'true', 'yes'].includes(
        String(req.query.summary || '').toLowerCase()
      );
      if (summaryRequested) {
        response.summary = await buildUserSummary();
      }
      return res.json(response);
    }

    const safeLimit = clampNumber(limit, 1, 200);
    const skip = (page - 1) * safeLimit;
    const users = await User.find(query)
      .select('-password_hash')
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(safeLimit);

    const totalUsers = await User.countDocuments(query);
    const summaryRequested = ['1', 'true', 'yes'].includes(
      String(req.query.summary || '').toLowerCase()
    );

    const response = {
      users,
      total: totalUsers,
      page,
      pages: Math.ceil(totalUsers / safeLimit)
    };

    if (summaryRequested) {
      response.summary = await buildUserSummary();
    }

    return res.json(response);
  } catch (err) {
    console.error('[USERS GET]', err);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/:id', verifyToken, allowRoles('director'), async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password_hash');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json(user);
  } catch (err) {
    console.error('[USERS GET ONE]', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/', verifyToken, allowRoles('director'), blockReadOnly, async (req, res) => {
  try {
    const { full_name, email, password, role, branch } = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedFullName = String(full_name || '').trim();
    const normalizedBranch = typeof branch === 'string' ? branch.trim() : branch;
    const normalizedRole = role === 'agent' ? 'sales_agent' : role;

    console.log('[USERS CREATE] Received:', {
      full_name: normalizedFullName,
      email: normalizedEmail,
      role: normalizedRole,
      branch: normalizedBranch
    });

    if (!normalizedFullName || !normalizedEmail || !password || !normalizedRole) {
      return res.status(400).json({ error: 'Full name, email, password and role are required' });
    }
    if (hasUnsafeHtmlChars(normalizedFullName)) {
      return res.status(400).json({ error: 'Full name contains invalid characters' });
    }

    if (!['manager', 'sales_agent'].includes(normalizedRole)) {
      return res.status(400).json({ error: 'Role must be manager or sales_agent' });
    }

    if (!normalizedBranch) {
      return res.status(400).json({ error: 'Branch is required for managers and agents' });
    }

    const branchExists = await Branch.findOne({ name: normalizedBranch }).select('_id status');
    if (!branchExists) {
      return res.status(400).json({ error: `Branch "${normalizedBranch}" does not exist` });
    }
    if (branchExists.status !== 'active') {
      return res.status(400).json({ error: `Branch "${normalizedBranch}" is inactive` });
    }

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    const user = new User({
      full_name: normalizedFullName,
      email: normalizedEmail,
      password_hash: password,
      role: normalizedRole,
      branch: normalizedBranch,
      created_at: new Date()
    });

    await user.save();
    console.log(`[USER CREATED] ${normalizedFullName} (${normalizedRole}) @ ${normalizedBranch}`);

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

router.patch('/:id', verifyToken, allowRoles('director'), blockReadOnly, async (req, res) => {
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
    if (full_name) {
      const cleanName = String(full_name).trim();
      if (hasUnsafeHtmlChars(cleanName)) {
        return res.status(400).json({ error: 'Full name contains invalid characters' });
      }
      updates.full_name = cleanName;
    }
    if (email) updates.email = String(email).trim().toLowerCase();
    if (phone) updates.phone = phone;

    if (role !== undefined) {
      if (!normalizedRole || !['manager', 'sales_agent'].includes(normalizedRole)) {
        return res.status(400).json({ error: 'Invalid role. Use manager or sales_agent.' });
      }
      updates.role = normalizedRole;
    }

    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        return res.status(400).json({ error: 'Status must be active or inactive' });
      }
      updates.status = status;
    }

    const requestedBranch = branch !== undefined ? String(branch).trim() : undefined;
    if (requestedBranch !== undefined) {
      const branchExists = await Branch.findOne({ name: requestedBranch }).select('_id status');
      if (!branchExists) {
        return res.status(400).json({ error: `Branch "${requestedBranch}" does not exist` });
      }
      if (branchExists.status !== 'active') {
        return res.status(400).json({ error: `Branch "${requestedBranch}" is inactive` });
      }
      updates.branch = requestedBranch;
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

router.delete('/:id', verifyToken, allowRoles('director'), blockReadOnly, async (req, res) => {
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
