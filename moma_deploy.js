'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');
const os = require('os');

(async () => {
  // Step 1 — Parse & validate parameters
  const args = process.argv.slice(2);
  function getArg(name) {
    const idx = args.indexOf(name);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const serviceUrl = getArg('--service-url');
  const emailPrefix = getArg('--email-prefix');
  const ucid = getArg('--ucid');
  const env = getArg('--env');
  const taskId = getArg('--task-id');
  const deployEnv = getArg('--deploy-env') || 'test';
  let funcName = getArg('--func-name');
  const serviceName = getArg('--service-name');
  const runtime = getArg('--runtime') || 'python';

  if (!serviceUrl || !emailPrefix || !ucid || !env || !taskId) {
    console.error('Usage: node moma_deploy.js --service-url <url> --email-prefix <prefix> --ucid <ucid> --env <env> --task-id <id> [--func-name <name>] [--service-name <name>] [--deploy-env test|prod] [--runtime node|python]');
    process.exit(1);
  }

  const logDir = path.join(os.homedir(), '.moma', 'logs');
  fs.mkdirSync(logDir, { recursive: true });

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function toCurl(method, url, headers, body) {
    const parts = [];
    let first = 'curl --location';
    if (method !== 'GET') first += ` --request ${method}`;
    first += ` '${url}'`;
    parts.push(first);
    for (const [k, v] of Object.entries(headers)) parts.push(`  --header '${k}: ${v}'`);
    if (body != null) parts.push(`  --data '${JSON.stringify(body).replace(/'/g, "'\\''")}'`);
    return parts.join(' \\\n');
  }

  function httpFetch(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const payload = body != null ? JSON.stringify(body) : undefined;
      const reqHeaders = Object.assign({}, headers);
      if (payload) reqHeaders['Content-Length'] = Buffer.byteLength(payload);
      const req = lib.request(parsed, { method, headers: reqHeaders }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (e) { reject(new Error('Invalid JSON response')); }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function httpRequest(method, url, headers, body) {
    const json = await httpFetch(method, url, headers, body);
    if (json.errno !== 0) { console.error(`API error: ${json.msg || json.error}`); process.exit(1); }
    return json;
  }

  function httpPutPresigned(url, buffer) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(parsed, { method: 'PUT',
        headers: { 'Content-Length': buffer.length, 'Content-Type': 'application/octet-stream' }
      }, res => {
        res.resume();
        const etag = (res.headers['etag'] || '').replace(/"/g, '');
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(etag);
        else reject(new Error(`S3 PUT failed: HTTP ${res.statusCode}`));
      });
      req.on('error', reject);
      req.write(buffer);
      req.end();
    });
  }

  const serviceId = env === 'prod' ? 'btg-serverless' : 'gpt-api';
  const commonHeaders = { 'X-Email-Prefix': emailPrefix, 'X-User-Ucid': ucid };
  const jsonHeaders = { ...commonHeaders, 'Content-Type': 'application/json' };

  // Step 2 — Build
  const checkedZip = path.resolve('..', 'moma_checked.zip');
  const momaZip = path.resolve('..', 'moma.zip');
  let skipPackaging = false;
  if (fs.existsSync(checkedZip)) {
    console.log('[1/9] Reusing pre-verified package from ../moma_checked.zip, skipping build and packaging...');
    fs.renameSync(checkedZip, momaZip);
    skipPackaging = true;
  } else {
    console.log('[1/9] Building...');
    execSync('./moma_build.sh', { stdio: 'inherit' });
  }

  // Step 3 — Generate zip package
  if (skipPackaging) {
    console.log('[2/9] Packaging skipped (using renamed moma_checked.zip)');
  } else {
    console.log('[2/9] Packaging...');
    const envFile = `.env.${deployEnv}`;
    if (fs.existsSync(envFile)) {
      fs.copyFileSync(envFile, '.env');
    } else if (!fs.existsSync('.env')) {
      console.warn(`[warn] ${envFile} / .env 均不存在：运行时 MySQL/API 密钥需由平台环境变量注入`);
    }
    // 打包必要文件：Node 入口 + Python + 业务静态页。
    // .env 仅供 scf_bootstrap source，由 app.js / server.py 拦截 HTTP，切勿漏拦。
    // 明确排除：源码密钥文档、测试密钥、二次 .env.*、git 元数据。
    execSync([
      'zip -q ../moma.zip .env scf_bootstrap moma_build.sh app.js package.json 2>/dev/null || true',
      'zip -rq ../moma.zip juzhu/ -x "juzhu/__pycache__/*" -x "juzhu/*.pyc" -x "juzhu/*.db" -x "juzhu/.env" -x "juzhu/.env.*" -x "juzhu/*.sqlite*"',
      'for f in *.html; do zip -q ../moma.zip "$f" 2>/dev/null; done',
      'zip -rq ../moma.zip screens/ assets/ 2>/dev/null || true',
      // docs/ 含设计稿可打包，但 api_doc / 含密钥 md 必须排除
      'zip -rq ../moma.zip docs/ -x "docs/**/api_doc.md" -x "docs/**/*secret*" 2>/dev/null || true',
      'zip -q ../moma.zip -d api_doc.md CLAUDE.md VERIFICATION.md .env.prod .env.test .env.example 2>/dev/null || true',
      '[ -d node_modules ] && zip -rq ../moma.zip node_modules/ -x "node_modules/.cache/*" -x "node_modules/.bin/*" 2>/dev/null || true',
    ].join(' && '), { stdio: 'inherit', shell: '/bin/bash' });
    fs.rmSync('.env', { force: true });
    const zipStat = fs.statSync(momaZip);
    const zipMB = (zipStat.size / 1024 / 1024).toFixed(1);
    console.log(`  zip size: ${zipMB} MB`);
    if (zipStat.size > 500 * 1024 * 1024) {
      console.error('zip exceeds 500 MB hard limit, cannot proceed');
      process.exit(1);
    }
  }

  // Step 4 — Create application (if no funcName)
  if (!funcName) {
    console.log('[3/9] Creating application...');
    const body = { taskId, serviceId, alias: serviceName, template: 'html-template', envType: deployEnv, runtime: runtime || 'python' };
    fs.writeFileSync(path.join(logDir, 'deploy_step_1'),
      toCurl('POST', `${serviceUrl}/api/btg/agent/serverless/app/create`, jsonHeaders, body));
    const res = await httpRequest('POST', `${serviceUrl}/api/btg/agent/serverless/app/create`,
      jsonHeaders, body);
    funcName = res.data.name;
    await sleep(3000);

    // Step 5 — Wait for application to become active
    console.log('[4/9] Waiting for application to become active...');
    fs.writeFileSync(path.join(logDir, 'deploy_step_1b'),
      toCurl('GET', `${serviceUrl}/api/btg/agent/serverless/app/detail?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}`, commonHeaders));
    for (let i = 0; i < 30; i++) {
      try {
        const res = await httpFetch('GET',
          `${serviceUrl}/api/btg/agent/serverless/app/detail?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}`,
          { 'X-Email-Prefix': emailPrefix, 'X-User-Ucid': ucid });
        if ((res?.data?.realStatus || '').toLowerCase() === 'active' || res?.data?.status?.toString() === '0') break;
      } catch (e) { /* treat as not ready */ }
      if (i === 29) { console.error('Timeout waiting for application realStatus to become active'); process.exit(1); }
      await sleep(10000);
    }
    await sleep(3000);
  } else {
    console.log(`[3/9] Skipping app creation (using existing funcName: ${funcName})`);
    console.log('[4/9] Skipping active wait (existing app)');
  }

  // Step 6 — Upload code
  console.log('[5/9] Uploading code...');
  const zipData = fs.readFileSync(momaZip);
  const PART_SIZE = 15 * 1024 * 1024;
  const fileName = 'moma.zip';

  fs.writeFileSync(path.join(logDir, 'deploy_step_2'),
    toCurl('POST', `${serviceUrl}/api/btg/agent/serverless/code/multipart/initiate`, jsonHeaders,
      { serviceId, funcName, fileName }));
  const initRes = await httpRequest('POST', `${serviceUrl}/api/btg/agent/serverless/code/multipart/initiate`,
    jsonHeaders, { serviceId, funcName, fileName });
  const { uploadId, key } = initRes.data;

  const parts = [];
  const totalParts = Math.ceil(zipData.length / PART_SIZE);
  try {
    for (let i = 0; i < totalParts; i++) {
      const partNumber = i + 1;
      const chunk = zipData.slice(i * PART_SIZE, (i + 1) * PART_SIZE);
      const urlRes = await httpRequest('POST', `${serviceUrl}/api/btg/agent/serverless/code/multipart/url`,
        jsonHeaders, { serviceId, funcName, key, uploadId, partNumber });
      const presignedUrl = urlRes.data.url;
      const etag = await httpPutPresigned(presignedUrl, chunk);
      parts.push({ partNumber, etag });
      console.log(`  part ${partNumber}/${totalParts} uploaded`);
    }
  } catch (e) {
    await httpRequest('POST', `${serviceUrl}/api/btg/agent/serverless/code/multipart/abort`,
      jsonHeaders, { serviceId, funcName, key, uploadId }).catch(() => {});
    throw e;
  }

  const uploadResult = await httpRequest('POST', `${serviceUrl}/api/btg/agent/serverless/code/multipart/complete`,
    jsonHeaders, { serviceId, funcName, key, uploadId, parts });
  const cosObjectName = uploadResult.data.cosObjectName;
  const uploadedZipUrl = 'https://storage.lianjia.com' + cosObjectName;
  console.log(`upload complete: ${uploadedZipUrl}`);

  fs.writeFileSync(path.join(logDir, 'deploy_step_2b'),
    toCurl('PUT', `${serviceUrl}/api/btg/agent/serverless/app/code`, jsonHeaders,
      { taskId, serviceId, funcName, cosObjectName }));
  await httpRequest('PUT', `${serviceUrl}/api/btg/agent/serverless/app/code`,
    jsonHeaders, { taskId, serviceId, funcName, cosObjectName });
  console.log('code updated ' + cosObjectName);

  // Step 7 — Clean up zip
  fs.rmSync(momaZip, { force: true });

  // Step 8 — Wait for function to be ready
  console.log('[5/9] Waiting for function to be ready...');
  await sleep(3000);
  fs.writeFileSync(path.join(logDir, 'deploy_step_3'),
    toCurl('GET', `${serviceUrl}/api/btg/agent/serverless/app/detail?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}`, commonHeaders));
  for (let i = 0; i < 18; i++) {
    const res = await httpRequest('GET',
      `${serviceUrl}/api/btg/agent/serverless/app/detail?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}`,
      { 'X-Email-Prefix': emailPrefix, 'X-User-Ucid': ucid });
    if ((res?.data?.realStatus || '').toLowerCase() === 'active' || res?.data?.status?.toString() === '0') break;
    if (i === 17) { console.error('Timeout waiting for function to leave Updating state'); process.exit(1); }
    await sleep(10000);
  }

  // Step 9 — Publish
  console.log('[6/9] Publishing...');
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const publishUrl = `${serviceUrl}/api/btg/agent/serverless/app/publish?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}&description=deploy-${encodeURIComponent(timestamp)}`;
  fs.writeFileSync(path.join(logDir, 'deploy_step_4'), toCurl('POST', publishUrl, commonHeaders));
  let pubRes;
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      const json = await httpFetch('POST', publishUrl, commonHeaders);
      if (json.errno !== 0) throw new Error(json.msg || json.error || `errno ${json.errno}`);
      pubRes = json;
      break;
    } catch (e) {
      if (attempt === 30) { console.error(`Publish failed after 30 attempts: ${e.message}`); process.exit(1); }
      console.warn(`Publish attempt ${attempt} failed, retrying in 10s...`);
      await sleep(10000);
    }
  }
  const latestVersion = pubRes.data.version;
  await sleep(3000);

  // Step 10 — Poll version status
  console.log('[7/9] Waiting for version to become Active...');
  fs.writeFileSync(path.join(logDir, 'deploy_step_5'),
    toCurl('GET', `${serviceUrl}/api/btg/agent/serverless/app/version/status?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}&version=${latestVersion}`, commonHeaders));
  for (let i = 0; i < 30; i++) {
    const res = await httpRequest('GET',
      `${serviceUrl}/api/btg/agent/serverless/app/version/status?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}&version=${latestVersion}`,
      { 'X-Email-Prefix': emailPrefix, 'X-User-Ucid': ucid });
    if ((res?.data?.status || '').toLowerCase() === 'active') break;
    if (i === 29) { console.error('Timeout waiting for Active status'); process.exit(1); }
    await sleep(10000);
  }

  // Step 11 — Switch traffic
  console.log('[8/9] Switching traffic...');
  fs.writeFileSync(path.join(logDir, 'deploy_step_6'),
    toCurl('PUT', `${serviceUrl}/api/btg/agent/serverless/app/traffic?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}&version=${latestVersion}&weight=100`, commonHeaders));
  await httpRequest('PUT',
    `${serviceUrl}/api/btg/agent/serverless/app/traffic?taskId=${taskId}&serviceId=${serviceId}&funcName=${funcName}&version=${latestVersion}&weight=100`,
    { 'X-Email-Prefix': emailPrefix, 'X-User-Ucid': ucid });

  // Step 12 — Clean up logs
  console.log('[9/9] Cleaning up...');
  fs.rmSync(logDir, { recursive: true, force: true });

  console.log(`\nDeployment complete! funcName=${funcName} version=${latestVersion}`);
})().catch(e => { console.error(e); process.exit(1); });
