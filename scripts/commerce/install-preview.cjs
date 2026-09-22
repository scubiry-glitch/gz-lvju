'use strict';
// Reviewed, narrowly scoped installation for the requested sytest preview domain.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const config = '/etc/nginx/conf.d/sytest.meizu.life.conf';
const unit = '/etc/systemd/system/sy-commerce-preview.service';
const original = fs.readFileSync(config, 'utf8');
if (!original.includes('server_name sytest.meizu.life;') || !original.includes('root /proweb/run/sy;')) throw new Error('Unexpected nginx target');
const location = fs.readFileSync(path.join(root, 'deploy/commerce/nginx-location.conf'), 'utf8');
const existingUnit = fs.existsSync(unit) ? fs.readFileSync(unit, 'utf8') : null;
const withoutBlock = original.replace(/    # commerce-preview:begin[\s\S]*?    # commerce-preview:end\n?/, '');
const anchor = '    location ^~ /api/ {';
if (!withoutBlock.includes(anchor)) throw new Error('Existing API location not found');
const updated = withoutBlock.replace(anchor, location + '\n' + anchor);
const backup = config + '.bak-commerce-' + Date.now();
fs.copyFileSync(config, backup);
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
try {
  fs.writeFileSync(config, updated);
  run('nginx', ['-t']);
  fs.copyFileSync(path.join(root, 'deploy/commerce/sy-commerce-preview.service'), unit);
  run('systemctl', ['daemon-reload']);
  run('systemctl', ['enable', '--now', 'sy-commerce-preview.service']);
  if (existingUnit) run('systemctl', ['restart', 'sy-commerce-preview.service']);
  run('systemctl', ['is-active', '--quiet', 'sy-commerce-preview.service']);
  const health = JSON.parse(execFileSync('curl', ['-fsS','--retry','10','--retry-connrefused','--retry-delay','1','-H','Host: sytest.meizu.life','http://127.0.0.1:38780/api/commerce/v1/meta'], {encoding:'utf8'}));
  if(health.data?.mode !== 'mysql-m1a' || health.data.payment_enabled !== false) throw new Error('M1-A health check failed');
  // IAM permission catalogue is loaded once by the original API process.
  run('systemctl', ['restart', 'juzhu-api.service']);
  run('systemctl', ['is-active', '--quiet', 'juzhu-api.service']);
  // Existing nginx service ExecReload has a stale PrivateTmp namespace on this host.
  // Signal the running nginx master directly after nginx -t; do not restart traffic.
  run('nginx', ['-s', 'reload']);
  console.log('Installed sytest M1-A persistent commerce API; nginx backup: ' + backup);
} catch (e) {
  fs.writeFileSync(config, original);
  if (existingUnit !== null) fs.writeFileSync(unit, existingUnit);
  else if (fs.existsSync(unit)) { try { execFileSync('systemctl', ['disable', '--now', 'sy-commerce-preview.service']); } catch {} fs.unlinkSync(unit); }
  run('systemctl', ['daemon-reload']);
  if (existingUnit !== null) run('systemctl', ['restart', 'sy-commerce-preview.service']);
  run('nginx', ['-t']); run('nginx', ['-s', 'reload']);
  throw e;
}
