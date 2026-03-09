/*
 * API server bootstrap:
 * - Loads environment variables
 * - Configures security and JSON middleware
 * - Mounts route modules
 * - Connects to MongoDB
 * - Starts HTTP server
 */

const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const rateLimit = require('express-rate-limit');

dotenv.config({ quiet: true });

const app = express();
const PORT = process.env.PORT || 5000;
const LOG_HTTP = process.env.LOG_HTTP === 'true';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 300);
const isProduction = process.env.NODE_ENV === 'production';
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.RENDER_EXTERNAL_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const REQUIRED_ENV_VARS = ['MONGO_URI', 'JWT_SECRET'];

function validateEnvironment() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`);
  }

  const jwtSecret = String(process.env.JWT_SECRET || '');
  if (isProduction && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters long');
  }

  if (isProduction && allowedOrigins.length === 0) {
    throw new Error('CORS_ORIGIN (or RENDER_EXTERNAL_URL) must be set in production');
  }
}

validateEnvironment();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", 'https://cdn.jsdelivr.net']
      }
    }
  })
);
app.use(cors((req, callback) => {
  const origin = req.header('Origin');

  // Allow non-browser requests (health checks, server-to-server calls).
  if (!origin) {
    return callback(null, { origin: true });
  }

  if (!isProduction && allowedOrigins.length === 0) {
    return callback(null, { origin: true });
  }

  if (allowedOrigins.includes(origin)) {
    return callback(null, { origin: true });
  }

  return callback(null, { origin: false });
}));
app.use(express.json());
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

if (LOG_HTTP) {
  app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.path}`);
    next();
  });
}

const authRoutes = require('./routes/auth');
const procurementRoutes = require('./routes/procurements');
const salesRoutes = require('./routes/sales');
const creditsRoutes = require('./routes/credits');
const usersRoutes = require('./routes/users');
const branchesRoutes = require('./routes/branches');
const Branch = require('./models/Branch');
const User = require('./models/User');

const INITIAL_DIRECTOR_NAME = (process.env.INIT_DIRECTOR_NAME || '').trim();
const INITIAL_DIRECTOR_EMAIL = (process.env.INIT_DIRECTOR_EMAIL || '').trim().toLowerCase();
const INITIAL_DIRECTOR_PASSWORD = (process.env.INIT_DIRECTOR_PASSWORD || '').trim();
const DEMO_USERS_ENABLED = String(process.env.DEMO_USERS_ENABLED || '').trim().toLowerCase() === 'true';
const DEMO_USERS_PASSWORD = String(process.env.DEMO_USERS_PASSWORD || '').trim();
const DEMO_DIRECTOR_EMAIL = (process.env.DEMO_DIRECTOR_EMAIL || 'directortest@karibu.com').trim().toLowerCase();
const DEMO_MANAGER_EMAIL = (process.env.DEMO_MANAGER_EMAIL || 'managertest@karibu.com').trim().toLowerCase();
const DEMO_AGENT_EMAIL = (process.env.DEMO_AGENT_EMAIL || 'agenttest@karibu.com').trim().toLowerCase();

app.use('/api/auth', authRoutes);
app.use('/api/procurement', procurementRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/branches', branchesRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

async function ensureInitialDirector() {
  const directorsCount = await User.countDocuments({ role: 'director' });
  if (directorsCount > 0) return;

  if (!INITIAL_DIRECTOR_NAME || !INITIAL_DIRECTOR_EMAIL || !INITIAL_DIRECTOR_PASSWORD) {
    console.warn('[BOOTSTRAP] No director found. Set INIT_DIRECTOR_NAME, INIT_DIRECTOR_EMAIL, and INIT_DIRECTOR_PASSWORD to create the first director.');
    return;
  }

  const existingByEmail = await User.findOne({ email: INITIAL_DIRECTOR_EMAIL }).lean();
  if (existingByEmail) {
    console.warn(`[BOOTSTRAP] Director bootstrap skipped. User with email ${INITIAL_DIRECTOR_EMAIL} already exists.`);
    return;
  }

  await User.create({
    full_name: INITIAL_DIRECTOR_NAME,
    email: INITIAL_DIRECTOR_EMAIL,
    password_hash: INITIAL_DIRECTOR_PASSWORD,
    role: 'director',
    branch: null,
    status: 'active'
  });

  console.log(`[BOOTSTRAP] Initial director created: ${INITIAL_DIRECTOR_EMAIL}`);
}

async function upsertDemoUser({ full_name, email, role, branch }) {
  const existing = await User.findOne({ email });
  if (existing) {
    existing.full_name = full_name;
    existing.role = role;
    existing.branch = branch;
    existing.status = 'active';
    existing.read_only = true;
    if (DEMO_USERS_PASSWORD) existing.password_hash = DEMO_USERS_PASSWORD;
    await existing.save();
    return 'updated';
  }

  if (!DEMO_USERS_PASSWORD) {
    throw new Error('DEMO_USERS_PASSWORD is required when creating demo users.');
  }

  await User.create({
    full_name,
    email,
    password_hash: DEMO_USERS_PASSWORD,
    role,
    branch,
    status: 'active',
    read_only: true
  });
  return 'created';
}

async function ensureDemoUsers() {
  if (!DEMO_USERS_ENABLED) return;

  const maganjo = await Branch.findOne({ name: 'Maganjo' }).select('_id status').lean();
  if (!maganjo || maganjo.status !== 'active') {
    console.warn('[BOOTSTRAP] Demo users skipped: Maganjo branch missing or inactive.');
    return;
  }

  const users = [
    { full_name: 'Test Director (Read Only)', email: DEMO_DIRECTOR_EMAIL, role: 'director', branch: null },
    { full_name: 'Test Manager (Read Only)', email: DEMO_MANAGER_EMAIL, role: 'manager', branch: 'Maganjo' },
    { full_name: 'Test Sales Agent (Read Only)', email: DEMO_AGENT_EMAIL, role: 'sales_agent', branch: 'Maganjo' }
  ];

  for (const user of users) {
    const action = await upsertDemoUser(user);
    console.log(`[BOOTSTRAP] Demo user ${action}: ${user.email}`);
  }
}

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    const defaultBranches = [
      {
        name: 'Maganjo',
        location: 'Kampala, Uganda',
        contact: '0780634908',
        email: 'maganjo@karibugroceries.com',
        manager: 'Prosper IRAKOZE',
        status: 'active'
      },
      {
        name: 'Matugga',
        location: 'Wakiso District, Uganda',
        contact: '0753354245',
        email: 'matugga@karibugroceries.com',
        manager: 'Chris NKURUNZIZA',
        status: 'active'
      }
    ];

    return Promise.all(
      defaultBranches.map((branch) =>
        Branch.updateOne(
          { name: branch.name },
          { $setOnInsert: branch },
          { upsert: true }
        )
      )
    )
      .then(() => ensureInitialDirector())
      .then(() => ensureDemoUsers())
      .then(() => {
        app.listen(PORT, () => {
          console.log(`Server running on http://localhost:${PORT} (${process.env.NODE_ENV || 'development'})`);
        });
      });
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
