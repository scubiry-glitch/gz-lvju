// vendor_config.cjs — 商家 HMAC 配置：优先 jz_vendors 表（对齐 Python jiazheng_api._load_vendor_config）
// 文件 juzhu/hmac_secret.key 已废弃，仅作首次加载时向表导入的源（表中为空才导入，不覆盖已有值）
'use strict';

const fs = require('fs');
const path = require('path');

function parseVendorConfig(text) {
  const vendors = {};
  String(text || '').split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const parts = s.split('|');
    if (parts.length < 2) return;
    const vid = parts[0].trim();
    vendors[vid] = {
      key: parts[1].trim(),
      url_link: parts[2] ? parts[2].trim() : '',
      order_detail_url: parts[3] ? parts[3].trim() : '',
    };
  });
  return vendors;
}

function loadVendorConfig(keyPath) {
  const p = keyPath || path.join(__dirname, 'juzhu', 'hmac_secret.key');
  if (!fs.existsSync(p)) return {};
  return parseVendorConfig(fs.readFileSync(p, 'utf8'));
}

// ── 表读取（进程内懒加载缓存）────────────────────────────────
// 首次查询 jz_vendors 表，之后复用缓存；改表后需重启进程生效（与 Python 侧一致）。
// 查询失败不写缓存，下次请求重试。
let _VENDOR_DB_CACHE = null;
let _VENDOR_DB_LOADING = null;

async function loadVendorConfigFromDb(getConn) {
  if (_VENDOR_DB_CACHE) return _VENDOR_DB_CACHE;
  if (_VENDOR_DB_LOADING) return _VENDOR_DB_LOADING;
  _VENDOR_DB_LOADING = (async () => {
    const conn = await getConn();
    try {
      const [rows] = await conn.execute(
        "SELECT id, hmac_key, url_link, order_detail_url, webhook_url FROM jz_vendors " +
        "WHERE hmac_key IS NOT NULL AND TRIM(hmac_key) <> ''"
      );
      const vendors = {};
      for (const r of rows) {
        vendors[String(r.id)] = {
          key: String(r.hmac_key || '').trim(),
          url_link: String(r.url_link || '').trim(),
          order_detail_url: String(r.order_detail_url || '').trim(),
          webhook_url: String(r.webhook_url || '').trim(),
        };
      }
      // 兼容迁移：hmac_secret.key 仍存在时导入（仅当表内该行 hmac_key 为空，不覆盖已有值；对齐 Python db.py）
      const fileVendors = loadVendorConfig();
      for (const [vid, v] of Object.entries(fileVendors)) {
        await conn.execute(
          "UPDATE jz_vendors SET hmac_key=?, url_link=?, order_detail_url=? " +
          "WHERE id=? AND (hmac_key IS NULL OR TRIM(hmac_key)='')",
          [v.key, v.url_link, v.order_detail_url, vid]
        );
        if (!vendors[vid]) vendors[vid] = v;
      }
      _VENDOR_DB_CACHE = vendors;
      return vendors;
    } finally {
      await conn.end();
    }
  })();
  try {
    return await _VENDOR_DB_LOADING;
  } catch (e) {
    _VENDOR_DB_LOADING = null;
    throw e;
  }
}

module.exports = { parseVendorConfig, loadVendorConfig, loadVendorConfigFromDb };
