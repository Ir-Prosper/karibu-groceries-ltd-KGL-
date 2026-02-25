/*
 * Procurement routes:
 * - Create procurement records.
 * - Return available/all procurement stock views.
 * - Return procurement history.
 * - Handle manager restock operations and audit entries.
 */

const express = require('express');
const mongoose = require('mongoose');
const Procurement = require('../models/Procurement');
const ProcurementHistory = require('../models/ProcurementHistory');
const { verifyToken, allowRoles } = require('../middleware/auth');

const router = express.Router();

function resolveBranchForRead(req) {
  if (req.user.role === 'director') {
    return req.query.branch;
  }
  return req.user.branch;
}

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

// Startup migration: initialize remaining_kg for legacy records.
(async () => {
  try {
    const needsMigration = await Procurement.find({
      remaining_kg: { $exists: false }
    }).select('_id tonnage_kg');

    if (needsMigration.length === 0) return;

    for (const doc of needsMigration) {
      await Procurement.findByIdAndUpdate(doc._id, {
        $set: { remaining_kg: doc.tonnage_kg }
      });
    }

    console.log(`Procurement migration completed for ${needsMigration.length} record(s)`);
  } catch (err) {
    console.error('Procurement migration failed (non-fatal):', err.message);
  }
})();

// POST /api/procurement
router.post('/', verifyToken, allowRoles('manager'), async (req, res) => {
  try {
    const branch = req.user.branch;
    if (!branch) {
      return res.status(400).json({ error: 'Manager branch is missing from token' });
    }

    const procurementData = {
      name: req.body.name,
      type: req.body.type,
      tonnage_kg: req.body.tonnage_kg,
      price_to_sell: req.body.price_to_sell,
      contact: req.body.contact,
      branch,
      cost_ugx: req.body.cost_ugx || req.body.costUgx,
      dealer_name: req.body.dealer_name || req.body.dealerName,
      recorded_by: req.user.id
    };

    const requiredFields = [
      'name',
      'type',
      'tonnage_kg',
      'cost_ugx',
      'price_to_sell',
      'dealer_name',
      'contact',
      'branch'
    ];
    const missingFields = requiredFields.filter((field) => !procurementData[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        missing: missingFields
      });
    }

    const procurement = new Procurement(procurementData);
    await procurement.save();

    await ProcurementHistory.create({
      procurement_id: procurement._id,
      name: procurement.name,
      type: procurement.type,
      branch: procurement.branch,
      tonnage_kg: procurement.tonnage_kg,
      cost_ugx: procurement.cost_ugx,
      dealer_name: procurement.dealer_name,
      dealer_contact: procurement.contact,
      entry_type: 'initial',
      date: new Date(),
      recorded_by: req.user.id
    });

    return res.status(201).json({
      success: true,
      message: 'Procurement recorded successfully',
      data: procurement
    });
  } catch (err) {
    if (err.name === 'ValidationError') {
      const errors = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({
        error: 'Validation failed',
        details: errors
      });
    }

    if (err.code === 11000) {
      return res.status(400).json({
        error: 'A product with this name already exists'
      });
    }

    console.error('Procurement create error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/procurement/available?branch=...
router.get('/available', verifyToken, allowRoles('director', 'manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    const branch = resolveBranchForRead(req);

    if (!branch) {
      return res.status(400).json({ error: 'branch query parameter is required' });
    }

    const rawDocs = await Procurement.find(branchMatchQuery('branch', branch));
    const items = rawDocs.map((doc) => ({
      _id: doc._id,
      name: doc.name,
      type: doc.type,
      price_to_sell: doc.price_to_sell,
      remaining_kg:
        doc.remaining_kg !== undefined && doc.remaining_kg !== null
          ? doc.remaining_kg
          : doc.tonnage_kg
    }));

    return res.json(items);
  } catch (err) {
    console.error('Procurement available error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/procurement/all?branch=...
router.get('/all', verifyToken, allowRoles('director', 'manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    const branch = resolveBranchForRead(req);
    if (!branch) {
      return res.status(400).json({ error: 'branch query parameter required' });
    }

    const items = await Procurement.find(branchMatchQuery('branch', branch)).sort({ createdAt: -1 });
    return res.json(items);
  } catch (err) {
    console.error('Procurement list error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/procurement/history/:id
router.get('/history/:id', verifyToken, allowRoles('director', 'manager', 'sales_agent', 'agent'), async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid procurement ID format' });
    }

    const procurement = await Procurement.findById(req.params.id).select('branch');
    if (!procurement) {
      return res.status(404).json({ error: 'Procurement not found' });
    }
    if (req.user.role !== 'director' && procurement.branch !== req.user.branch) {
      return res.status(403).json({ error: 'Forbidden: cannot view another branch history' });
    }

    const history = await ProcurementHistory.find({
      procurement_id: req.params.id
    }).sort({ date: -1 });

    return res.json(history);
  } catch (err) {
    console.error('Procurement history error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// PATCH /api/procurement/:id/restock
router.patch('/:id/restock', verifyToken, allowRoles('manager'), async (req, res) => {
  try {
    const { tonnage_kg, cost_ugx, dealer_name, dealer_contact, price_to_sell } = req.body;

    const tonnage = Number(tonnage_kg);
    const cost = Number(cost_ugx);
    const sellPrice =
      price_to_sell === undefined || price_to_sell === null || price_to_sell === ''
        ? null
        : Number(price_to_sell);

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid procurement ID format' });
    }

    if (!tonnage || !cost || !dealer_name || !dealer_contact) {
      return res.status(400).json({
        error: 'All fields required: tonnage_kg, cost_ugx, dealer_name, dealer_contact'
      });
    }

    if (!Number.isInteger(tonnage) || tonnage < 1000) {
      return res.status(400).json({ error: 'Minimum restock is 1,000 kg' });
    }

    if (!Number.isInteger(cost) || cost < 10000) {
      return res.status(400).json({ error: 'Minimum cost is 10,000 UGX' });
    }

    if (sellPrice !== null && (!Number.isInteger(sellPrice) || sellPrice < 1000)) {
      return res.status(400).json({ error: 'Selling price must be a whole number of at least 1,000 UGX/kg' });
    }

    const procurement = await Procurement.findById(req.params.id);
    if (!procurement) {
      return res.status(404).json({ error: 'Procurement not found' });
    }
    if (procurement.branch !== req.user.branch) {
      return res.status(403).json({ error: 'Forbidden: cannot restock another branch' });
    }

    const updateDoc = {
      $inc: {
        tonnage_kg: tonnage,
        remaining_kg: tonnage
      },
      cost_ugx: cost,
      dealer_name,
      contact: dealer_contact
    };
    if (sellPrice !== null) {
      updateDoc.price_to_sell = sellPrice;
    }

    const updated = await Procurement.findByIdAndUpdate(
      req.params.id,
      updateDoc,
      { new: true, runValidators: true }
    );

    await ProcurementHistory.create({
      procurement_id: procurement._id,
      name: procurement.name,
      type: procurement.type,
      branch: procurement.branch,
      tonnage_kg: tonnage,
      cost_ugx: cost,
      dealer_name,
      dealer_contact,
      entry_type: 'restock',
      date: new Date(),
      recorded_by: req.user.id
    });

    return res.json({
      success: true,
      message: `Restocked +${tonnage}kg successfully`,
      data: updated
    });
  } catch (err) {
    console.error('Procurement restock error:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

module.exports = router;
