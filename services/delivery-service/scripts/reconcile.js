const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function main() {
  if (!process.env.INTERNAL_API_TOKEN) throw new Error('INTERNAL_API_TOKEN is required.');
  const port = Number(process.env.PORT || 3003);
  const timeout = Math.max(30000, Number(process.env.HTTP_TIMEOUT_MS || 5000));
  const response = await fetch(`http://localhost:${port}/internal/deliveries/reconcile`, {
    method: 'POST',
    headers: { 'X-Internal-Token': process.env.INTERNAL_API_TOKEN },
    signal: AbortSignal.timeout(timeout)
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Reconciliation failed (${response.status}).`);
  console.log(body);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
