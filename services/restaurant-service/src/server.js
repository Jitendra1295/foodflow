const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { timingSafeEqual } = require('node:crypto');
const { userAuth } = require('../../shared/userAuth');
const config = require('./config');
const { port, frontendOrigin, internalApiToken, shutdownTimeoutMs } = config;
const db = require('./db');
const { errorHandler, asyncHandler } = require('./errors');
const controllers = require('./controllers');
const restaurantService = require('./restaurantService');

const app = express();
const { authenticate, requireRole } = userAuth(jwt, config);
const restaurantOnly = [authenticate, requireRole('RESTAURANT'), asyncHandler(async (req, _res, next) => {
  req.restaurantId = await restaurantService.restaurantForUser(req.user.id);
  next();
})];
app.use(cors({ origin: frontendOrigin }));
app.use(express.json({ limit: '32kb' }));
app.use(require('../../shared/failureAudit').failureAudit(db, 'restaurant'));
app.get('/health', async (_req, res, next) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', service: 'restaurant-service' });
  } catch (error) {
    next(error);
  }
});
app.get('/api/restaurants', authenticate, requireRole('CUSTOMER'), controllers.restaurants);
app.get('/api/restaurants/:id/menu', authenticate, requireRole('CUSTOMER'), controllers.menu);
app.get('/api/restaurant/orders', ...restaurantOnly, controllers.incomingOrders);
app.post('/api/restaurant/orders/:id/accept', ...restaurantOnly, controllers.accept);
app.post('/api/restaurant/orders/:id/reject', ...restaurantOnly, controllers.reject);
app.post('/api/restaurant/orders/:id/preparing', ...restaurantOnly, controllers.preparing);
app.post('/api/restaurant/orders/:id/ready', ...restaurantOnly, controllers.ready);
app.use('/internal', (req, res, next) => {
  const supplied = Buffer.from(req.get('X-Internal-Token') || '');
  const expected = Buffer.from(internalApiToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return res.status(403).json({ error: 'Internal access denied.' });
  }
  next();
});
app.get('/internal/restaurants', controllers.restaurants);
app.get('/internal/restaurants/:id', controllers.restaurant);
app.get('/internal/menu-items', controllers.menuItemsInternal);
app.use(errorHandler);

const server = app.listen(port, () => console.log(`Restaurant service listening on ${port}`));
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
