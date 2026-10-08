// rating_config.cjs — 房源评级口径单一数据源（规则 15）：维度键 / 中文名 / 评级编号前缀按 channel。
// app.js（B 端自评、平台复核 POST /admin/ratings/:code/review）与 vendor_api.cjs（商家开放提审
// /api/juzhu/housing/vendor/projects/rating/*）共用，勿在两侧各写一份。
'use strict';

// 维度键（权威清单）：rental=好房子 4 维，minsu=旅居彩贝 5 维
const RATING_DIMS = {
  rental: ['comfort', 'green', 'tech', 'safety'],
  minsu: ['scenery', 'facilities', 'service', 'location', 'culture'],
};

// 评级编号前缀（code = 前缀-项目id，平台复核接口按 code 尾部数字定位项目）
const RATING_CODE_PREFIX = { rental: 'SY-RENT', minsu: 'MZ' };

// 维度中文名与图标（与 p-rating-detail / b-house-rating-input / juzhu-admin 页面口径一致）
const RATING_DIM_META = {
  rental: {
    comfort: { label: '舒适', icon: '🛋' },
    green: { label: '绿色', icon: '🌿' },
    tech: { label: '智慧', icon: '📡' },
    safety: { label: '安全', icon: '🛡' },
  },
  minsu: {
    scenery: { label: '环境景观', icon: '🏞' },
    facilities: { label: '设施配套', icon: '🛁' },
    service: { label: '服务品质', icon: '🛎' },
    location: { label: '区位交通', icon: '🚗' },
    culture: { label: '在地体验', icon: '🧵' },
  },
};

/** 提审入参校验 + 收敛：dims 须覆盖该频道全部维度、数值 0-5（保留一位小数）；未知维度直接报错 */
function normalizeDimsInput(channel, raw) {
  const req = RATING_DIMS[channel];
  if (!req) throw new Error('该频道暂不支持评级（支持 rental/minsu）');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dims 须为对象，维度: ' + req.join('/'));
  }
  const out = {};
  for (const k of req) {
    const v = Number(raw[k]);
    if (raw[k] == null || raw[k] === '' || !Number.isFinite(v)) throw new Error('dims.' + k + ' 缺失或非数值（须 0-5）');
    if (v < 0 || v > 5) throw new Error('dims.' + k + ' 须在 0-5 之间');
    out[k] = Math.round(v * 10) / 10;
  }
  const unknown = Object.keys(raw).filter((k) => !req.includes(k));
  if (unknown.length) throw new Error('dims 含未知维度: ' + unknown.join(',') + '（可用: ' + req.join('/') + '）');
  return out;
}

/** 频道维度元数据（key/label/icon），随开放接口出参下发，前端不必另造映射 */
function dimsMetaOf(channel) {
  const meta = RATING_DIM_META[channel] || {};
  return (RATING_DIMS[channel] || []).map((k) => Object.assign({ key: k }, meta[k] || { label: k }));
}

module.exports = { RATING_DIMS, RATING_CODE_PREFIX, RATING_DIM_META, normalizeDimsInput, dimsMetaOf };
