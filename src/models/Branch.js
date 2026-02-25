/*
 * Branch model:
 * - Stores branch profile and operational state.
 * - Used by director branch management and login branch checks.
 */

const mongoose = require('mongoose');

const branchSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 2
    },
    location: {
      type: String,
      required: true,
      trim: true
    },
    contact: {
      type: String,
      required: true,
      trim: true,
      match: /^0\d{9}$/
    },
    email: {
      type: String,
      default: '',
      trim: true
    },
    manager: {
      type: String,
      default: '',
      trim: true
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active'
    }
  },
  {
    timestamps: true
  }
);

module.exports = mongoose.model('Branch', branchSchema);
