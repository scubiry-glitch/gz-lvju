import { api } from './api.js';

export const REPAIR_STATUS = {
  pending: { c: '待派单' },
  dispatched: { c: '已派单' },
  accepted: { c: '处理中' },
  serving: { c: '服务中' },
  done: { c: '待评价' },
  rated: { c: '已评价' },
};

export const BASE_TYPES = ['报修', '保洁', '管家', '送物', '家电安装', '除螨消杀', '接送', '其他'];
export const TYPE_ICONS = {
  报修: '🔧',
  保洁: '🧹',
  管家: '🛎',
  送物: '📦',
  家电安装: '🔌',
  除螨消杀: '🧴',
  接送: '🚗',
  其他: '🧰',
};
export const CUSTOM_EMOJIS = ['🧰', '🔧', '🛒', '🚗', '🧴', '🎨', '🌿', '🏊'];
const TYPE_STORE = 'BZF_LVJU_TICKET_TYPES';

export function customTypes() {
  try {
    return JSON.parse(localStorage.getItem(TYPE_STORE) || '[]');
  } catch {
    return [];
  }
}

export function saveCustomType(n, e) {
  const list = customTypes();
  if (!list.find((x) => x.n === n) && !BASE_TYPES.includes(n)) {
    list.push({ n, e });
    try {
      localStorage.setItem(TYPE_STORE, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }
}

export function iconOf(t) {
  const c = customTypes().find((x) => x.n === t);
  return (c && c.e) || TYPE_ICONS[t] || '🧰';
}

function normalize(o) {
  if (!o) return o;
  return {
    ...o,
    expectTime: o.expectTime || o.expect_time || '',
    createdLabel: o.createdLabel || String(o.created_at || '').replace('T', ' ').replace('Z', '').slice(0, 16),
    desc: o.desc || o.description || '',
  };
}

export function listRepairs(phone) {
  return api('/api/juzhu/jiazheng/repairs?phone=' + encodeURIComponent(phone || '')).then((res) =>
    (res.items || []).map(normalize),
  );
}

export function createRepair(payload) {
  return api('/api/juzhu/jiazheng/repairs', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }).then((res) => normalize(res.order));
}
