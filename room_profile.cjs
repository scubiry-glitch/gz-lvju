/**
 * room_profile.cjs —— 户型「房间档案」单一数据源（units.ext.room_profile）
 *
 * 来源：商家入驻的「房源字段」表（Excel），统一塞进 units.ext，避免按住宿业态持续加列。
 * 字段清单 / 长度上限 / 枚举取值 / 中文名只写在这里：后台（juzhu-admin-unit.html 的表单、
 * app.js 的管理端校验）与商家开放接口（vendor_api.cjs 的 units/create|update）共用一份，
 * 页面与其它模块不得再抄一套。
 *
 * C 端渲染（lvju-app-detail.html 房间档案卡）对文本一律走 esc()/textContent，
 * 因此本模块只需管长度与取值合法性，不需要再做 HTML 转义。
 */
'use strict';

// 枚举字段：取值 → 中文名（顺序即表单展示顺序）
const ROOM_PROFILE_ENUMS = {
  area_type: { building: '建筑面积', usable: '使用面积' },
  window_type: { exterior: '外窗', interior: '内窗', none: '无窗' },
  smoking: { no: '全屋禁烟', designated: '仅指定区域', allowed: '可吸烟' },
};
// 枚举字段自身的名字（报错与文档共用）
const ROOM_PROFILE_ENUM_LABELS = {
  area_type: '面积口径',
  window_type: '窗户类型',
  smoking: '吸烟属性',
};

// 文本字段：key → { label 中文名, max 长度上限 }
const ROOM_PROFILE_STRINGS = {
  introduction: { label: '房源简介', max: 1000 },
  shared_spaces: { label: '共享空间', max: 300 },
  child_age_policy: { label: '儿童适住年龄', max: 300 },
  extra_guest_policy: { label: '加人 / 加床政策', max: 500 },
  beds: { label: '卧室与床位明细', max: 500 },
  bath_hot_water: { label: '洗浴与热水', max: 300 },
  kitchen: { label: '厨房可用性', max: 500 },
  climate: { label: '空调 / 暖气覆盖', max: 300 },
  network: { label: '网络', max: 200 },
  cleaning_frequency: { label: '打扫频率', max: 200 },
  linen_frequency: { label: '床品 / 毛巾更换频率', max: 200 },
  feature_image: { label: '图片地址', max: 1000 },
  feature_image_caption: { label: '图片说明', max: 120 },
};

// 数值字段：key → { label, min, max }
const ROOM_PROFILE_NUMBERS = {
  window_count: { label: '窗户数量', min: 0, max: 20 },
  max_guests: { label: '最大入住人数', min: 1, max: 99 },
  max_adults: { label: '成人上限', min: 1, max: 99 },
  max_children: { label: '儿童上限', min: 0, max: 99 },
};

// 布尔字段：key → label
const ROOM_PROFILE_BOOLS = {
  window_openable: '窗户是否可开',
};

const ROOM_PROFILE_KEYS = [].concat(
  Object.keys(ROOM_PROFILE_ENUMS),
  Object.keys(ROOM_PROFILE_STRINGS),
  Object.keys(ROOM_PROFILE_NUMBERS),
  Object.keys(ROOM_PROFILE_BOOLS),
);

/** 字段中文名（出参/文档/表单共用） */
function roomProfileLabel(key) {
  const e = ROOM_PROFILE_ENUM_LABELS[key];
  if (e) return e;
  const s = ROOM_PROFILE_STRINGS[key];
  if (s) return s.label;
  const n = ROOM_PROFILE_NUMBERS[key];
  if (n) return n.label;
  return ROOM_PROFILE_BOOLS[key] || key;
}

/** 枚举取值的中文名 */
function enumLabel(key, value) {
  const e = ROOM_PROFILE_ENUMS[key];
  return (e && e[value]) || value;
}

/**
 * 归一化 + 校验（写入口共用，非法直接抛 Error，调用方据此 400）：
 * - 只保留白名单字段；空值（null/''）跳过 → 该键不落库
 * - 文本按各自上限截断报错；feature_image 限 http(s) URL 或站内路径，禁换行与引号
 * - 枚举取值必须在表内；数值须为整数且在区间内；布尔按规整为 true/false
 * 返回 {} 表示没有任何有效字段（调用方应删除该键）。
 */
function normalizeRoomProfileInput(value) {
  if (value == null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('room_profile 须为对象');
  const out = {};
  for (const [key, def] of Object.entries(ROOM_PROFILE_STRINGS)) {
    if (!(key in value) || value[key] == null || value[key] === '') continue;
    const text = String(value[key]).trim();
    if (text.length > def.max) throw new Error(`room_profile.${key}（${def.label}）最多 ${def.max} 个字符`);
    if (!text) continue;
    if (key === 'feature_image'
      && (!/^(?:https?:\/\/|\/|assets\/|uploads\/)/i.test(text) || /[\r\n"']/.test(text))) {
      throw new Error('room_profile.feature_image（图片地址）须为有效的 http(s) URL 或站内图片路径');
    }
    out[key] = text;
  }
  for (const [key, allowed] of Object.entries(ROOM_PROFILE_ENUMS)) {
    if (!(key in value) || value[key] == null || value[key] === '') continue;
    const text = String(value[key]).trim();
    if (!Object.prototype.hasOwnProperty.call(allowed, text)) {
      throw new Error(`room_profile.${key}（${roomProfileLabel(key)}）取值无效，可选：`
        + Object.keys(allowed).join(' / '));
    }
    out[key] = text;
  }
  for (const [key, def] of Object.entries(ROOM_PROFILE_NUMBERS)) {
    if (!(key in value) || value[key] == null || value[key] === '') continue;
    const n = Number(value[key]);
    if (!Number.isInteger(n) || n < def.min || n > def.max) {
      throw new Error(`room_profile.${key}（${def.label}）须为 ${def.min}-${def.max} 的整数`);
    }
    out[key] = n;
  }
  for (const key of Object.keys(ROOM_PROFILE_BOOLS)) {
    if (!(key in value) || value[key] == null || value[key] === '') continue;
    out[key] = value[key] === true || value[key] === 1 || value[key] === '1' || value[key] === 'true';
  }
  return out;
}

/** 把 room_profile 合并进 unit 的 ext 对象（就地修改并返回 ext）：
 *  profile 为空对象 = 清除该键；非对象/未传 = 保持原值不动。 */
function mergeRoomProfileIntoExt(ext, rawProfile) {
  const out = ext && typeof ext === 'object' ? ext : {};
  if (rawProfile == null) return out;
  const profile = normalizeRoomProfileInput(rawProfile);
  if (Object.keys(profile).length) out.room_profile = profile;
  else delete out.room_profile;
  return out;
}

module.exports = {
  ROOM_PROFILE_ENUMS,
  ROOM_PROFILE_ENUM_LABELS,
  ROOM_PROFILE_STRINGS,
  ROOM_PROFILE_NUMBERS,
  ROOM_PROFILE_BOOLS,
  ROOM_PROFILE_KEYS,
  roomProfileLabel,
  enumLabel,
  normalizeRoomProfileInput,
  mergeRoomProfileIntoExt,
};
