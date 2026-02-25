/*
 * Sales routes:
 * - Create cash sales and deduct stock atomically.
 * - List sales by branch with director cross-branch access.
 */

const express = require('express');
const Sale = require('../models/Sale');
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

// POST /api/sales
// Records a cash sale and deducts stock atomically.
router.post('/', verifyToken, allowRoles('manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    const { produce_name, tonnage_kg, amount_paid_ugx, buyer_name } = req.body;
    const branch = req.user.branch;
    const produceName = String(produce_name || '').trim();
    const tonnage = Number(tonnage_kg);
    const amountPaid = Number(amount_paid_ugx);
    const buyerName = String(buyer_name || '').trim();

    if (!produceName || !branch || Number.isNaN(tonnage)) {
      return res.status(400).json({
        error: 'produce_name, branch, and tonnage_kg are required'
      });
    }

    if (!Number.isFinite(tonnage) || tonnage < 1000) {
      return res.status(400).json({ error: 'tonnage_kg must be a number >= 1000' });
    }

    if (!Number.isFinite(amountPaid) || amountPaid < 10000) {
      return res.status(400).json({ error: 'amount_paid_ugx must be a number >= 10000' });
    }

    if (!buyerName || buyerName.length < 2) {
      return res.status(400).json({ error: 'buyer_name must be at least 2 characters' });
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

      const availableQty = procurement.remaining_kg !== undefined
        ? procurement.remaining_kg
        : procurement.tonnage_kg;

      return res.status(400).json({
        error: `Insufficient stock. Only ${availableQty} kg available for ${produceName}`
      });
    }

    const sale = new Sale({
      produce_name: produceName,
      tonnage_kg: tonnage,
      amount_paid_ugx: amountPaid,
      buyer_name: buyerName,
      sales_agent: req.body.sales_agent || req.user.id,
      branch,
      date: req.body.date,
      time: req.body.time
    });

    await sale.save();

    res.status(201).json({
      ...sale.toObject(),
      stock_remaining: updatedProcurement.remaining_kg
    });
  } catch (err) {
    console.error('[SALES POST ERROR]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// GET /api/sales/branch?branch=...
router.get('/branch', verifyToken, allowRoles('director', 'manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    const branch = req.user.role === 'director' ? req.query.branch : req.user.branch;
    if (!branch) {
      return res.status(400).json({ error: 'branch query parameter is required' });
    }
    const sales = await Sale.find(branchMatchQuery('branch', branch)).sort({ createdAt: -1 });
    res.json(sales);
  } catch (err) {
    console.error('[SALES GET ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
