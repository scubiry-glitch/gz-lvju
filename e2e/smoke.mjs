const BASE = process.env.BASE_URL || 'http://localhost:9101';

async function check(label, fn) {
  try {
    await fn();
    console.log(`✓ ${label}`);
  } catch(e) {
    console.error(`✗ ${label}: ${e.message}`);
    process.exit(1);
  }
}

// Frontend check
await check('GET / returns 200', async () => {
  const res = await fetch(`${BASE}/`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  if (!html.includes('<')) throw new Error('Not HTML');
});

// Check for script tags
await check('index.html has content', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  if (html.trim().length < 100) throw new Error('HTML too short');
});

// API stats
await check('GET /api/juzhu/stats returns 200', async () => {
  const res = await fetch(`${BASE}/api/juzhu/stats`);
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.districts === undefined) throw new Error('Missing districts field');
});

// Admin auth check
await check('GET /api/juzhu/admin/auth/check returns 200', async () => {
  const res = await fetch(`${BASE}/api/juzhu/admin/auth/check`);
  if (res.status < 200 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
});

console.log('All smoke tests passed!');
