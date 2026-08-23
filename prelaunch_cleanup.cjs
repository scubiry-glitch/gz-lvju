// prelaunch_cleanup.cjs — 上线前数据清理脚本（一次性运维脚本，不入库）
//
// ⚠️ 仅限首次上线使用（2026-08 首次上线前执行一次）！
// 生产环境部署后禁止再次执行；任何人/AI 在生产环境遇到数据问题时，
// 都不得运行本脚本，应通过管理后台接口或新的针对性运维手段处理。
//
// 用途：上线前对生产库（juzhu 库）执行数据清理：
//   1. 清空 jz_products / gr_orders 测试数据（含 jz_sku_slots / jz_sku_workers 中引用产品的行）
//   2. jz_vendors 只留「来来」，删除「蓝犀牛」（含蓝犀牛名下 jz_workers）
//   3. 为来来重新生成生产环境 hmac_key（随机 64 位 hex）
//   4. 更新来来的生产环境 url_link / order_detail_url（由来来提供，见 --url-link / --order-detail-url）
//   5. 来来 city_ids 只保留沈阳
//   （原计划「cities 只保留沈阳」已取消：级联删除非沈阳城市的 units/projects/districts
//     影响面过大，cities / districts / projects / units 全部保留不动）
//
// 用法：
//   node prelaunch_cleanup.cjs                          # dry-run，仅打印计划与影响行数，不写库
//   node prelaunch_cleanup.cjs --apply                  # 真正执行
//   node prelaunch_cleanup.cjs --apply \
//        --url-link=https://prod.doorslink.net/... \
//        --order-detail-url=https://prod.doorslink.net/...
//
// 安全：
//   - 默认 dry-run；--apply 后所有 DB 变更在单事务内执行，任一失败整体回滚
//   - hmac_key 在 --apply 时随机生成（crypto.randomBytes，64 位 hex）；执行完成后必须把新密钥同步给来来
//   - juzhu/hmac_secret.key（vendor_config.cjs 读取的配置文件）在 DB 提交成功后同步：
//     文件存在则刷新 41 行、移除 42 行；文件不存在则创建并写入来来新行，保证文件与表一致
//
// 数据库配置：与 app.js getDbConfig 对齐 —— 优先 MYSQL_*，回退 JUZHU_DB_*；
// 读取根目录 .env 与 juzhu/.env（不覆盖已注入的环境变量）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mysql = require('mysql2/promise');

const ROOT = path.resolve(__dirname);
const HMAC_KEY_FILE = path.join(ROOT, 'juzhu', 'hmac_secret.key');

const CITY_KEEP = '沈阳';
const VENDOR_KEEP = '来来';
const VENDOR_DROP = '蓝犀牛';

const HELP = `⚠️ 仅限首次上线使用（2026-08 首次上线前执行一次）！
生产环境部署后禁止再次执行本脚本。

用法:
  node prelaunch_cleanup.cjs                              # dry-run：打印计划与影响行数
  node prelaunch_cleanup.cjs --apply                      # 执行清理
  node prelaunch_cleanup.cjs --apply --url-link=<url> --order-detail-url=<url>

参数:
  --apply                 真正执行（默认 dry-run，不写库）
  --url-link=URL          来来生产环境 URL Link 生成接口地址（第 4 步，缺省保留表中现值）
  --order-detail-url=URL  来来生产环境订单详情查询接口地址（第 4 步，缺省保留表中现值）
  -h, --help              显示本帮助`;

// ---------- 环境加载（对齐 app.js loadDotEnv：已有非空环境变量优先） ----------

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  let text = '';
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) { return; }
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (Object.prototype.hasOwnProperty.call(process.env, key) && process.env[key] !== '') continue;
    process.env[key] = val;
  }
}
loadDotEnv(path.join(ROOT, '.env'));
loadDotEnv(path.join(ROOT, 'juzhu', '.env'));

function getDbConfig() {
  const host = (process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST || '').trim();
  const database = (process.env.MYSQL_DB || process.env.JUZHU_DB_NAME || '').trim();
  const user = (process.env.MYSQL_USER || process.env.JUZHU_DB_USER || '').trim();
  const password = process.env.MYSQL_PASSWORD != null && process.env.MYSQL_PASSWORD !== ''
    ? process.env.MYSQL_PASSWORD
    : process.env.JUZHU_DB_PASSWORD;
  const port = parseInt(process.env.MYSQL_PORT || process.env.JUZHU_DB_PORT || '3306', 10);
  if (!host || !database || !user || password == null || password === '') {
    throw new Error('MySQL env incomplete: set MYSQL_HOST/MYSQL_PORT/MYSQL_DB/MYSQL_USER/MYSQL_PASSWORD (or JUZHU_DB_*)');
  }
  return {
    host, port, database, user, password,
    charset: 'utf8mb4', connectTimeout: 8000, decimalNumbers: true,
  };
}

function parseArgs(argv) {
  const args = { apply: false, urlLink: '', orderDetailUrl: '', help: false };
  for (const a of argv.slice(2)) {
    if (a === '--apply') args.apply = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a.startsWith('--url-link=')) args.urlLink = a.slice('--url-link='.length).trim();
    else if (a.startsWith('--order-detail-url=')) args.orderDetailUrl = a.slice('--order-detail-url='.length).trim();
    else console.warn('[warn] 忽略未知参数:', a);
  }
  for (const [label, v] of [['--url-link', args.urlLink], ['--order-detail-url', args.orderDetailUrl]]) {
    if (!v) continue;
    try { new URL(v); } catch (_) { throw new Error(`${label} 不是合法 URL: ${v}`); }
  }
  return args;
}

// ---------- 查询辅助 ----------

async function fetchCount(conn, sql, params) {
  const [rows] = await conn.execute(sql, params || []);
  return rows[0] ? rows[0].c : 0;
}

// ---------- 计划预览 ----------

async function preview(conn, args) {
  const [cities] = await conn.execute('SELECT id, name, slug FROM cities ORDER BY id');
  const [vendors] = await conn.execute(
    'SELECT id, type, name, city_ids, status, url_link, order_detail_url, CHAR_LENGTH(hmac_key) AS key_len FROM jz_vendors ORDER BY id'
  );
  const keepCity = cities.find((c) => c.name === CITY_KEEP);
  const keepVendor = vendors.find((v) => v.name === VENDOR_KEEP);
  const dropVendor = vendors.find((v) => v.name === VENDOR_DROP);
  if (!keepCity) throw new Error(`cities 表中未找到「${CITY_KEEP}」，请先核对数据库`);
  if (!keepVendor) throw new Error(`jz_vendors 表中未找到「${VENDOR_KEEP}」，请先核对数据库`);

  const stats = {
    products: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_products'),
    grOrders: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM gr_orders'),
    skuWorkers: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_sku_workers WHERE product_id IN (SELECT id FROM jz_products)'),
    skuSlots: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_sku_slots WHERE product_id IN (SELECT id FROM jz_products)'),
    dropWorkers: dropVendor
      ? await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_workers WHERE vendor_id=?', [dropVendor.id])
      : 0,
  };

  console.log('========== 上线前数据清理计划（dry-run 预览） ==========');
  console.log(`库: ${process.env.MYSQL_DB || process.env.JUZHU_DB_NAME} @ ${process.env.MYSQL_HOST || process.env.JUZHU_DB_HOST}`);
  console.log(`当前 cities: ${cities.map((c) => `${c.id}=${c.name}`).join(', ')}`);
  console.log(`当前 jz_vendors: ${vendors.map((v) => `${v.id}=${v.name}(city_ids:${v.city_ids})`).join(', ')}`);
  console.log('----------------------------------------------------------');
  console.log('[1] 清空 jz_products            -> 删除', stats.products, '行');
  console.log('    清空 gr_orders              -> 删除', stats.grOrders, '行');
  console.log('    清理 jz_sku_workers 关联行  -> 删除', stats.skuWorkers, '行');
  console.log('    清理 jz_sku_slots 关联行    -> 删除', stats.skuSlots, '行');
  console.log(`[2] jz_vendors 删除「${VENDOR_DROP}」${dropVendor ? `(id=${dropVendor.id})` : '(未找到，跳过)'}`);
  console.log(`    连带删除其 jz_workers        -> ${stats.dropWorkers} 行`);
  console.log(`[3] 「${VENDOR_KEEP}」(id=${keepVendor.id}) 重新生成 hmac_key（随机 64 位 hex）`);
  console.log(`[4] 「${VENDOR_KEEP}」更新 url_link/order_detail_url:`);
  console.log(`      url_link        = ${args.urlLink || (keepVendor.url_link || '(未配置)') + (args.urlLink ? '' : '  [未传 --url-link，保留现值]')}`);
  console.log(`      order_detail_url= ${args.orderDetailUrl || (keepVendor.order_detail_url || '(未配置)') + (args.orderDetailUrl ? '' : '  [未传 --order-detail-url，保留现值]')}`);
  console.log(`[5] 「${VENDOR_KEEP}」city_ids 更新为 '${keepCity.id}'（仅沈阳）`);
  console.log('（注：cities / districts / projects / units 全部保留，不做删除）');
  if (fs.existsSync(HMAC_KEY_FILE)) {
    console.log('[6] 同步 juzhu/hmac_secret.key：' + `刷新 ${keepVendor.id} 行（新随机密钥）、移除 ${dropVendor ? dropVendor.id : '-'} 行`);
  } else {
    console.log('[6] 生成 juzhu/hmac_secret.key：' + `写入 ${keepVendor.id} 行（新随机密钥 + url_link/order_detail_url）`);
  }
  console.log('----------------------------------------------------------');

  return { keepCity, keepVendor, dropVendor, stats };
}

// ---------- 执行 ----------

async function apply(conn, plan, args) {
  const { keepCity, keepVendor, dropVendor } = plan;
  const newKey = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString().slice(0, 19);
  // 第 4 步：缺省保留表中现值
  const urlLink = args.urlLink || keepVendor.url_link || null;
  const orderDetailUrl = args.orderDetailUrl || keepVendor.order_detail_url || null;

  await conn.beginTransaction();
  try {
    // [1] 清空家政商品与 GR 订单测试数据（先清引用产品的关联表，满足外键）
    await conn.execute('DELETE FROM jz_sku_slots WHERE product_id IN (SELECT id FROM jz_products)');
    await conn.execute('DELETE FROM jz_sku_workers WHERE product_id IN (SELECT id FROM jz_products)');
    await conn.execute('DELETE FROM jz_products');
    await conn.execute('DELETE FROM gr_orders');

    // [2] 删除蓝犀牛（先清其 workers，满足外键）
    if (dropVendor) {
      await conn.execute('DELETE FROM jz_workers WHERE vendor_id=?', [dropVendor.id]);
      await conn.execute('DELETE FROM jz_vendors WHERE id=?', [dropVendor.id]);
    }

    // [3][4][5] 来来：新密钥 + 生产地址 + city_ids 仅沈阳
    const fields = ['hmac_key=?', 'city_ids=?', 'updated_at=?'];
    const params = [newKey, String(keepCity.id), now];
    if (urlLink) { fields.push('url_link=?'); params.push(urlLink); }
    if (orderDetailUrl) { fields.push('order_detail_url=?'); params.push(orderDetailUrl); }
    params.push(keepVendor.id);
    await conn.execute(`UPDATE jz_vendors SET ${fields.join(', ')} WHERE id=?`, params);

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  return { newKey, urlLink, orderDetailUrl };
}

// ---------- hmac_secret.key 同步（vendor_config.cjs 格式: vendor_id|key|url_link|order_detail_url） ----------
// 返回 'created'（文件不存在，已创建）| 'updated'（已同步）| 'skipped'（未变更）

function syncKeyFile(plan, result) {
  const { keepVendor, dropVendor } = plan;
  if (!fs.existsSync(HMAC_KEY_FILE)) {
    // 文件不存在：创建并写入来来新行（新随机密钥 + 生产地址）
    fs.writeFileSync(
      HMAC_KEY_FILE,
      '# 商家 HMAC 配置（vendor_config.cjs 格式: vendor_id|hmac_key|url_link|order_detail_url）\n' +
      `# 由 prelaunch_cleanup.cjs 于 ${new Date().toISOString()} 生成\n` +
      [keepVendor.id, result.newKey, result.urlLink || '', result.orderDetailUrl || ''].join('|') + '\n',
      'utf8'
    );
    return 'created';
  }
  const lines = fs.readFileSync(HMAC_KEY_FILE, 'utf8').split(/\r?\n/);
  const out = [];
  let touched = false;
  for (const raw of lines) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) { out.push(raw); continue; }
    const parts = s.split('|');
    const vid = parts[0].trim();
    if (dropVendor && vid === String(dropVendor.id)) { touched = true; continue; } // 移除已删除商家
    if (vid === String(keepVendor.id)) {
      touched = true;
      out.push([keepVendor.id, result.newKey, result.urlLink || '', result.orderDetailUrl || ''].join('|'));
      continue;
    }
    out.push(raw);
  }
  fs.writeFileSync(HMAC_KEY_FILE, out.join('\n') + '\n', 'utf8');
  return touched ? 'updated' : 'skipped';
}

// ---------- 结果核验 ----------

async function verify(conn, result) {
  console.log('========== 清理结果核验 ==========');
  const [cities] = await conn.execute('SELECT id, name, slug FROM cities ORDER BY id');
  const [vendors] = await conn.execute(
    'SELECT id, type, name, city_ids, status, url_link, order_detail_url, LEFT(hmac_key, 8) AS key_head FROM jz_vendors ORDER BY id'
  );
  console.log('cities    :', cities.map((c) => `${c.id}=${c.name}`).join(', '));
  console.log('jz_vendors:', vendors.map((v) =>
    `${v.id}=${v.name}(city_ids:${v.city_ids}, key:${v.key_head}…, url_link:${v.url_link || '-'})`
  ).join(', '));
  const counts = {
    jz_products: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_products'),
    gr_orders: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM gr_orders'),
    jz_sku_workers: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_sku_workers'),
    jz_sku_slots: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_sku_slots'),
    jz_workers: await fetchCount(conn, 'SELECT COUNT(*) AS c FROM jz_workers'),
  };
  console.log('counts    :', JSON.stringify(counts));
  console.log();
  console.log('!!! 新 hmac_key（请同步给来来）:', result.newKey);
  if (!result.urlLink || !result.orderDetailUrl) {
    console.log('!!! 警告：url_link / order_detail_url 未更新为生产地址，上线前务必由来来提供后重新执行本脚本并传入对应参数');
  }
}

// ---------- 入口 ----------

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { console.log(HELP); return; }

  const conn = await mysql.createConnection(getDbConfig());
  try {
    const plan = await preview(conn, args);
    if (!args.apply) {
      console.log('当前为 dry-run，未做任何修改。确认无误后执行: node prelaunch_cleanup.cjs --apply');
      return;
    }
    const result = await apply(conn, plan, args);
    const keyFileState = syncKeyFile(plan, result);
    console.log('[ok] DB 清理完成，事务已提交');
    if (keyFileState === 'created') {
      console.log('[ok] juzhu/hmac_secret.key 已创建（含来来新随机密钥 + url_link/order_detail_url）');
    } else if (keyFileState === 'updated') {
      console.log('[ok] juzhu/hmac_secret.key 已同步（刷新来来新密钥、移除蓝犀牛）');
    } else {
      console.log('[info] juzhu/hmac_secret.key 未变更');
    }
    await verify(conn, result);
  } finally {
    await conn.end();
  }
}

main().catch((e) => {
  console.error('[error]', e.message);
  process.exit(1);
});
