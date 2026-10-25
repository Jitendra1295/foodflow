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
app.use(require('../../shared/failureAudit').failureAudit(db, 'order'));
app.get('/health', async (_req, res, next) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', service: 'order-service' });
  } catch (error) {
    next(error);
  }
});
app.post('/api/orders', authenticate, requireRole('CUSTOMER'), controllers.create);
app.get('/api/orders', authenticate, requireRole('CUSTOMER'), controllers.list);
app.get('/api/orders/:id', authenticate, requireRole('CUSTOMER'), controllers.get);
app.use('/internal', (req, res, next) => {
  const supplied = Buffer.from(req.get('X-Internal-Token') || '');
  const expected = Buffer.from(internalApiToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: 'Internal access denied.' });
  }
  next();
});
app.get('/internal/orders/ready', controllers.ready);
app.get('/internal/orders', controllers.listInternal);
app.get('/internal/orders/:id', controllers.getInternal);
app.get('/internal/orders/:id/operations/:operationId', controllers.getOperation);
app.patch('/internal/orders/:id/status', controllers.updateStatus);
app.use(errorHandler);

const server = app.listen(port, () => console.log(`Order service listening on ${port}`));
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
