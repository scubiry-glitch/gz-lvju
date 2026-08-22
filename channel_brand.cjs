// channel_brand.cjs — 频道名称 settings.channel_name 纯函数（不连库）
'use strict';

const DEFAULT_CHANNEL_NAME = '新居住频道';
const MAX_LEN = 32;

function channelBrand(raw) {
  const name = String(raw == null ? '' : raw).trim() || DEFAULT_CHANNEL_NAME;
  const short = name.replace(/(频道|专区)$/, '') || name;
  return { name, short, zone: short + '专区' };
}

function fromSettingsMap(map) {
  return channelBrand(map && map.channel_name);
}

function parseChannelName(raw) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return { ok: false, error: '频道名称不能为空', status: 400 };
  if (name.length > MAX_LEN) return { ok: false, error: '频道名称最多 32 字', status: 400 };
  return { ok: true, name };
}

module.exports = {
  DEFAULT_CHANNEL_NAME,
  MAX_LEN,
  channelBrand,
  fromSettingsMap,
  parseChannelName,
};
