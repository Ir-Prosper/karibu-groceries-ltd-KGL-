/*
 * User model:
 * - Stores role, branch, and identity information.
 * - Persists password hashes only.
 * - Supports account activation/deactivation.
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  full_name: {
    type: String,
    required: true,
    minlength: 2
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  password_hash: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['director', 'manager', 'sales_agent'],
    required: true
  },
  branch: {
    type: String,
    default: null
  },
  phone: {
    type: String,
    match: /^0\d{9}$/
  },
  created_at: {
    type: Date,
    default: Date.now
  },
  status: {
    type: String,
    enum: ['active', 'inactive'],
    default: 'active'
  },
  read_only: {
    type: Boolean,
    default: false
  }
});

// Hash password when it is created or changed.
userSchema.pre('save', async function() {
  if (!this.isModified('password_hash')) return;
  this.password_hash = await bcrypt.hash(this.password_hash, 10);
});

// Compare a login password against the stored hash.
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password_hash);
};

module.exports = mongoose.model('User', userSchema);
