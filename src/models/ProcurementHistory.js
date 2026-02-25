/*
 * Immutable audit entries for procurement creation and restocks.
 */

const mongoose = require('mongoose');

const procurementHistorySchema = new mongoose.Schema(
  {
    procurement_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Procurement',
      required: [true, 'Procurement ID is required'],
      index: true
    },
    name: {
      type: String,
      required: [true, 'Product name is required'],
      minlength: [2, 'Product name must be at least 2 characters'],
      trim: true
    },
    type: {
      type: String,
      required: [true, 'Product type is required'],
      trim: true
    },
    branch: {
      type: String,
      required: [true, 'Branch is required'],
      index: true
    },
    tonnage_kg: {
      type: Number,
      required: [true, 'Tonnage is required'],
      min: [1000, 'Minimum tonnage is 1,000 kg']
    },
    cost_ugx: {
      type: Number,
      required: [true, 'Cost is required'],
      min: [10000, 'Minimum cost is 10,000 UGX']
    },
    dealer_name: {
      type: String,
      required: [true, 'Dealer name is required'],
      minlength: [2, 'Dealer name must be at least 2 characters'],
      trim: true
    },
    dealer_contact: {
      type: String,
      required: [true, 'Dealer contact is required'],
      match: [/^0[1-9]\d{8}$/, 'Contact must be a valid Ugandan phone number'],
      trim: true
    },
    entry_type: {
      type: String,
      required: [true, 'Entry type is required'],
      enum: {
        values: ['initial', 'restock'],
        message: 'Entry type must be either initial or restock'
      }
    },
    date: {
      type: Date,
      default: Date.now,
      index: true
    },
    recorded_by: {
      type: String,
      required: [true, 'Recorded by is required'],
      trim: true
    }
  },
  { timestamps: true }
);

procurementHistorySchema.index({ branch: 1, date: -1 });
procurementHistorySchema.index({ procurement_id: 1, date: -1 });

const ProcurementHistory = mongoose.model('ProcurementHistory', procurementHistorySchema);

module.exports = ProcurementHistory;
