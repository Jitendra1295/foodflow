const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

function positiveInt(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

for (const name of ['DATABASE_URL', 'JWT_SECRET', 'JWT_ISSUER', 'INTERNAL_API_TOKEN']) {
  if (!process.env[name]) throw new Error(`${name} is required.`);
}
if (Buffer.byteLength(process.env.JWT_SECRET) < 32) throw new Error('JWT_SECRET must be at least 32 bytes.');

module.exports = {
  port: positiveInt('PORT', 3004),
  databaseUrl: process.env.DATABASE_URL,
  jwtSecret: process.env.JWT_SECRET,
  jwtIssuer: process.env.JWT_ISSUER,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15m',
  internalApiToken: process.env.INTERNAL_API_TOKEN,
  restaurantServiceUrl: process.env.RESTAURANT_SERVICE_URL || 'http://localhost:3002',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  httpTimeoutMs: positiveInt('HTTP_TIMEOUT_MS', 5000),
  dbTimeoutMs: positiveInt('DB_TIMEOUT_MS', 5000),
  shutdownTimeoutMs: positiveInt('SHUTDOWN_TIMEOUT_MS', 10000)
};
