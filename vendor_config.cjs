// vendor_config.cjs — 读取 juzhu/hmac_secret.key（不对外 HTTP）
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

module.exports = { parseVendorConfig, loadVendorConfig };
