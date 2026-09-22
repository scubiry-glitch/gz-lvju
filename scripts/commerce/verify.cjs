'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'docs/verification/newliving-commerce');
const commands = [
  ['--test', 'scripts/commerce/domain.test.cjs', 'scripts/commerce/http.test.cjs'],
  ['test_index_boot.js'], ['test_static_guard.js'],
];
const results = commands.map((args, i) => {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 30000 });
  fs.writeFileSync(path.join(out, `check-${i + 1}.txt`), (r.stdout || '') + (r.stderr || '') + (r.error ? '\n' + r.error.message : ''));
  return { command: 'node ' + args.join(' '), exit_code: r.status, passed: r.status === 0 && !r.error, log: `check-${i + 1}.txt` };
});
fs.writeFileSync(path.join(out, 'automated-results.json'), JSON.stringify({ generated_at: new Date().toISOString(), adapter: 'isolated-memory-test', results }, null, 2));
for (const r of results) console.log((r.passed ? 'PASS ' : 'FAIL ') + r.command);
if (results.some((r) => !r.passed)) process.exitCode = 1;
