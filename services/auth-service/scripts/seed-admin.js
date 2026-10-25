const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../src/db');

async function seed() {
  const email = (process.env.ADMIN_EMAIL || 'admin@yopmail.com').toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 8 || Buffer.byteLength(password) > 72) throw new Error('Set ADMIN_PASSWORD (8 to 72 bytes).');
  const hash = await bcrypt.hash(password, 12);
  const existing = await db.query('SELECT role FROM auth_data.users WHERE lower(email) = $1', [email]);
  if (existing.rowCount && existing.rows[0].role !== 'SUPER_ADMIN') throw new Error('Email belongs to a non-admin account; refusing to promote it.');
  await db.query(`INSERT INTO auth_data.users(id,name,email,password_hash,role)
    VALUES ($1,'Super Admin',$2,$3,'SUPER_ADMIN')
    ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`, [randomUUID(), email, hash]);
  console.log(`Super admin ready: ${email}`);
}
seed().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => db.close());
