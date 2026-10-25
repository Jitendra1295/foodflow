const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const scripts = ['frontend/smoke.playwright.cjs'];
if (process.env.ADMIN_PASSWORD) scripts.push('frontend/admin.playwright.cjs');
for (const script of scripts) {
  const result = spawnSync(process.execPath, [path.join(root, script)], {
    cwd: root, stdio: 'inherit', env: { ...process.env, FOODFLOW_RECORD_DEMO: '1' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status || 1; break; }
}
if (!process.env.ADMIN_PASSWORD) console.log('Set ADMIN_PASSWORD to also record the admin dashboard.');
