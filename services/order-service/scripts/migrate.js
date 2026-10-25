const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
const migrationsDir = path.resolve(__dirname, '../../../infrastructure/migrations');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(71001, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const files = fs.readdirSync(migrationsDir).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    for (const file of files) {
      await client.query('BEGIN');
      try {
        const existing = await client.query('SELECT 1 FROM public.schema_migrations WHERE version = $1', [file]);
        if (!existing.rowCount) {
          await client.query(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
          await client.query('INSERT INTO public.schema_migrations(version) VALUES ($1)', [file]);
          console.log(`Applied ${file}`);
        } else {
          console.log(`Already applied ${file}`);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(71001, 1)');
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
