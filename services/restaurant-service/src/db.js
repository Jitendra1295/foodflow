const { Pool } = require('pg');
const { databaseUrl, dbTimeoutMs } = require('./config');

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: dbTimeoutMs,
  query_timeout: dbTimeoutMs,
  statement_timeout: dbTimeoutMs,
  lock_timeout: dbTimeoutMs
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  close: () => pool.end()
};
