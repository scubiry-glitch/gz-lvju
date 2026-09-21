#!/usr/bin/env node
/**
 * scripts/s3_region_probe.cjs —— 探测 V4 签名可用的 region / 寻址组合
 *
 * 背景：AWS Signature V4 的签名串**包含 region**，region 不对 → 服务端算不出同样签名 →
 * 一律 403 AccessDenied（与「不支持 V4」表现相同，容易误判）。本脚本用对象级 PUT 探针
 * （不用桶级 HEAD/GET，业务账号无 ListBucket 权限）逐组合试，找出真正可用的组合。
 *
 * 用法：
 *   node scripts/s3_region_probe.cjs
 *   node scripts/s3_region_probe.cjs --regions=us-east-1,cn-north-1,ods --versions=v4
 *   node scripts/s3_region_probe.cjs --addressings=path,virtual
 *
 * 凭证只从环境变量 / juzhu/.env.local / .env / runtime.env 读取。
 */
'use strict';

const fs = require('fs');
const path = require('path');

for (const f of ['juzhu/.env.local', '.env', 'runtime.env']) {
  const p = path.join(__dirname, '..', f);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const k = t.slice(0, t.indexOf('=')).trim().replace(/^export /, '');
    const v = t.slice(t.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const S3 = require('../s3_client.cjs');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join(',') : dflt;
};

const DEFAULT_REGIONS = [
  'us-east-1', 'cn-north-1', 'cn-northwest-1', 'ap-east-1', 'ap-southeast-1',
  'beijing', 'shanghai', 'china', 'cn', 'lj', 'lianjia', 'ods', 'ke', 'test', 'default',
];
const REGIONS = arg('regions', DEFAULT_REGIONS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const VERSIONS = arg('versions', 'v4,v2').split(',').map((s) => s.trim()).filter(Boolean);
const ADDRESSINGS = arg('addressings', 'path,virtual').split(',').map((s) => s.trim()).filter(Boolean);
const PREFIX = arg('prefix', 'probe');

const PROBE_BODY = Buffer.from('lianjia-ods-region-probe');

async function probeOnce({ version, region, addressing }) {
  process.env.S3_SIGN_VERSION = version;
  process.env.S3_REGION = region;
  process.env.S3_ADDRESSING = addressing;
  const key = `${PREFIX}/.probe/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`;
  try {
    const put = await S3.request('PUT', key, { body: PROBE_BODY, contentType: 'text/plain', timeoutMs: 12000 });
    if (!put.ok) {
      const msg = (put.error || put.text || '').replace(/\s+/g, ' ').slice(0, 110);
      return { ok: false, status: put.status, why: msg };
    }
    const got = await S3.request('GET', key, { timeoutMs: 12000 });
    const bytes = got.buffer ? got.buffer.length : 0;
    await S3.request('DELETE', key, { timeoutMs: 12000 });
    if (bytes !== PROBE_BODY.length) return { ok: false, status: put.status, why: `写入 ${bytes}B ≠ ${PROBE_BODY.length}B` };
    return { ok: true, status: put.status, etag: put.headers && put.headers.etag };
  } catch (e) {
    return { ok: false, status: 0, why: String(e && e.message || e) };
  }
}

(async () => {
  const saved = { v: process.env.S3_SIGN_VERSION, r: process.env.S3_REGION, a: process.env.S3_ADDRESSING };
  const cfg = S3.config();
  console.log('=== S3 签名 region / 寻址 探测 ===');
  console.log(`endpoint : ${cfg.endpoint}`);
  console.log(`bucket   : ${cfg.bucket}`);
  console.log(`当前配置 : version=${cfg.signVersion} region=${cfg.region} addressing=${cfg.addressing}`);
  console.log(`探测矩阵 : ${VERSIONS.length} 版本 × ${REGIONS.length} region × ${ADDRESSINGS.length} 寻址 = ${VERSIONS.length * REGIONS.length * ADDRESSINGS.length} 次\n`);

  const results = [];
  for (const version of VERSIONS) {
    for (const addressing of ADDRESSINGS) {
      for (const region of REGIONS) {
        // eslint-disable-next-line no-await-in-loop
        const r = await probeOnce({ version, region, addressing });
        results.push(Object.assign({ version, region, addressing }, r));
        console.log(`${r.ok ? 'PASS' : 'fail'}  ${version.padEnd(2)} ${addressing.padEnd(7)} region=${region.padEnd(14)} ${r.ok ? 'ETag ' + r.etag : 'HTTP ' + r.status + '  ' + (r.why || '')}`);
      }
    }
  }

  if (saved.v == null) delete process.env.S3_SIGN_VERSION; else process.env.S3_SIGN_VERSION = saved.v;
  if (saved.r == null) delete process.env.S3_REGION; else process.env.S3_REGION = saved.r;
  if (saved.a == null) delete process.env.S3_ADDRESSING; else process.env.S3_ADDRESSING = saved.a;

  const winners = results.filter((r) => r.ok);
  console.log('\n=== 可用组合 ===');
  if (!winners.length) {
    console.log('无：请确认 access-key/secret-key、bucket 写权限，或补充候选 region（--regions=...）');
  } else {
    for (const w of winners) console.log(`✔ ${w.version} / ${w.addressing} / region=${w.region}`);
    const v4 = winners.find((w) => w.version === 'v4');
    if (v4) {
      console.log(`\n建议配置：\n  S3_SIGN_VERSION=v4\n  S3_REGION=${v4.region}\n  S3_ADDRESSING=${v4.addressing}`);
    } else {
      console.log('\n注意：V4 未找到可用 region（若文档强制 V4，请把文档里的 region 加进 --regions 再试）');
    }
  }
  process.exit(winners.length ? 0 : 1);
})().catch((e) => {
  console.error('探测异常:', e && e.stack || e);
  process.exit(2);
});
