#!/usr/bin/env node
/**
 * 本地一键验证：管理端创建房源 → 外链封面 → S3 链接
 * ---------------------------------------------------------------------------
 * 用法（先确保本地服务已启动，默认 8766）：
 *   node --env-file=.env.dev scripts/local_verify_s3_cover.cjs
 *   node --env-file=.env.dev scripts/local_verify_s3_cover.cjs --base=http://127.0.0.1:8766 --password=mysecret123
 *   # 保留测试房源（不自动删）：--keep
 *
 * 步骤：
 *   1) 确认/创建本地专用验证账号 local_s3（platform_admin 角色；幂等，不影响 admin）
 *   2) 登录拿 token
 *   3) POST /api/juzhu/admin/projects（cover_image = 百度外链）→ 断言 cover_image_storage
 *   4) 直查数据库确认真实入库值
 *   5) 默认删除测试房源清理现场
 */
'use strict';
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argVal = (k, d) => {
  const hit = args.find((a) => a.startsWith('--' + k + '='));
  return hit ? hit.slice(k.length + 3) : d;
};
const BASE = argVal('base', 'http://127.0.0.1:8766').replace(/\/$/, '');
const KEEP = args.includes('--keep');
const LOGIN = 'local_s3';
const PASSWORD = argVal('password', 's3-local-' + crypto.randomBytes(4).toString('hex'));

const BAIDU_COVER = 'https://gips2.baidu.com/it/u=195724436,3554684702&fm=3028&app=3028&f=JPEG&fmt=auto?w=1280&h=960';

(async () => {
  // ── 0. 服务健康检查 ──
  try {
    await fetch(BASE + '/api/juzhu/img?p=/assets/x.jpg', { signal: AbortSignal.timeout(8000) });
  } catch (e) {
    console.error('✘ 服务不可达 ' + BASE + '（先启动：PORT=8766 node --env-file=.env.dev app.js）');
    process.exit(1);
  }
  console.log('▶ 目标服务:', BASE);

  // ── 1. 注入 auth_center（与 app.js 同款 di）──
  const { getDbConfig, queryRows, getPool, withDbRetry } = require(path.join(ROOT, 'server/db.cjs'));
  const authCenter = require(path.join(ROOT, 'auth_center.cjs'));
  authCenter.init({
    query: (sql, params) => queryRows(sql, params),
    exec: (sql, params) => withDbRetry(async () => { const [r] = await getPool().execute(sql, params || []); return r; }),
    jsonReply: () => {},
    expectedApiKey: () => '',
    expectedAdminPassword: () => '',
    isProduction: () => false,
  });

  // ── 2. 确认/创建本地验证账号（幂等；不动 admin）──
  let acc = (await queryRows('SELECT id FROM accounts WHERE login_name=? LIMIT 1', [LOGIN]))[0];
  if (!acc) {
    const out = await authCenter.createAccount({
      login_name: LOGIN, password: PASSWORD, display_name: '本地S3封面验证',
      roles: ['platform_admin'], principal_type: 'user',
    });
    if (out.error) { console.error('✘ 创建验证账号失败:', out.error); process.exit(1); }
    acc = out.account;
    console.log('✔ 已创建验证账号 ' + LOGIN + '（密码: ' + PASSWORD + '，platform_admin 角色，仅本地联调用）');
  } else {
    // 已存在 → 重置密码为本次值，保证脚本可重复运行（专用验证账号，无副作用）
    const reset = await authCenter.updateAccount(acc.id, { password: PASSWORD }, {});
    if (reset && reset.error) { console.error('✘ 重置验证账号密码失败:', reset.error); process.exit(1); }
    console.log('• 验证账号 ' + LOGIN + ' 已存在，密码已重置为本次值');
  }

  // ── 3. 登录 ──
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_name: LOGIN, password: PASSWORD }),
  }).then((r) => r.json());
  if (!login.token) { console.error('✘ 登录失败:', JSON.stringify(login)); console.error('  提示：账号已存在时需用建号时的密码，或先 DELETE FROM accounts WHERE login_name=\'local_s3\' 再跑本脚本'); process.exit(1); }
  console.log('✔ 登录成功 token 已获取');

  // ── 4. 创建房源（外链封面）──
  const cityRow = (await queryRows('SELECT id FROM cities ORDER BY id LIMIT 1'))[0];
  if (!cityRow) { console.error('✘ cities 表为空，先跑种子'); process.exit(1); }
  let districtId = null;
  const dCity = await queryRows('SELECT id FROM districts WHERE city_id=? ORDER BY id LIMIT 1', [cityRow.id]);
  if (dCity.length) districtId = dCity[0].id;
  else {
    const dAny = await queryRows('SELECT id FROM districts ORDER BY id LIMIT 1');
    if (!dAny.length) { console.error('✘ districts 表为空（房源项目须选择行政区），先跑行政区种子'); process.exit(1); }
    districtId = dAny[0].id;
  }
  const name = 'S3验证房源-' + new Date().toISOString().slice(11, 19);
  const t0 = Date.now();
  const created = await fetch(BASE + '/api/juzhu/admin/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token },
    body: JSON.stringify({ name, channel: 'rental', city_id: cityRow.id, district_id: districtId, cover_image: BAIDU_COVER }),
  }).then((r) => r.json());
  if (!created.ok) { console.error('✘ 创建失败:', JSON.stringify(created).slice(0, 400)); process.exit(1); }

  const p = created.project;
  console.log('');
  console.log('=== 创建结果（' + (Date.now() - t0) + 'ms）===');
  console.log('project.id          =', p.id);
  console.log('cover_image(响应)   =', p.cover_image);
  console.log('cover_image_storage =', created.cover_image_storage);
  console.log('cover_mirrored      =', created.cover_mirrored);
  console.log('cover_warned        =', created.cover_warned || '(无)');

  // ── 5. 直查库确认 ──
  const row = (await queryRows('SELECT cover_image FROM projects WHERE id=?', [p.id]))[0];
  console.log('cover_image(库)     =', row && row.cover_image);

  const isS3 = !!(p.cover_image && /^https:\/\/file\.ljcdn\.com\//.test(p.cover_image));
  console.log('');
  console.log(isS3
    ? '✔ 验证通过：外链封面已转为 S3 链接并入库'
    : '✘ 未转为 S3：看 cover_warned 提示（未部署新代码 / IMG_INGEST≠mirror / 链路异常）');

  // ── 6. 清理 ──
  if (!KEEP) {
    const del = await fetch(BASE + '/api/juzhu/admin/projects/' + p.id, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + login.token },
    }).then((r) => r.json()).catch(() => ({}));
    console.log('• 测试房源清理:', del && del.ok ? '已删除 #' + p.id : '删除失败（可手工删）');
  } else {
    console.log('• 测试房源保留 #' + p.id + '（--keep）');
  }
  process.exit(isS3 ? 0 : 1);
})().catch((e) => { console.error('✘ 异常:', (e && e.stack) || e); process.exit(1); });
