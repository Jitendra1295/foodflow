const { randomUUID } = require('node:crypto');
const db = require('./db');
const { orderServiceUrl, internalApiToken, httpTimeoutMs } = require('./config');
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

async function syncReadyOrders() {
  let cursor = null;
  do {
    const page = await requestOrderService(`/internal/orders/ready?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const order of page.orders) {
      await insertAvailableDelivery(db, order);
    }
    cursor = page.nextCursor;
  } while (cursor);
}

async function insertAvailableDelivery(database, order) {
  return database.query(
    `INSERT INTO delivery_data.deliveries (id, order_id, restaurant_id, restaurant_name, status)
     VALUES ($1, $2, $3, $4, 'available')
     ON CONFLICT (order_id) DO NOTHING`,
    [randomUUID(), order.id, order.restaurantId, order.restaurantName]
  );
}

async function getOrderForEvent(orderId) {
  return requestOrderService(`/internal/orders/${encodeURIComponent(orderId)}`);
}

async function listAvailable() {
  await syncReadyOrders();
  const result = await db.query(
    `SELECT id, order_id AS "orderId", restaurant_id AS "restaurantId", restaurant_name AS "restaurantName",
            status, created_at AS "createdAt"
     FROM delivery_data.deliveries WHERE status = 'available' ORDER BY created_at`
  );
  return result.rows;
}

async function listMyDeliveries(partnerId) {
  await reconcilePending();
  const result = await db.query(
    `SELECT id, order_id AS "orderId", restaurant_id AS "restaurantId", restaurant_name AS "restaurantName",
            status, created_at AS "createdAt",
            (SELECT reason FROM delivery_data.delivery_issues i WHERE i.delivery_id=deliveries.id AND i.resolved_at IS NULL) AS "issueReason"
     FROM delivery_data.deliveries WHERE delivery_partner_id = $1 ORDER BY updated_at DESC LIMIT 100`,
    [partnerId]
  );
  return result.rows;
}

async function reportIssue(id, partnerId, reason, resolve = false) {
  if (!resolve && (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 1000)) {
    throw new AppError(400, 'Describe the delivery issue in 5 to 1000 characters.');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM delivery_data.deliveries WHERE id=$1 FOR UPDATE', [id]);
    const delivery = result.rows[0];
    if (!delivery) throw new AppError(404, 'Delivery not found.');
    if (delivery.delivery_partner_id !== partnerId) throw new AppError(403, 'Delivery belongs to another partner.');
    if (delivery.status === 'delivered') throw new AppError(409, 'Delivery is already complete.');
    if (resolve) await client.query('UPDATE delivery_data.delivery_issues SET resolved_at=NOW() WHERE delivery_id=$1 AND resolved_at IS NULL', [id]);
    else await client.query(`INSERT INTO delivery_data.delivery_issues(id,delivery_id,reporter_id,reason) VALUES ($1,$2,$3,$4)
      ON CONFLICT (delivery_id) WHERE resolved_at IS NULL DO UPDATE SET reason=EXCLUDED.reason`, [randomUUID(),id,partnerId,reason.trim()]);
    await client.query('COMMIT');
    return { reported: !resolve, resolved: resolve };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

async function changeStatus(id, partnerId, nextStatus) {
  const expected = nextStatus === 'accepted' ? 'available' : nextStatus === 'picked_up' ? 'accepted' : 'picked_up';
  if (nextStatus === 'accepted') {
    const claimed = await db.query(
      `UPDATE delivery_data.deliveries SET status = 'accepted', delivery_partner_id = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'available' AND delivery_partner_id IS NULL
       RETURNING id, order_id AS "orderId", restaurant_id AS "restaurantId", restaurant_name AS "restaurantName", status`,
      [id, partnerId]
    );
    if (claimed.rowCount) return claimed.rows[0];
    const current = await db.query('SELECT status, delivery_partner_id FROM delivery_data.deliveries WHERE id = $1', [id]);
    if (!current.rowCount) throw new AppError(404, 'Delivery not found.');
    if (current.rows[0].status === 'accepted' && current.rows[0].delivery_partner_id === partnerId) {
      const result = await db.query(
        `SELECT id, order_id AS "orderId", restaurant_id AS "restaurantId", restaurant_name AS "restaurantName", status
         FROM delivery_data.deliveries WHERE id = $1`, [id]
      );
      return result.rows[0];
    }
    if (current.rows[0].delivery_partner_id && current.rows[0].delivery_partner_id !== partnerId) {
      throw new AppError(403, 'Delivery belongs to another partner.');
    }
    throw new AppError(409, 'Delivery is no longer available.');
  }

  const operationId = `delivery:${id}:${nextStatus}`;
  const client = await db.connect();
  let orderId;
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM delivery_data.deliveries WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) throw new AppError(404, 'Delivery not found.');
    const delivery = current.rows[0];
    if (delivery.delivery_partner_id !== partnerId) throw new AppError(403, 'Delivery belongs to another partner.');
    orderId = delivery.order_id;
    const prior = await client.query('SELECT state FROM delivery_data.delivery_operations WHERE operation_id = $1', [operationId]);
    if (prior.rowCount && prior.rows[0].state === 'completed') {
      await client.query('COMMIT');
      return formatDelivery(delivery);
    }
    if (!prior.rowCount) {
      if (delivery.status !== expected) throw new AppError(409, `Delivery cannot transition from ${delivery.status} to ${nextStatus}.`);
      await client.query(
        `INSERT INTO delivery_data.delivery_operations(operation_id, delivery_id, target_status, state)
         VALUES ($1, $2, $3, 'pending')`, [operationId, id, nextStatus]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return finishOperation({ operationId, deliveryId: id, orderId, targetStatus: nextStatus });
}

function formatDelivery(row) {
  return {
    id: row.id,
    orderId: row.order_id,
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    status: row.status
  };
}

async function finishOperation({ operationId, deliveryId, orderId, targetStatus }) {
  try {
    await requestOrderService(`/internal/orders/${encodeURIComponent(orderId)}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-operation-id': operationId },
      body: JSON.stringify({ status: targetStatus })
    });
  } catch (error) {
    if (error.statusCode !== 502) throw error;
    try {
      const applied = await requestOrderService(`/internal/orders/${encodeURIComponent(orderId)}/operations/${encodeURIComponent(operationId)}`);
      if (applied.targetStatus !== targetStatus) throw error;
    } catch {
      throw error;
    }
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT * FROM delivery_data.deliveries WHERE id = $1 FOR UPDATE', [deliveryId]);
    if (!row.rowCount) throw new AppError(404, 'Delivery not found.');
    const current = row.rows[0];
    const expected = targetStatus === 'picked_up' ? 'accepted' : 'picked_up';
    if (current.status !== expected && current.status !== targetStatus && !(targetStatus === 'picked_up' && current.status === 'delivered')) {
      throw new AppError(409, 'Delivery changed during recovery.');
    }
    if (current.status === expected) {
      await client.query('UPDATE delivery_data.deliveries SET status = $2, updated_at = NOW() WHERE id = $1', [deliveryId, targetStatus]);
    }
    if (targetStatus === 'delivered') await client.query('UPDATE delivery_data.delivery_issues SET resolved_at=NOW() WHERE delivery_id=$1 AND resolved_at IS NULL', [deliveryId]);
    await client.query(
      `UPDATE delivery_data.delivery_operations SET state = 'completed', updated_at = NOW()
       WHERE operation_id = $1 AND delivery_id = $2 AND target_status = $3`,
      [operationId, deliveryId, targetStatus]
    );
    await client.query('COMMIT');
    return { ...formatDelivery(current), status: current.status === expected ? targetStatus : current.status };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function reconcilePending() {
  const pending = await db.query(
    `SELECT o.operation_id AS "operationId", o.delivery_id AS "deliveryId", d.order_id AS "orderId",
            o.target_status AS "targetStatus"
     FROM delivery_data.delivery_operations o
     JOIN delivery_data.deliveries d ON d.id = o.delivery_id
     WHERE o.state = 'pending' ORDER BY o.updated_at LIMIT 10`
  );
  const results = await Promise.allSettled(pending.rows.map(finishOperation));
  for (let index = 0; index < results.length; index++) {
    if (results[index].status === 'rejected') {
      await db.query('UPDATE delivery_data.delivery_operations SET updated_at = NOW() WHERE operation_id = $1', [pending.rows[index].operationId]);
      console.error('Delivery reconciliation pending', pending.rows[index].operationId, results[index].reason);
    }
  }
  return {
    checked: results.length,
    completed: results.filter((result) => result.status === 'fulfilled').length,
    pending: results.filter((result) => result.status === 'rejected').length
  };
}

async function reconcile() {
  await syncReadyOrders();
  return reconcilePending();
}

module.exports = { listAvailable, listMyDeliveries, changeStatus, reportIssue, reconcile, reconcilePending, insertAvailableDelivery, getOrderForEvent };
