/*
 * Sales routes:
 * - Create cash sales and deduct stock atomically.
 * - List sales by branch with director cross-branch access.
 */

const express = require('express');
const Sale = require('../models/Sale');
const Procurement = require('../models/Procurement');
const { verifyToken, allowRoles, blockReadOnly } = require('../middleware/auth');

const router = express.Router();
const UNSAFE_HTML_PATTERN = /[<>`]/;

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasUnsafeHtmlChars(value) {
  return UNSAFE_HTML_PATTERN.test(String(value || ''));
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

async function deductStockAcrossProcurements({ produceName, branch, tonnage }) {
  const produceRegex = new RegExp(`^${escapeRegex(produceName)}$`, 'i');
  const lots = await Procurement.find({
    name: { $regex: produceRegex },
    branch
  }).sort({ createdAt: 1 });

  if (lots.length === 0) {
    return { error: `No procurement found for "${produceName}" at ${branch} branch`, status: 404 };
  }

  const typeMap = new Map();
  for (const lot of lots) {
    const label = String(lot.type || '').trim();
    const key = label.toLowerCase();
    if (label && !typeMap.has(key)) {
      typeMap.set(key, label);
    }
  }

  if (typeMap.size > 1) {
    return {
      error: `Produce "${produceName}" has inconsistent types in stock (${Array.from(typeMap.values()).join(', ')}). Fix procurement records before creating a sale.`,
      status: 400
    };
  }

  const totalAvailable = lots.reduce((sum, lot) => {
    const available = lot.remaining_kg !== undefined ? lot.remaining_kg : lot.tonnage_kg;
    return sum + Number(available || 0);
  }, 0);

  if (totalAvailable < tonnage) {
    return {
      error: `Insufficient stock. Only ${totalAvailable} kg available for ${produceName}`,
      status: 400
    };
  }

  let toDeduct = tonnage;
  for (const lot of lots) {
    if (toDeduct <= 0) break;
    const available = Number(lot.remaining_kg !== undefined ? lot.remaining_kg : lot.tonnage_kg);
    if (available <= 0) continue;

    const take = Math.min(available, toDeduct);
    const updated = await Procurement.findOneAndUpdate(
      { _id: lot._id, remaining_kg: { $gte: take } },
      { $inc: { remaining_kg: -take } },
      { new: true }
    );

    if (!updated) {
      return { error: 'Stock changed during sale, please retry', status: 409 };
    }

    toDeduct -= take;
  }

  if (toDeduct > 0) {
    return { error: 'Stock changed during sale, please retry', status: 409 };
  }

  return { remainingAfter: totalAvailable - tonnage, status: 200 };
}

// POST /api/sales
// Records a cash sale and deducts stock atomically.
router.post('/', verifyToken, allowRoles('manager', 'sales_agent', 'agent'), blockReadOnly, async (req, res) => {
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
    if (hasUnsafeHtmlChars(buyerName)) {
      return res.status(400).json({ error: 'buyer_name contains invalid characters' });
    }

    const stockResult = await deductStockAcrossProcurements({
      produceName,
      branch,
      tonnage
    });
    if (stockResult.error) {
      return res.status(stockResult.status).json({ error: stockResult.error });
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
      stock_remaining: stockResult.remainingAfter
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
