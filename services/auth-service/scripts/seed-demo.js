const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const password = process.env.DEMO_PASSWORD;
if (!password || password.length < 8) throw new Error('Set DEMO_PASSWORD (8+ characters) in services/auth-service/.env for local demo accounts.');

const accounts = [
  { name: 'Demo Customer', email: 'customer@foodflow.local', role: 'CUSTOMER' },
  { name: 'Demo Restaurant', email: 'restaurant@foodflow.local', role: 'RESTAURANT', restaurantId: process.env.DEMO_RESTAURANT_ID || 'restaurant-pasta-house' },
  { name: 'Demo Delivery Partner', email: 'delivery@foodflow.local', role: 'DELIVERY_PARTNER' }
];

async function call(route, body) {
  const response = await fetch(`http://localhost:${process.env.PORT || 3004}${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function seed() {
  for (const account of accounts) {
    const signedUp = await call('/api/auth/signup', { ...account, password });
    if (signedUp.status !== 201 && signedUp.status !== 409) throw new Error(`${account.email}: ${signedUp.body.error}`);
    const loggedIn = await call('/api/auth/login', { email: account.email, password });
    if (loggedIn.status !== 200 || loggedIn.body.user.role !== account.role) {
      throw new Error(`${account.email}: existing account does not match the local demo password or role.`);
    }
    console.log(`${account.role}: ${account.email}`);
  }
}

seed().catch((error) => { console.error(error); process.exitCode = 1; });
