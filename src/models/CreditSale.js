/*
 * Credit sale model:
 * - Represents goods dispatched on credit.
 * - Tracks due amount, payments, and settlement status.
 * - Exposes virtuals for balance and overdue state.
 */

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  amount_ugx: {
    type: Number,
    required: true,
    min: 1000
  },
  date: {
    type: Date,
    default: Date.now
  },
  recorded_by: {
    type: String,
    required: true
  },
  note: {
    type: String,
    default: ''
  }
});

const creditSaleSchema = new mongoose.Schema({
  produce_name: {
    type: String,
    required: true,
    minlength: 2
  },
  produce_type: {
    type: String,
    required: true
  },
  tonnage_kg: {
    type: Number,
    required: true,
    min: 1000
  },
  amount_due_ugx: {
    type: Number,
    required: true,
    min: 10000
  },
  amount_paid_ugx: {
    type: Number,
    default: 0,
    min: 0
  },
  date_of_dispatch: {
    type: Date,
    default: Date.now
  },
  due_date: {
    type: Date,
    required: true
  },
  buyer_name: {
    type: String,
    required: true,
    minlength: 2
  },
  national_id: {
    type: String,
    required: true,
    match: /^[A-Z0-9]{14,16}$/
  },
  location: {
    type: String,
    required: true
  },
  buyer_contact: {
    type: String,
    required: true,
    match: /^0\d{9}$/
  },
  sales_agent_name: {
    type: String,
    required: true
  },
  branch: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'partial', 'paid'],
    default: 'pending'
  },
  payments: {
    type: [paymentSchema],
    default: []
  }
}, { timestamps: true });

// Remaining amount due from the buyer.
creditSaleSchema.virtual('balance_ugx').get(function() {
  return Math.max(0, this.amount_due_ugx - this.amount_paid_ugx);
});

// True when due date passed and credit is not fully paid.
creditSaleSchema.virtual('is_overdue').get(function() {
  if (this.status === 'paid') return false;
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const due = new Date(this.due_date);
  due.setHours(0, 0, 0, 0);
  return due < now;
});

// UI-ready status label.
creditSaleSchema.virtual('display_status').get(function() {
  if (this.status === 'paid') return 'paid';
  if (this.is_overdue) return 'overdue';
  if (this.status === 'partial') return 'partial';
  return 'pending';
});

creditSaleSchema.set('toJSON', { virtuals: true });
creditSaleSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('CreditSale', creditSaleSchema);
