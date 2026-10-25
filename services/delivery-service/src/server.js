const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { timingSafeEqual } = require('node:crypto');
const { userAuth } = require('../../shared/userAuth');
const config = require('./config');
const { port, frontendOrigin, internalApiToken, shutdownTimeoutMs } = config;
const db = require('./db');
const { errorHandler } = require('./errors');
const controllers = require('./controllers');

const app = express();
const { authenticate, requireRole } = userAuth(jwt, config);
app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: '32kb' }));
app.use(require('../../shared/failureAudit').failureAudit(db, 'delivery'));
app.get('/health', async (_req, res, next) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', service: 'delivery-service' });
  } catch (error) {
    next(error);
  }
});
app.get('/api/deliveries/available', authenticate, requireRole('DELIVERY_PARTNER'), controllers.available);
app.get('/api/deliveries', authenticate, requireRole('DELIVERY_PARTNER'), controllers.mine);
app.post('/api/deliveries/:id/accept', authenticate, requireRole('DELIVERY_PARTNER'), controllers.accept);
app.post('/api/deliveries/:id/picked-up', authenticate, requireRole('DELIVERY_PARTNER'), controllers.pickedUp);
app.post('/api/deliveries/:id/delivered', authenticate, requireRole('DELIVERY_PARTNER'), controllers.delivered);
app.post('/api/deliveries/:id/issue', authenticate, requireRole('DELIVERY_PARTNER'), controllers.reportIssue);
app.post('/api/deliveries/:id/resolve-issue', authenticate, requireRole('DELIVERY_PARTNER'), controllers.resolveIssue);
app.post('/internal/deliveries/reconcile', (req, res, next) => {
  const supplied = Buffer.from(req.get('X-Internal-Token') || '');
  const expected = Buffer.from(internalApiToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: 'Internal access denied.' });
  }
  next();
}, controllers.reconcile);
app.use(errorHandler);

const server = app.listen(port, () => console.log(`Delivery service listening on ${port}`));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const timer = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, shutdownTimeoutMs);
  timer.unref();
  server.close(async () => {
    try {
      await db.close();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
    }
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
