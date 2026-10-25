const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { timingSafeEqual } = require('node:crypto');
const { userAuth } = require('../../shared/userAuth');
const config = require('./config');
const db = require('./db');
const authService = require('./authService');
const { asyncHandler, errorHandler } = require('./errors');

const app = express();
const { authenticate, requireRole } = userAuth(jwt, config);
const admin = require('./adminService');
const attempts = new Map();
const windowMs = 15 * 60 * 1000;

function rateLimit(req, res, next) {
  const key = `${req.path}:${req.ip}`;
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
  } else {
    current.count++;
    if (current.count > 50) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  }
  next();
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.resetAt <= now) attempts.delete(key);
}, windowMs);
cleanup.unref();

app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json({ limit: '16kb' }));
app.get('/health', asyncHandler(async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ status: 'ok', service: 'auth-service' });
}));
app.get('/api/auth/restaurants', asyncHandler(async (_req, res) => res.json(await authService.availableRestaurants())));
app.post('/api/auth/signup', rateLimit, asyncHandler(async (req, res) => res.status(201).json(await authService.signup(req.body))));
app.post('/api/auth/login', rateLimit, asyncHandler(async (req, res) => res.json(await authService.login(req.body))));
app.get('/api/auth/me', authenticate, asyncHandler(async (req, res) => res.json(await authService.me(req.user.id))));
// Check the current DB role as well as the token so demotion takes effect immediately.
app.use('/api/admin', authenticate, requireRole('SUPER_ADMIN'), asyncHandler(async (req, res, next) => {
  const user = await authService.me(req.user.id);
  if (user.role !== 'SUPER_ADMIN') return res.status(403).json({ error: 'Access denied.' });
  next();
}));
app.get('/api/admin/summary', asyncHandler(async (_req, res) => res.json(await admin.summary())));
app.get('/api/admin/orders', asyncHandler(async (req, res) => res.json(await admin.listOrders(req.query))));
app.get('/api/admin/orders/:id/invoice', asyncHandler(async (req, res) => res.json(await admin.invoice(req.params.id))));
app.get('/api/admin/failures', asyncHandler(async (_req, res) => res.json(await admin.failures())));
app.get('/api/admin/runs', asyncHandler(async (_req, res) => res.json(await admin.runs())));
app.get('/api/admin/runs/:id/cases', asyncHandler(async (req, res) => res.json(await admin.runCases(req.params.id))));
app.get('/internal/users/:id/restaurant', (req, res, next) => {
  const supplied = Buffer.from(req.get('X-Internal-Token') || '');
  const expected = Buffer.from(config.internalApiToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: 'Internal access denied.' });
  }
  next();
}, asyncHandler(async (req, res) => res.json(await authService.restaurantForUser(req.params.id))));
app.use(errorHandler);

const server = app.listen(config.port, () => console.log(`Auth service listening on ${config.port}`));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();
  server.close(async () => {
    try { await db.close(); } catch (error) { console.error(error); process.exitCode = 1; }
    finally { clearTimeout(timer); }
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
