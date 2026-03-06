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
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

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
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    }
  })
);
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
