const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure the database connection.');
}
if (!process.env.INTERNAL_API_TOKEN) throw new Error('INTERNAL_API_TOKEN is required.');
if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET) < 32) throw new Error('JWT_SECRET must be at least 32 bytes.');
if (!process.env.JWT_ISSUER) throw new Error('JWT_ISSUER is required.');

function positiveInt(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

module.exports = {
  port: Number(process.env.PORT || 3002),
  databaseUrl: process.env.DATABASE_URL,
  orderServiceUrl: process.env.ORDER_SERVICE_URL || 'http://localhost:3001',
  frontendOrigin: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  internalApiToken: process.env.INTERNAL_API_TOKEN,
  jwtSecret: process.env.JWT_SECRET,
  jwtIssuer: process.env.JWT_ISSUER,
  authServiceUrl: process.env.AUTH_SERVICE_URL || 'http://localhost:3004',
  httpTimeoutMs: positiveInt('HTTP_TIMEOUT_MS', 5000),
  dbTimeoutMs: positiveInt('DB_TIMEOUT_MS', 5000),
  shutdownTimeoutMs: positiveInt('SHUTDOWN_TIMEOUT_MS', 10000)
};
