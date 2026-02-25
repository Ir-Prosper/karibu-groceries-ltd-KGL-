/*
 * Authentication routes:
 * - Validates user login credentials.
 * - Blocks inactive users and users from inactive branches.
 * - Issues JWT containing id, role, and branch.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Branch = require('../models/Branch');

const router = express.Router();

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    console.log('[AUTH] Bad request: missing fields');
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      console.log('[AUTH] Invalid attempt for:', email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.status === 'inactive') {
      console.log('[AUTH] Blocked inactive account:', email);
      return res.status(403).json({ error: 'Account is inactive. Contact Director.' });
    }

    if (user.role !== 'director' && user.branch) {
      const branch = await Branch.findOne({ name: user.branch }).lean();
      if (branch && branch.status === 'inactive') {
        console.log('[AUTH] Blocked by inactive branch:', email, 'branch:', user.branch);
        return res.status(403).json({ error: 'Your branch is inactive. Contact Director.' });
      }
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.log('[AUTH] Invalid attempt for:', email);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, branch: user.branch },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    console.log('[AUTH] Login success for:', email, 'role:', user.role);
    return res.json({
      token,
      user: {
        id: user._id,
        full_name: user.full_name,
        role: user.role,
        branch: user.branch,
        status: user.status
      }
    });
  } catch (err) {
    console.error('[AUTH] Server error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
