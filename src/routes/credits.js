/*
 * Credit routes:
 * - Create credit dispatch and deduct stock atomically.
 * - List credits by branch (director can query any branch).
 * - Register credit payments and auto-update settlement status.
 */

const express = require('express');
const CreditSale = require('../models/CreditSale');
const Procurement = require('../models/Procurement');
const { verifyToken, allowRoles } = require('../middleware/auth');

const router = express.Router();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function branchAliases(rawBranch) {
  const base = String(rawBranch || '').trim();
  if (!base) return [];
  const withoutSuffix = base.replace(/\s+branch$/i, '').trim();
  const withSuffix = withoutSuffix ? `${withoutSuffix} Branch` : base;
  return [...new Set([base, withoutSuffix, withSuffix].filter(Boolean))];
}

function branchMatchQuery(field, rawBranch) {
  const aliases = branchAliases(rawBranch);
  const patterns = aliases.map((name) => new RegExp(`^${escapeRegex(name)}$`, 'i'));
  return { [field]: { $in: patterns } };
}

// POST /api/credits
// Creates a credit sale and deducts stock atomically.
router.post('/', verifyToken, allowRoles('manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    const {
      produce_name,
      tonnage_kg,
      amount_due_ugx,
      due_date,
      buyer_name,
      national_id,
      location,
      buyer_contact,
      produce_type
    } = req.body;
    const branch = req.user.branch;
    const produceName = String(produce_name || '').trim();
    const tonnage = Number(tonnage_kg);
    const amountDue = Number(amount_due_ugx);
    const buyerName = String(buyer_name || '').trim();
    const nationalId = String(national_id || '').trim().toUpperCase();
    const buyerContact = String(buyer_contact || '').trim();
    const buyerLocation = String(location || '').trim();
    const produceType = String(produce_type || '').trim();
    const dueDate = new Date(due_date);

    if (!produceName || !branch || Number.isNaN(tonnage)) {
      return res.status(400).json({
        error: 'produce_name, branch, and tonnage_kg are required'
      });
    }

    if (!Number.isFinite(tonnage) || tonnage < 1000) {
      return res.status(400).json({ error: 'tonnage_kg must be a number >= 1000' });
    }

    if (!Number.isFinite(amountDue) || amountDue < 10000) {
      return res.status(400).json({ error: 'amount_due_ugx must be a number >= 10000' });
    }

    if (Number.isNaN(dueDate.getTime())) {
      return res.status(400).json({ error: 'due_date must be a valid date' });
    }

    if (!buyerName || buyerName.length < 2) {
      return res.status(400).json({ error: 'buyer_name must be at least 2 characters' });
    }

    if (!/^[A-Z0-9]{14,16}$/.test(nationalId)) {
      return res.status(400).json({ error: 'national_id must be 14-16 uppercase alphanumeric characters' });
    }

    if (!buyerLocation || buyerLocation.length < 2) {
      return res.status(400).json({ error: 'location must be at least 2 characters' });
    }

    if (!/^0\d{9}$/.test(buyerContact)) {
      return res.status(400).json({ error: 'buyer_contact must be a valid 10-digit phone starting with 0' });
    }

    if (!produceType) {
      return res.status(400).json({ error: 'produce_type is required' });
    }

    const produceRegex = new RegExp(`^${escapeRegex(produceName)}$`, 'i');

    // Atomic guarded deduction. If stock is insufficient, update will not happen.
    const updatedProcurement = await Procurement.findOneAndUpdate(
      {
        name: { $regex: produceRegex },
        branch,
        remaining_kg: { $gte: tonnage }
      },
      { $inc: { remaining_kg: -tonnage } },
      { new: true }
    );

    if (!updatedProcurement) {
      const procurement = await Procurement.findOne({
        name: { $regex: produceRegex },
        branch
      });

      if (!procurement) {
        return res.status(404).json({
          error: `No procurement found for "${produceName}" at ${branch} branch`
        });
      }

      const available = procurement.remaining_kg !== undefined
        ? procurement.remaining_kg
        : procurement.tonnage_kg;

      return res.status(400).json({
        error: `Insufficient stock. Only ${available} kg available for ${produceName}`
      });
    }

    const credit = new CreditSale({
      produce_name: produceName,
      produce_type: produceType,
      tonnage_kg: tonnage,
      amount_due_ugx: amountDue,
      due_date: dueDate,
      buyer_name: buyerName,
      national_id: nationalId,
      location: buyerLocation,
      buyer_contact: buyerContact,
      sales_agent_name: req.body.sales_agent_name || req.user.id,
      branch,
      status: 'pending',
      amount_paid_ugx: 0,
      payments: []
    });

    await credit.save();

    res.status(201).json({
      ...credit.toObject(),
      stock_remaining: updatedProcurement.remaining_kg
    });
  } catch (err) {
    console.error('[CREDIT POST]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/credits/branch?branch=...
router.get('/branch', verifyToken, allowRoles('director', 'manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    const branch = req.user.role === 'director' ? req.query.branch : req.user.branch;
    if (!branch) {
      return res.status(400).json({ error: 'branch query parameter is required' });
    }
    const credits = await CreditSale.find(branchMatchQuery('branch', branch)).sort({ createdAt: -1 });
    res.json(credits);
  } catch (err) {
    console.error('[CREDIT GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/credits/:id/pay
router.patch('/:id/pay', verifyToken, allowRoles('manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    const { amount_ugx, note } = req.body;
    const amount = Number(amount_ugx);

    if (!Number.isFinite(amount) || amount < 1000) {
      return res.status(400).json({ error: 'Payment amount must be at least 1,000 UGX' });
    }

    const credit = await CreditSale.findById(req.params.id);
    if (!credit) {
      return res.status(404).json({ error: 'Credit sale not found' });
    }
    if (credit.branch !== req.user.branch) {
      return res.status(403).json({ error: 'Forbidden: cannot pay credits from another branch' });
    }
    if (credit.status === 'paid') {
      return res.status(400).json({ error: 'This credit is already fully paid' });
    }

    const balance = credit.amount_due_ugx - credit.amount_paid_ugx;
    if (amount > balance) {
      return res.status(400).json({
        error: `Payment exceeds remaining balance. Balance is ${balance.toLocaleString()} UGX`,
        balance_due_ugx: balance
      });
    }

    const payment = amount;

    credit.amount_paid_ugx += payment;
    credit.payments.push({
      amount_ugx: payment,
      date: new Date(),
      recorded_by: req.user.id,
      note: note || ''
    });

    if (credit.amount_paid_ugx >= credit.amount_due_ugx) {
      credit.status = 'paid';
    } else if (credit.amount_paid_ugx > 0) {
      credit.status = 'partial';
    }

    await credit.save();
    res.json(credit);
  } catch (err) {
    console.error('[CREDIT PAY]', err.message);
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
