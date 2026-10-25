const db = require('./db');
const { orderServiceUrl, authServiceUrl, internalApiToken, httpTimeoutMs } = require('./config');
const { AppError } = require('./errors');

async function requestOrderService(path, options) {
  let response;
  let body;
  const signal = AbortSignal.timeout(httpTimeoutMs);
  try {
    response = await fetch(`${orderServiceUrl}${path}`, {
      ...options,
      headers: { 'x-internal-token': internalApiToken, ...options?.headers },
      signal
    });
    body = await response.json();
  } catch {
    throw new AppError(502, 'Order service is unavailable or timed out.');
  }
  if (!response.ok) throw new AppError(response.status, body.error || 'Order service request failed.');
  return body;
}

async function listRestaurants() {
  const result = await db.query('SELECT id, name, cuisine FROM restaurant_data.restaurants ORDER BY name');
  return result.rows;
}

async function getRestaurant(restaurantId) {
  const result = await db.query('SELECT id, name, cuisine FROM restaurant_data.restaurants WHERE id = $1', [restaurantId]);
  if (!result.rowCount) throw new AppError(404, 'Restaurant not found.');
  return result.rows[0];
}

async function restaurantForUser(userId) {
  let response;
  let body;
  try {
    response = await fetch(`${authServiceUrl}/internal/users/${encodeURIComponent(userId)}/restaurant`, {
      headers: { 'x-internal-token': internalApiToken },
      signal: AbortSignal.timeout(httpTimeoutMs)
    });
    body = await response.json();
  } catch {
    throw new AppError(502, 'Auth service is unavailable or timed out.');
  }
  if (!response.ok) throw new AppError(response.status === 404 ? 403 : 502, body.error || 'Restaurant ownership could not be verified.');
  return body.restaurantId;
}

async function getMenu(restaurantId) {
  const restaurant = await db.query('SELECT id, name, cuisine FROM restaurant_data.restaurants WHERE id = $1', [restaurantId]);
  if (!restaurant.rowCount) throw new AppError(404, 'Restaurant not found.');
  const menu = await db.query(
    `SELECT id, name, description, price_cents AS "priceCents"
     FROM restaurant_data.menu_items
     WHERE restaurant_id = $1 AND available = TRUE ORDER BY name`,
    [restaurantId]
  );
  return { ...restaurant.rows[0], menu: menu.rows };
}

async function getMenuItems(restaurantId, ids) {
  const result = await db.query(
    `SELECT r.name AS "restaurantName", m.id, m.name, m.price_cents AS "priceCents"
     FROM restaurant_data.restaurants r
     JOIN restaurant_data.menu_items m ON m.restaurant_id = r.id
     WHERE r.id = $1 AND m.id = ANY($2) AND m.available = TRUE`,
    [restaurantId, ids]
  );
  if (!result.rowCount) throw new AppError(404, 'Restaurant or menu item not found.');
  return { restaurantName: result.rows[0].restaurantName, items: result.rows.map(({ restaurantName: _name, ...item }) => item) };
}

async function listIncomingOrders(restaurantId) {
  const orders = await requestOrderService(`/internal/orders?restaurantId=${encodeURIComponent(restaurantId)}&statuses=pending,accepted,preparing,ready_for_pickup`);
  return Promise.all(orders.map((order) => requestOrderService(`/internal/orders/${encodeURIComponent(order.id)}`)));
}

async function changeOrderStatus(id, status, rejectionReason, restaurantId) {
  const order = await requestOrderService(`/internal/orders/${encodeURIComponent(id)}`);
  if (order.restaurantId !== restaurantId) throw new AppError(403, 'Order belongs to another restaurant.');
  const operationId = `restaurant:${id}:${status}`;
  try {
    return await requestOrderService(`/internal/orders/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-operation-id': operationId },
      body: JSON.stringify({ status, rejectionReason })
    });
  } catch (error) {
    if (error.statusCode !== 502) throw error;
    try {
      const applied = await requestOrderService(`/internal/orders/${encodeURIComponent(id)}/operations/${encodeURIComponent(operationId)}`);
      if (applied.targetStatus === status) return requestOrderService(`/internal/orders/${encodeURIComponent(id)}`);
    } catch {
      // The order service may still be unavailable. The same operation ID is safe to retry.
    }
    throw error;
  }
}

module.exports = { listRestaurants, getRestaurant, getMenu, getMenuItems, restaurantForUser, listIncomingOrders, changeOrderStatus };
