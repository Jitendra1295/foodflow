const { randomUUID, createHash } = require('node:crypto');
const db = require('./db');
const { restaurantServiceUrl, internalApiToken, httpTimeoutMs } = require('./config');
const { AppError } = require('./errors');
const { transitions, canTransition } = require('./orderTransitions');

async function getMenuItems(restaurantId, itemIds) {
  let response;
  let body;
  const signal = AbortSignal.timeout(httpTimeoutMs);
  try {
    response = await fetch(`${restaurantServiceUrl}/internal/menu-items?restaurantId=${encodeURIComponent(restaurantId)}&ids=${encodeURIComponent(itemIds.join(','))}`, {
      headers: { 'x-internal-token': internalApiToken },
      signal
    });
    body = await response.json();
  } catch {
    throw new AppError(502, 'Restaurant service is unavailable or timed out.');
  }
  if (!response.ok) {
    if (response.status === 404) throw new AppError(404, 'Restaurant or menu item not found.');
    throw new AppError(502, 'Restaurant service could not provide menu prices.');
  }
  return body;
}

async function createOrder({ restaurantId, customerId, items, idempotencyKey }) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) throw new AppError(400, 'Invalid customer identity.');
  if (!Array.isArray(items) || items.length === 0) throw new AppError(400, 'Add at least one item to the order.');
  const quantities = new Map();
  for (const item of items) {
    if (!item || typeof item.menuItemId !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      throw new AppError(400, 'Each item requires a menuItemId and a quantity from 1 to 20.');
    }
    quantities.set(item.menuItemId, (quantities.get(item.menuItemId) || 0) + item.quantity);
  }
  if (quantities.size !== items.length) throw new AppError(400, 'Each menu item may only appear once.');
  const requestHash = createHash('sha256').update(JSON.stringify({
    restaurantId,
    customerId,
    items: [...quantities].sort(([a], [b]) => a.localeCompare(b))
  })).digest('hex');

  async function existingOrder() {
    const found = await db.query(
      'SELECT id, request_hash FROM order_data.orders WHERE customer_id = $1 AND idempotency_key = $2',
      [customerId, idempotencyKey]
    );
    if (!found.rowCount) return null;
    if (found.rows[0].request_hash !== requestHash) throw new AppError(409, 'Idempotency key was already used for a different order.');
    return getOrder(found.rows[0].id);
  }
  if (idempotencyKey) {
    const existing = await existingOrder();
    if (existing) return existing;
  }

  const menu = await getMenuItems(restaurantId, [...quantities.keys()]);
  if (menu.items.length !== quantities.size) throw new AppError(400, 'One or more items are not available at this restaurant.');
  const totalCents = menu.items.reduce((total, item) => total + item.priceCents * quantities.get(item.id), 0);
  if (!Number.isSafeInteger(totalCents)) throw new AppError(400, 'Order total is too large.');

  const orderId = randomUUID();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO order_data.orders
       (id, restaurant_id, restaurant_name, customer_id, status, total_cents, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
       ON CONFLICT (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [orderId, restaurantId, menu.restaurantName, customerId, totalCents, idempotencyKey || null, idempotencyKey ? requestHash : null]
    );
    if (!inserted.rowCount) {
      await client.query('ROLLBACK');
      return existingOrder();
    }
    await client.query(
      `INSERT INTO order_data.restaurant_order_state (order_id, status) VALUES ($1, 'pending')`,
      [orderId]
    );
    for (const item of menu.items) {
      const quantity = quantities.get(item.id);
      await client.query(
        `INSERT INTO order_data.order_items
         (order_id, menu_item_id, item_name, unit_price_cents, quantity, line_total_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, item.id, item.name, item.priceCents, quantity, item.priceCents * quantity]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getOrder(orderId);
}

async function getOrder(id) {
  const orderResult = await db.query('SELECT * FROM order_data.orders WHERE id = $1', [id]);
  if (!orderResult.rowCount) throw new AppError(404, 'Order not found.');
  const itemsResult = await db.query(
    `SELECT menu_item_id AS "menuItemId", item_name AS name, unit_price_cents AS "unitPriceCents",
            quantity, line_total_cents AS "lineTotalCents"
     FROM order_data.order_items WHERE order_id = $1 ORDER BY id`,
    [id]
  );
  return { ...formatOrder(orderResult.rows[0]), items: itemsResult.rows };
}

function formatOrder(row) {
  return {
    id: row.id,
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    customerId: row.customer_id,
    status: row.status,
    totalCents: row.total_cents,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function listOrders({ customerId, restaurantId, statuses }) {
  const filters = [];
  const params = [];
  if (customerId) {
    params.push(customerId);
    filters.push(`customer_id = $${params.length}`);
  }
  if (restaurantId) {
    params.push(restaurantId);
    filters.push(`restaurant_id = $${params.length}`);
  }
  if (statuses?.length) {
    params.push(statuses);
    filters.push(`status = ANY($${params.length})`);
  }
  const result = await db.query(
    `SELECT * FROM order_data.orders ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  return result.rows.map(formatOrder);
}

async function listReadyOrders(cursor, limit = 100) {
  const result = await db.query(
    `SELECT * FROM order_data.orders
     WHERE status = 'ready_for_pickup'
       AND ($1::uuid IS NULL OR (created_at, id) > (
         SELECT created_at, id FROM order_data.orders WHERE id = $1
       ))
     ORDER BY created_at, id LIMIT $2`,
    [cursor || null, limit]
  );
  const orders = result.rows.map(formatOrder);
  return { orders, nextCursor: orders.length === limit ? orders[orders.length - 1].id : null };
}

async function getStatusOperation(id, operationId) {
  const result = await db.query(
    'SELECT target_status AS "targetStatus" FROM order_data.status_operations WHERE order_id = $1 AND operation_id = $2',
    [id, operationId]
  );
  if (!result.rowCount) throw new AppError(404, 'Operation not found.');
  return { operationId, orderId: id, targetStatus: result.rows[0].targetStatus, applied: true };
}

async function updateStatus(id, status, rejectionReason, operationId) {
  if (!Object.hasOwn(transitions, status)) throw new AppError(400, 'Unknown order status.');
  const reasonHash = createHash('sha256').update(JSON.stringify({ status, rejectionReason: status === 'rejected' ? (rejectionReason || null) : null })).digest('hex');
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT status, restaurant_id FROM order_data.orders WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) throw new AppError(404, 'Order not found.');
    const prior = await client.query('SELECT order_id, target_status, reason_hash FROM order_data.status_operations WHERE operation_id = $1', [operationId]);
    if (prior.rowCount) {
      const operation = prior.rows[0];
      if (operation.order_id !== id || operation.target_status !== status || operation.reason_hash !== reasonHash) {
        throw new AppError(409, 'Operation ID was already used for a different transition.');
      }
      await client.query('COMMIT');
      return getOrder(id);
    }
    if (!canTransition(current.rows[0].status, status)) {
      throw new AppError(409, `Cannot change order from ${current.rows[0].status} to ${status}.`);
    }
    await client.query(
      `UPDATE order_data.orders
       SET status = $2, rejection_reason = $3, updated_at = NOW()
       WHERE id = $1`,
      [id, status, status === 'rejected' ? (rejectionReason || null) : null]
    );
    if (['accepted', 'rejected', 'preparing', 'ready_for_pickup'].includes(status)) {
      await client.query(
        `UPDATE order_data.restaurant_order_state SET status = $2, updated_at = NOW() WHERE order_id = $1`,
        [id, status]
      );
    }
    await client.query(
      `INSERT INTO order_data.status_operations(operation_id, order_id, target_status, reason_hash)
       VALUES ($1, $2, $3, $4)`,
      [operationId, id, status, reasonHash]
    );
    if (status === 'ready_for_pickup') {
      const eventId = randomUUID();
      const event = {
        eventId,
        eventType: 'ORDER_READY',
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        source: 'order-service',
        data: { orderId: id, restaurantId: current.rows[0].restaurant_id, status }
      };
      await client.query(
        `INSERT INTO order_data.outbox_events
         (id, aggregate_id, operation_id, event_type, event_version, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [eventId, id, operationId, event.eventType, event.eventVersion, JSON.stringify(event)]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getOrder(id);
}

module.exports = { createOrder, getOrder, listOrders, listReadyOrders, getStatusOperation, updateStatus, transitions };
