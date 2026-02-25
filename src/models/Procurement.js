/*
 * Procurement master record.
 * `tonnage_kg` is cumulative quantity procured.
 * `remaining_kg` is current stock available for sale.
 */

const mongoose = require('mongoose');

const procurementSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Product name is required'],
      minlength: [2, 'Product name must be at least 2 characters'],
      match: [/^[a-zA-Z0-9 ]+$/, 'Product name can only contain letters, numbers and spaces'],
      trim: true
    },
    type: {
      type: String,
      required: [true, 'Product type is required'],
      minlength: [2, 'Product type must be at least 2 characters'],
      match: [/^[a-zA-Z]+$/, 'Product type can only contain letters'],
      trim: true
    },
    tonnage_kg: {
      type: Number,
      required: [true, 'Tonnage is required'],
      min: [1000, 'Minimum tonnage is 1,000 kg'],
      validate: {
        validator: Number.isInteger,
        message: 'Tonnage must be a whole number'
      }
    },
    remaining_kg: {
      type: Number,
      min: [0, 'Remaining stock cannot be negative'],
      default: function () {
        return this.tonnage_kg;
      }
    },
    cost_ugx: {
      type: Number,
      required: [true, 'Cost is required'],
      min: [10000, 'Minimum cost is 10,000 UGX'],
      validate: {
        validator: Number.isInteger,
        message: 'Cost must be a whole number'
      }
    },
    price_to_sell: {
      type: Number,
      required: [true, 'Selling price is required'],
      min: [1000, 'Minimum selling price is 1,000 UGX/kg'],
      validate: {
        validator: Number.isInteger,
        message: 'Selling price must be a whole number'
      }
    },
    dealer_name: {
      type: String,
      required: [true, 'Dealer name is required'],
      minlength: [2, 'Dealer name must be at least 2 characters'],
      match: [/^[a-zA-Z0-9 ]+$/, 'Dealer name can only contain letters, numbers and spaces'],
      trim: true
    },
    contact: {
      type: String,
      required: [true, 'Contact number is required'],
      match: [/^0[1-9]\d{8}$/, 'Contact must be a valid Ugandan phone number (e.g., 0772123456)'],
      trim: true
    },
    branch: {
      type: String,
      required: [true, 'Branch is required']
    },
    date: {
      type: String,
      default: () => new Date().toISOString().split('T')[0]
    },
    time: {
      type: String,
      default: () => new Date().toTimeString().slice(0, 5)
    }
  },
  {
    timestamps: true,
    strict: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Backward-compatibility aliases.
procurementSchema.virtual('costUgx').get(function () {
  return this.cost_ugx;
});

procurementSchema.virtual('dealerName').get(function () {
  return this.dealer_name;
});

// Ensure remaining_kg is initialized when a document is first created.
// Keep this promise-based for Mongoose versions where callback `next` is not passed.
procurementSchema.pre('save', function () {
  if (this.isNew && (this.remaining_kg === undefined || this.remaining_kg === null)) {
    this.remaining_kg = this.tonnage_kg;
  }
});

const Procurement = mongoose.model('Procurement', procurementSchema);

module.exports = Procurement;
