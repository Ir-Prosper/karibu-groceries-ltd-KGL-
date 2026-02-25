/*
 * Cash sale model:
 * - Records completed cash transactions.
 * - Keeps branch and sales agent for traceability.
 */

const mongoose = require('mongoose');

const saleSchema = new mongoose.Schema({
  produce_name: {
    type: String,
    required: true,
    minlength: 2
  },
  tonnage_kg: {
    type: Number,
    required: true,
    min: 1000
  },
  amount_paid_ugx: {
    type: Number,
    required: true,
    min: 10000
  },
  buyer_name: {
    type: String,
    required: true,
    minlength: 2
  },
  sales_agent: {
    type: String,
    required: true
  },
  branch: {
    type: String,
    required: true
  },
  date: {
    type: Date,
    default: Date.now
  },
  time: {
    type: String
  }
}, { timestamps: true });

module.exports = mongoose.model('Sale', saleSchema);
