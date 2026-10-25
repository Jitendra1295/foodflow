// Local fixture-backed end-to-end order load test. Never disables auth rate limits.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const { Pool } = require('../services/auth-service/node_modules/pg');
const bcrypt = require('../services/auth-service/node_modules/bcryptjs');
const jwt = require('../services/auth-service/node_modules/jsonwebtoken');
require('dotenv').config({ path: path.resolve(__dirname, '../services/auth-service/.env'), quiet: true });

function numberArg(name, fallback, max) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? fallback : Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`${name} must be 1 to ${max}.`);
  return value;
}
const count = numberArg('--users', 1000, 10000);
const concurrency = Math.min(count, numberArg('--concurrency', 20, 100));
const kafkaWaitMs = numberArg('--kafka-timeout-ms', 60000, 300000);
const runId = randomUUID();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, query_timeout: 10000 });
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'load-results', runId);
const metrics = {};
const cases = [];
let stopped = false;
process.on('SIGINT', () => { stopped = true; });
process.on('SIGTERM', () => { stopped = true; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(port, route, token, body, extraHeaders = {}) {
  const start = performance.now();
  let status = 0;
  const key = `${body === undefined ? 'GET' : 'POST'} ${port} ${route.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`;
  try {
    const response = await fetch(`http://localhost:${port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    status = response.status;
    const result = await response.json();
    if (!response.ok) throw new Error(`HTTP ${status}: ${result.error || 'Request failed'}`);
    return result;
  } catch (error) { throw new Error(`${key}: ${error.message}`); }
  finally {
    const m = metrics[key] ||= { count: 0, failures: 0, durations: [] };
    m.count++; if (!status || status >= 400) m.failures++;
    m.durations.push(performance.now() - start);
  }
}

function tokenFor(user) {
  return jwt.sign({ role: user.role }, process.env.JWT_SECRET, {
    subject: user.id, issuer: process.env.JWT_ISSUER, algorithm: 'HS256', expiresIn: '1h'
  });
}

async function save(c) {
  await pool.query(`UPDATE admin_data.load_cases SET order_id=$3, delivery_id=$4, stage=$5,
    outcome=$6, reason=$7, duration_ms=$8, updated_at=NOW() WHERE run_id=$1 AND sequence=$2`,
  [runId, c.sequence, c.orderId || null, c.deliveryId || null, c.stage, c.outcome, c.reason || null, c.durationMs || null]);
}

async function main() {
  // All targets are deliberately localhost. Fixtures are retained for admin review.
  for (const port of [3001, 3002, 3003, 3004]) await request(port, '/health');
  const login = async email => request(3004, '/api/auth/login', null, { email, password: process.env.DEMO_PASSWORD });
  const restaurant = await login('restaurant@foodflow.local');
  const partner = await login('delivery@foodflow.local');
  const owned = await pool.query('SELECT restaurant_id FROM auth_data.users WHERE id=$1', [restaurant.user.id]);
  const restaurantId = owned.rows[0].restaurant_id;
  const menu = await pool.query('SELECT id FROM restaurant_data.menu_items WHERE restaurant_id=$1 AND available=TRUE ORDER BY id LIMIT 1', [restaurantId]);
  if (!menu.rowCount) throw new Error('Demo restaurant has no available menu items.');
  const passwordHash = await bcrypt.hash(randomBytes(24).toString('base64url'), 12);
  const users = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), email: `load-${runId}-${index + 1}@foodflow.test`, role: 'CUSTOMER' }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO admin_data.load_runs(id,requested,concurrency) VALUES ($1,$2,$3)', [runId, count, concurrency]);
    await client.query(`INSERT INTO auth_data.users(id,name,email,password_hash,role)
      SELECT id, 'Load Customer ' || ordinal, email, $3, 'CUSTOMER'
      FROM unnest($1::uuid[], $2::text[]) WITH ORDINALITY AS fixture(id,email,ordinal)`, [users.map(u => u.id), users.map(u => u.email), passwordHash]);
    await client.query(`INSERT INTO admin_data.load_cases(run_id,sequence,customer_id)
      SELECT $1, ordinal, id FROM unnest($2::uuid[]) WITH ORDINALITY AS fixture(id,ordinal)`, [runId, users.map(u => u.id)]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  fs.mkdirSync(output, { recursive: true });
  console.log(`Run ${runId}: ${count} seeded customers; ${concurrency} concurrent order workflows.`);
  console.log('Fixture tokens are issued locally. Signup/login throughput is outside this test. No request retries hide errors.');
  const started = performance.now();
  let next = 0;
  async function worker() {
    while (next < count) {
      const index = next++;
      const user = users[index];
      const c = { sequence: index + 1, customerId: user.id, email: user.email, stage: 'order creation', outcome: 'pending' };
      const start = performance.now();
      try {
        if (stopped) throw new Error('Test interrupted before workflow started.');
        const token = tokenFor(user);
        const order = await request(3001, '/api/orders', token, { restaurantId, items: [{ menuItemId: menu.rows[0].id, quantity: 1 }] }, { 'Idempotency-Key': randomUUID() });
        c.orderId = order.id; c.stage = 'restaurant'; await save(c);
        for (const step of ['accept', 'preparing', 'ready']) await request(3002, `/api/restaurant/orders/${order.id}/${step}`, restaurant.accessToken, {});
        c.stage = 'kafka'; await save(c);
        const deadline = Date.now() + kafkaWaitMs;
        let delivery;
        do {
          const rows = await pool.query(`SELECT d.id FROM delivery_data.deliveries d
            JOIN order_data.outbox_events e ON e.aggregate_id=d.order_id AND e.status='PUBLISHED'
            JOIN delivery_data.processed_events p ON p.event_id=e.id
            WHERE d.order_id=$1`, [order.id]);
          delivery = rows.rows[0];
          if (!delivery) { if (stopped) throw new Error('Test interrupted while waiting for Kafka.'); await pause(250); }
        } while (!delivery && Date.now() < deadline);
        if (!delivery) throw new Error(`Kafka publication, consumption and delivery creation not confirmed within ${kafkaWaitMs} ms.`);
        c.deliveryId = delivery.id; c.stage = 'delivery'; await save(c);
        for (const step of ['accept', 'picked-up', 'delivered']) await request(3003, `/api/deliveries/${delivery.id}/${step}`, partner.accessToken, {});
        c.stage = 'customer verification';
        const final = await request(3001, `/api/orders/${order.id}`, token);
        if (final.status !== 'delivered' || final.customerId !== user.id) throw new Error('Customer cannot confirm their delivered order.');
        const check = await pool.query(`SELECT
          (SELECT count(*)::int FROM delivery_data.deliveries WHERE order_id=$1) AS deliveries,
          (SELECT COALESCE(sum(line_total_cents),0)::int FROM order_data.order_items WHERE order_id=$1) AS total,
          (SELECT status FROM delivery_data.deliveries WHERE order_id=$1) AS status`, [order.id]);
        if (check.rows[0].deliveries !== 1 || check.rows[0].status !== 'delivered' || check.rows[0].total !== final.totalCents) throw new Error('Delivery uniqueness, delivery status or invoice total mismatch.');
        c.stage = 'complete'; c.outcome = 'delivered';
      } catch (error) { c.outcome = 'failed'; c.reason = error.message; }
      c.durationMs = Math.round(performance.now() - start);
      await save(c); cases.push(c);
      fs.appendFileSync(path.join(output, 'cases.jsonl'), JSON.stringify(c) + '\n');
      if (cases.length % 100 === 0 || cases.length === count) console.log(`${cases.length}/${count}: ${cases.filter(x => x.outcome === 'delivered').length} delivered, ${cases.filter(x => x.outcome === 'failed').length} failed`);
    }
  }
  const workers = await Promise.allSettled(Array.from({ length: concurrency }, worker));
  const workerErrors = workers.filter(w => w.status === 'rejected').map(w => w.reason.message);
  const seconds = (performance.now() - started) / 1000;
  const delivered = cases.filter(c => c.outcome === 'delivered').length;
  const failed = cases.filter(c => c.outcome === 'failed').length;
  const latency = values => {
    const sorted = [...values].sort((a,b) => a-b);
    const percentile = p => Math.round(sorted[Math.max(0, Math.ceil(sorted.length*p)-1)] || 0);
    return { p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: percentile(1) };
  };
  const report = { runId, requested: count, provisionedUsers: count, completed: cases.length, delivered, failed,
    unaccounted: count - cases.length, concurrency, seconds: Number(seconds.toFixed(2)),
    deliveredPerSecond: Number((delivered/seconds).toFixed(2)), ...latency(cases.map(c => c.durationMs)), workerErrors,
    scope: 'Local seeded accounts and signed fixture tokens; real order, restaurant and delivery APIs plus Kafka; simulated restaurant and delivery actors. Not a signup/login load test or proof of physical receipt.',
    endpoints: Object.fromEntries(Object.entries(metrics).map(([key,m]) => [key, { count: m.count, failures: m.failures, ...latency(m.durations) }])),
    failures: cases.filter(c => c.outcome === 'failed') };
  const passed = delivered === count && !workerErrors.length;
  await pool.query(`UPDATE admin_data.load_runs SET status=$2, finished_at=NOW(), report=$3::jsonb WHERE id=$1`, [runId, passed ? 'passed' : 'failed', JSON.stringify(report)]);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(output, 'REPORT.md'), `# FoodFlow order load test\n\nRun: ${runId}\n\nResult: ${passed ? 'PASS' : 'FAIL'}\n\n${delivered}/${count} delivered; ${failed} failed; ${report.unaccounted} unaccounted.\n\n${seconds.toFixed(2)} seconds at concurrency ${concurrency}; ${report.deliveredPerSecond} delivered orders/second.\n\nWorkflow latency p50/p95/p99: ${report.p50Ms}/${report.p95Ms}/${report.p99Ms} ms.\n\n${report.scope}\n\nSee report.json for per-endpoint latency and failure reasons; cases.jsonl contains every completed workflow. Fixtures retained for the super-admin dashboard.\n`);
  console.log(JSON.stringify({ runId, passed, delivered, failed, seconds: report.seconds, deliveredPerSecond: report.deliveredPerSecond, p95Ms: report.p95Ms, output }, null, 2));
  if (!passed) process.exitCode = 1;
}
main().catch(async error => {
  console.error(error.message); process.exitCode = 1;
  await pool.query(`UPDATE admin_data.load_runs SET status='failed', finished_at=NOW(), report=$2::jsonb WHERE id=$1`, [runId, JSON.stringify({ fatal: error.message })]).catch(() => {});
}).finally(() => pool.end());
