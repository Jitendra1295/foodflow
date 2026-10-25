const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { AppError } = require('./errors');
const { jwtSecret, jwtIssuer, jwtExpiresIn, internalApiToken, restaurantServiceUrl, httpTimeoutMs } = require('./config');

const allowedRoles = new Set(['CUSTOMER', 'RESTAURANT', 'DELIVERY_PARTNER']);

function safeUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

function validateSignup({ name, email, password, role, restaurantId }) {
  if (typeof name !== 'string' || name.trim().length < 2 || name.trim().length > 100) throw new AppError(400, 'Name must be 2 to 100 characters.');
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new AppError(400, 'Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password) > 72) throw new AppError(400, 'Password must be at least 8 characters and at most 72 bytes.');
  if (!allowedRoles.has(role)) throw new AppError(400, 'Unsupported role.');
  if (role === 'RESTAURANT' && (typeof restaurantId !== 'string' || !restaurantId.trim())) throw new AppError(400, 'restaurantId is required for restaurant signup.');
  if (role !== 'RESTAURANT' && restaurantId !== undefined) throw new AppError(400, 'restaurantId is only for restaurant users.');
  return { name: name.trim(), email: email.trim().toLowerCase(), password, role, restaurantId: role === 'RESTAURANT' ? restaurantId.trim() : null };
}

async function verifyRestaurant(restaurantId) {
  let response;
  try {
    response = await fetch(`${restaurantServiceUrl}/internal/restaurants/${encodeURIComponent(restaurantId)}`, {
      headers: { 'X-Internal-Token': internalApiToken },
      signal: AbortSignal.timeout(httpTimeoutMs)
    });
  } catch {
    throw new AppError(502, 'Restaurant service is unavailable or timed out.');
  }
  if (response.status === 404) throw new AppError(400, 'Restaurant not found.');
  if (!response.ok) throw new AppError(502, 'Restaurant service could not verify ownership.');
}

async function availableRestaurants() {
  let response;
  try {
    response = await fetch(`${restaurantServiceUrl}/internal/restaurants`, {
      headers: { 'X-Internal-Token': internalApiToken },
      signal: AbortSignal.timeout(httpTimeoutMs)
    });
  } catch {
    throw new AppError(502, 'Restaurant service is unavailable or timed out.');
  }
  if (!response.ok) throw new AppError(502, 'Restaurant service could not list restaurants.');
  const restaurants = await response.json();
  const owned = await db.query('SELECT restaurant_id FROM auth_data.users WHERE restaurant_id IS NOT NULL');
  const claimed = new Set(owned.rows.map((row) => row.restaurant_id));
  return restaurants.filter((restaurant) => !claimed.has(restaurant.id));
}

async function signup(input) {
  const data = validateSignup(input || {});
  if (data.restaurantId) await verifyRestaurant(data.restaurantId);
  const passwordHash = await bcrypt.hash(data.password, 12);
  try {
    const result = await db.query(
      `INSERT INTO auth_data.users(id, name, email, password_hash, role, restaurant_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, email, role`,
      [randomUUID(), data.name, data.email, passwordHash, data.role, data.restaurantId]
    );
    return safeUser(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new AppError(409, error.constraint === 'auth_users_restaurant_idx' ? 'Restaurant already has an owner.' : 'Email is already registered.');
    throw error;
  }
}

async function login(input) {
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input?.password;
  if (!email || typeof password !== 'string' || Buffer.byteLength(password) > 72) throw new AppError(401, 'Invalid email or password.');
  const result = await db.query('SELECT id, name, email, role, password_hash FROM auth_data.users WHERE lower(email) = $1', [email]);
  const user = result.rows[0];
  const valid = user ? await bcrypt.compare(password, user.password_hash) : false;
  if (!valid) throw new AppError(401, 'Invalid email or password.');
  const token = jwt.sign({ role: user.role }, jwtSecret, {
    algorithm: 'HS256', issuer: jwtIssuer, subject: user.id, expiresIn: jwtExpiresIn
  });
  return { user: safeUser(user), accessToken: token };
}

async function me(userId) {
  const result = await db.query('SELECT id, name, email, role FROM auth_data.users WHERE id = $1', [userId]);
  if (!result.rowCount) throw new AppError(401, 'Invalid or expired access token.');
  return safeUser(result.rows[0]);
}

async function restaurantForUser(userId) {
  const result = await db.query('SELECT restaurant_id FROM auth_data.users WHERE id = $1 AND role = $2', [userId, 'RESTAURANT']);
  if (!result.rowCount) throw new AppError(404, 'Restaurant user not found.');
  return { restaurantId: result.rows[0].restaurant_id };
}

module.exports = { signup, login, me, restaurantForUser, availableRestaurants, validateSignup };
