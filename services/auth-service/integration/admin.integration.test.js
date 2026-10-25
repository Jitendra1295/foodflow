const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const config = require('../src/config');
const pool = new Pool({ connectionString: config.databaseUrl });
const adminId = randomUUID();
const customerId = randomUUID();
const orderIds = [];
const tokens = {};
const token = (id, role) => jwt.sign({ role }, config.jwtSecret, { subject: id, issuer: config.jwtIssuer, expiresIn: '5m' });

async function request(port, route, accessToken, body) {
  const response = await fetch(`http://localhost:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  return { status: response.status, body: await response.json() };
}
test.before(async () => {
  for (const [id, role] of [[adminId,'SUPER_ADMIN'],[customerId,'CUSTOMER']]) {
    await pool.query(`INSERT INTO auth_data.users(id,name,email,password_hash,role) VALUES ($1,'Admin test',$2,'unusable-test-hash',$3)`, [id, `${id}@foodflow.test`, role]);
    tokens[role] = token(id, role);
  }
  const demo = await pool.query(`SELECT id,role FROM auth_data.users WHERE email IN ('restaurant@foodflow.local','delivery@foodflow.local')`);
  for (const user of demo.rows) tokens[user.role] = token(user.id, user.role);
});
test.after(async () => {
  if (orderIds.length) {
    await pool.query('DELETE FROM admin_data.request_failures WHERE resource_id=ANY($1::uuid[]) OR resource_id IN (SELECT id FROM delivery_data.deliveries WHERE order_id=ANY($1::uuid[]))', [orderIds]);
    await pool.query('DELETE FROM delivery_data.delivery_operations WHERE delivery_id IN (SELECT id FROM delivery_data.deliveries WHERE order_id=ANY($1::uuid[]))', [orderIds]);
    await pool.query('DELETE FROM delivery_data.deliveries WHERE order_id=ANY($1::uuid[])', [orderIds]);
    await pool.query('DELETE FROM delivery_data.processed_events WHERE order_id=ANY($1::uuid[])', [orderIds]);
    await pool.query('DELETE FROM order_data.status_operations WHERE order_id=ANY($1::uuid[])', [orderIds]);
    await pool.query('DELETE FROM order_data.orders WHERE id=ANY($1::uuid[])', [orderIds]);
  }
  await pool.query('DELETE FROM auth_data.users WHERE id=ANY($1::uuid[])', [[adminId,customerId]]);
  await pool.end();
});

test('admin APIs reject public/customer access and public signup cannot grant SUPER_ADMIN', async () => {
  for (const route of ['/summary','/orders','/failures','/runs',`/orders/${randomUUID()}/invoice`,`/runs/${randomUUID()}/cases`]) {
    assert.equal((await request(3004, `/api/admin${route}`)).status, 401);
    assert.equal((await request(3004, `/api/admin${route}`, tokens.CUSTOMER)).status, 403);
  }
  const signup = await request(3004, '/api/auth/signup', null, { name:'Forbidden admin', email:`${randomUUID()}@foodflow.test`, password:'TestOnly@123', role:'SUPER_ADMIN' });
  assert.equal(signup.status,400);
  assert.equal((await request(3004, '/api/admin/summary', tokens.SUPER_ADMIN)).status,200);
  await pool.query(`UPDATE auth_data.users SET role='CUSTOMER' WHERE id=$1`,[adminId]);
  assert.equal((await request(3004, '/api/admin/summary', tokens.SUPER_ADMIN)).status,403);
  await pool.query(`UPDATE auth_data.users SET role='SUPER_ADMIN' WHERE id=$1`,[adminId]);
});

test('admin invoices, pagination, rejection reasons and restaurant/delivery error attribution', async () => {
  for (let i=0;i<2;i++) {
    const created = await request(3001, '/api/orders', tokens.CUSTOMER, { restaurantId:'restaurant-pasta-house', items:[{menuItemId:'item-margherita',quantity:2}] });
    assert.equal(created.status,201,JSON.stringify(created.body)); orderIds.push(created.body.id);
  }
  const [rejected, delivered] = orderIds;
  assert.equal((await request(3002,`/api/restaurant/orders/${rejected}/reject`,tokens.RESTAURANT,{rejectionReason:'Kitchen closed for test'})).status,200);
  assert.equal((await request(3002,`/api/restaurant/orders/${delivered}/ready`,tokens.RESTAURANT,{})).status,409);
  for (const step of ['accept','preparing','ready']) assert.equal((await request(3002,`/api/restaurant/orders/${delivered}/${step}`,tokens.RESTAURANT,{})).status,200);
  const available = await request(3003,'/api/deliveries/available',tokens.DELIVERY_PARTNER);
  const delivery = available.body.find(d => d.orderId === delivered);
  assert.ok(delivery);
  assert.equal((await request(3003,`/api/deliveries/${delivery.id}/accept`,tokens.DELIVERY_PARTNER,{})).status,200);
  assert.equal((await request(3003,`/api/deliveries/${delivery.id}/issue`,token(customerId,'DELIVERY_PARTNER'),{reason:'Wrong partner test'})).status,403);
  assert.equal((await request(3003,`/api/deliveries/${delivery.id}/issue`,tokens.DELIVERY_PARTNER,{reason:'Vehicle puncture; waiting for repair'})).status,200);
  const issueInvoice = await request(3004,`/api/admin/orders/${delivered}/invoice`,tokens.SUPER_ADMIN);
  assert.match(issueInvoice.body.order.delivery_issue,/Vehicle puncture/);
  assert.equal((await request(3003,`/api/deliveries/${delivery.id}/resolve-issue`,tokens.DELIVERY_PARTNER,{})).status,200);
  assert.equal((await request(3003,`/api/deliveries/${delivery.id}/issue`,tokens.DELIVERY_PARTNER,{reason:'Customer temporarily unreachable'})).status,200);
  assert.equal((await request(3003,`/api/deliveries/${delivery.id}/delivered`,tokens.DELIVERY_PARTNER,{})).status,409);
  for (const step of ['picked-up','delivered']) assert.equal((await request(3003,`/api/deliveries/${delivery.id}/${step}`,tokens.DELIVERY_PARTNER,{})).status,200);
  // Audit writes are asynchronous; allow a bounded wait for persistence.
  let invoice;
  for (let i=0;i<20;i++) {
    invoice = await request(3004,`/api/admin/orders/${delivered}/invoice`,tokens.SUPER_ADMIN);
    if (invoice.body.failures?.length === 3) break;
    await new Promise(r => setTimeout(r,100));
  }
  assert.equal(invoice.status,200,JSON.stringify(invoice.body));
  assert.equal(invoice.body.totalCents,invoice.body.items.reduce((sum,i)=>sum+i.line_total_cents,0));
  assert.equal(invoice.body.totalCents,2798);
  assert.deepEqual(invoice.body.failures.map(f=>f.service).sort(),['delivery','delivery','restaurant']);
  assert.equal(invoice.body.order.delivery_issue,null);
  assert.equal(invoice.body.deliveryIssues.length,2);
  assert.ok(invoice.body.deliveryIssues.every(i=>i.resolved_at));
  assert.equal(invoice.body.order.status,'delivered');
  const rejectedInvoice = await request(3004,`/api/admin/orders/${rejected}/invoice`,tokens.SUPER_ADMIN);
  assert.equal(rejectedInvoice.body.order.rejection_reason,'Kitchen closed for test');
  const list = await request(3004,`/api/admin/orders?status=rejected&search=${rejected}`,tokens.SUPER_ADMIN);
  assert.equal(list.body.total,1); assert.equal(list.body.orders.length,1);
  assert.equal((await request(3004,'/api/admin/orders?page=-1',tokens.SUPER_ADMIN)).status,400);
  assert.equal((await request(3004,'/api/admin/orders?search=%27%20OR%201%3D1--',tokens.SUPER_ADMIN)).body.total,0);
});
