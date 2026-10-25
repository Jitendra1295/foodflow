// Read-only reporting across local schemas; operational writes remain with each service.
const db = require('./db');
const { AppError } = require('./errors');

const ordersView = `SELECT o.*, u.email AS customer_email, u.name AS customer_name,
  d.id AS delivery_id, d.status AS delivery_status, p.email AS delivery_partner,
  e.status AS outbox_status, e.last_error AS kafka_error,
  (SELECT reason FROM delivery_data.delivery_issues i WHERE i.delivery_id=d.id AND i.resolved_at IS NULL) AS delivery_issue,
  c.run_id, c.outcome AS test_outcome, c.stage AS test_stage, c.reason AS test_reason,
  CASE WHEN o.status = 'rejected' THEN 'restaurant'
    WHEN c.outcome = 'failed' THEN c.stage
    WHEN o.status IN ('pending','accepted','preparing') THEN 'restaurant'
    WHEN o.status = 'ready_for_pickup' AND d.id IS NULL THEN 'kafka / delivery creation'
    WHEN o.status IN ('ready_for_pickup','picked_up') THEN 'delivery'
    ELSE 'complete' END AS current_stage
  FROM order_data.orders o
  LEFT JOIN auth_data.users u ON u.id::text = o.customer_id
  LEFT JOIN delivery_data.deliveries d ON d.order_id = o.id
  LEFT JOIN auth_data.users p ON p.id::text = d.delivery_partner_id
  LEFT JOIN order_data.outbox_events e ON e.aggregate_id = o.id AND e.event_type = 'ORDER_READY'
  LEFT JOIN admin_data.load_cases c ON c.order_id = o.id`;

function filters(query) {
  const params = [];
  const conditions = [];
  if (query.status) { params.push(query.status); conditions.push(`status = $${params.length}`); }
  if (query.runId) {
    if (!/^[0-9a-f-]{36}$/i.test(query.runId)) throw new AppError(400, 'Invalid run ID.');
    params.push(query.runId); conditions.push(`run_id = $${params.length}::uuid`);
  }
  if (query.search) {
    params.push(`%${String(query.search).slice(0, 100)}%`);
    conditions.push(`(id::text ILIKE $${params.length} OR customer_email ILIKE $${params.length} OR restaurant_name ILIKE $${params.length})`);
  }
  return { params, where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '' };
}

async function listOrders(query) {
  const page = Number(query.page || 1);
  if (!Number.isInteger(page) || page < 1 || page > 100000) throw new AppError(400, 'Invalid page.');
  const { params, where } = filters(query);
  const count = await db.query(`SELECT count(*)::int AS total FROM (${ordersView}) v ${where}`, params);
  const rows = await db.query(`SELECT * FROM (${ordersView}) v ${where}
    ORDER BY created_at DESC, id LIMIT 50 OFFSET $${params.length + 1}`, [...params, (page - 1) * 50]);
  return { orders: rows.rows, total: count.rows[0].total, page, pageSize: 50 };
}

async function summary() {
  const orders = await db.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status = 'delivered')::int AS delivered,
    count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
    count(*) FILTER (WHERE status NOT IN ('delivered','rejected'))::int AS in_progress,
    COALESCE(sum(total_cents) FILTER (WHERE status = 'delivered'),0)::bigint AS delivered_value_cents
    FROM order_data.orders`);
  const failures = await db.query('SELECT service, count(*)::int AS count FROM admin_data.request_failures GROUP BY service');
  const tests = await db.query(`SELECT outcome, count(*)::int AS count FROM admin_data.load_cases GROUP BY outcome`);
  return { ...orders.rows[0], requestFailures: failures.rows, testOutcomes: tests.rows };
}

async function invoice(id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new AppError(400, 'Invalid order ID.');
  const result = await db.query(`SELECT * FROM (${ordersView}) v WHERE id = $1`, [id]);
  if (!result.rowCount) throw new AppError(404, 'Order not found.');
  const items = await db.query(`SELECT item_name, quantity, unit_price_cents, line_total_cents FROM order_data.order_items WHERE order_id = $1 ORDER BY id`, [id]);
  const failures = await db.query(`SELECT * FROM admin_data.request_failures WHERE resource_id = $1 OR
    resource_id IN (SELECT id FROM delivery_data.deliveries WHERE order_id = $1) ORDER BY created_at DESC LIMIT 100`, [id]);
  const issues = await db.query(`SELECT i.* FROM delivery_data.delivery_issues i JOIN delivery_data.deliveries d ON d.id=i.delivery_id WHERE d.order_id=$1 ORDER BY i.created_at`, [id]);
  return { order: result.rows[0], invoiceNumber: `FF-${id}`, currency: 'INR', items: items.rows, deliveryIssues: issues.rows,
    totalCents: result.rows[0].total_cents, failures: failures.rows,
    note: 'Order invoice only. FoodFlow does not collect payments or calculate tax.' };
}

async function failures() {
  return (await db.query('SELECT * FROM admin_data.request_failures ORDER BY created_at DESC, id DESC LIMIT 100')).rows;
}
async function runs() {
  return (await db.query(`SELECT r.*, (SELECT count(*)::int FROM admin_data.load_cases c WHERE c.run_id=r.id AND outcome='delivered') AS delivered,
    (SELECT count(*)::int FROM admin_data.load_cases c WHERE c.run_id=r.id AND outcome='failed') AS failed
    FROM admin_data.load_runs r ORDER BY started_at DESC LIMIT 20`)).rows;
}
async function runCases(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AppError(400, 'Invalid run ID.');
  return (await db.query('SELECT * FROM admin_data.load_cases WHERE run_id=$1 ORDER BY sequence', [id])).rows;
}
module.exports = { listOrders, summary, invoice, failures, runs, runCases };
