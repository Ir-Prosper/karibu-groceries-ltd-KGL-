/*
 * Credit routes:
 * - Create credit dispatch and deduct stock atomically.
 * - List credits by branch (director can query any branch).
 * - Register credit payments and auto-update settlement status.
 */

const express = require('express');
const CreditSale = require('../models/CreditSale');
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

async function deductStockAcrossProcurements({ produceName, branch, tonnage, expectedType }) {
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
      error: `Produce "${produceName}" has inconsistent types in stock (${Array.from(typeMap.values()).join(', ')}). Fix procurement records before creating a credit sale.`,
      status: 400
    };
  }

  const canonicalType = Array.from(typeMap.values())[0] || '';
  if (expectedType && canonicalType && canonicalType.toLowerCase() !== String(expectedType).toLowerCase()) {
    return {
      error: `Produce type mismatch. "${produceName}" is stocked as "${canonicalType}", not "${expectedType}".`,
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
      return { error: 'Stock changed during credit sale, please retry', status: 409 };
    }

    toDeduct -= take;
  }

  if (toDeduct > 0) {
    return { error: 'Stock changed during credit sale, please retry', status: 409 };
  }

  return { remainingAfter: totalAvailable - tonnage, status: 200 };
}

// POST /api/credits
// Creates a credit sale and deducts stock atomically.
router.post('/', verifyToken, allowRoles('manager', 'sales_agent', 'agent'), blockReadOnly, async (req, res) => {
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
    const dueDateRaw = String(due_date || '').trim();
    const dueDate = new Date(`${dueDateRaw}T00:00:00`);

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

    if (!dueDateRaw || Number.isNaN(dueDate.getTime())) {
      return res.status(400).json({ error: 'due_date must be a valid date' });
    }
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (dueDate < today) {
      return res.status(400).json({ error: 'due_date cannot be before today' });
    }

    if (!buyerName || buyerName.length < 2) {
      return res.status(400).json({ error: 'buyer_name must be at least 2 characters' });
    }
    if ([buyerName, buyerLocation, produceType].some((value) => hasUnsafeHtmlChars(value))) {
      return res.status(400).json({ error: 'Text fields contain invalid characters' });
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

    const stockResult = await deductStockAcrossProcurements({
      produceName,
      branch,
      tonnage,
      expectedType: produceType
    });
    if (stockResult.error) {
      return res.status(stockResult.status).json({ error: stockResult.error });
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
      stock_remaining: stockResult.remainingAfter
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
router.patch('/:id/pay', verifyToken, allowRoles('manager', 'sales_agent', 'agent'), blockReadOnly, async (req, res) => {
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
