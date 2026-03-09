/*
 * Authentication routes:
 * - Validates user login credentials.
 * - Blocks inactive users and users from inactive branches.
 * - Issues JWT containing id, role, and branch.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const Branch = require('../models/Branch');

const router = express.Router();
const isProduction = process.env.NODE_ENV === 'production';

const loginLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_LIMIT_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

router.post('/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();

  if (!normalizedEmail || !password) {
    if (!isProduction) console.log('[AUTH] Bad request: missing fields');
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const user = await User.findOne({ email: normalizedEmail });
    if (!user) {
      if (!isProduction) console.log('[AUTH] Invalid login attempt');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.status === 'inactive') {
      if (!isProduction) console.log('[AUTH] Blocked inactive account');
      return res.status(403).json({ error: 'Account is inactive. Contact Director.' });
    }

    if (user.role !== 'director' && user.branch) {
      const branch = await Branch.findOne({ name: user.branch }).lean();
      if (branch && branch.status === 'inactive') {
        if (!isProduction) console.log('[AUTH] Blocked by inactive branch');
        return res.status(403).json({ error: 'Your branch is inactive. Contact Director.' });
      }
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      if (!isProduction) console.log('[AUTH] Invalid login attempt');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role, branch: user.branch },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    if (!isProduction) console.log('[AUTH] Login success:', user.role);
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
    console.error('[AUTH] Server error:', err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
