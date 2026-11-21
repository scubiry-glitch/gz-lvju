// rating_config.cjs — 房源评级口径单一数据源（规则 15）。
// v2（2026-11-21）：从「channel 直查维度」升级为「体系注册表」——每套体系自带维度/清单题库、
// 编号前缀、适用范围（scope）；房源级 projects.rating_scheme 指向体系 key，NULL=按 channel 默认。
// app.js（B 端自评、平台复核 POST /admin/ratings/:code/review）与 vendor_api.cjs（商家开放提审
// /api/juzhu/housing/vendor/projects/rating/*）共用，勿在两侧各写一份。
'use strict';

// ───────────────────────── 旧口径（dims 型体系，兼容存量） ─────────────────────────

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

// ───────────────────────── 体系注册表（v2 新增） ─────────────────────────
// 三个 key：haofangzi（rental 频道默认）/ caibei（minsu 频道默认）/ gzlvju（贵州旅居平台体系）
// scope 默认值可被 settings KV `rating_scheme_scopes` 覆盖（后台「设置」页可改，运营调范围不改代码）。

const CHANNEL_DEFAULT_SCHEME = { rental: 'haofangzi', minsu: 'caibei' };

// 贵州体系默认适用城市（cities 表无省列，按名称前缀匹配：'黔东南州' 命中 '黔东南'）
const GUIZHOU_CITIES = ['贵阳', '遵义', '六盘水', '安顺', '毕节', '铜仁', '黔东南', '黔南', '黔西南'];

// gzlvju 分级线初版（总分→等级；settings KV `rating_gzlvju_grades` 可覆盖，后台可改）
const GZLVJU_GRADES_DEFAULT = [
  { min: 95, grade: '五彩贝' },
  { min: 85, grade: '四彩贝' },
  { min: 70, grade: '三彩贝' },
  { min: 55, grade: '二彩贝' },
  { min: 0, grade: '一彩贝' },
];

// gzlvju 清单题库（源自《旅居房源分级评分表_B1-B4》，2026-11-21 琉提供，98wiki/feishu INDEX #64）
// 题型：tier=档位单选（options 任选其一，未选=0）；check=勾选累加（true=得分）。总分服务端重算。
const GZLVJU_ITEMS = [
  // ── B.1 通用项目 · 1 区位配套（28 分）
  { key: 'u1_1', section: 'u1', type: 'tier', max: 4, label: '距离高铁站、机场等区域交通枢纽车程', options: [
    { key: 'a', label: '40分钟内', score: 4 }, { key: 'b', label: '1小时内', score: 2 }, { key: 'c', label: '2小时内', score: 1 }] },
  { key: 'u1_2', section: 'u1', type: 'tier', max: 4, label: '公共交通', options: [
    { key: 'a', label: '1公里内有公共交通站点', score: 4 }, { key: 'b', label: '2公里内有公共交通站点', score: 2 }, { key: 'c', label: '3公里内有公共交通站点', score: 1 }] },
  { key: 'u1_3', section: 'u1', type: 'tier', max: 4, label: '商业设施', options: [
    { key: 'a', label: '1公里内：有综合体、商超、农贸市场、市集、便利店、生鲜店等', score: 4 }, { key: 'b', label: '2公里内：有综合体、商超、农贸市场、市集、便利店、生鲜店等', score: 2 }, { key: 'c', label: '3公里内：有综合体、商超、农贸市场、市集、便利店、生鲜店等', score: 1 }] },
  { key: 'u1_4', section: 'u1', type: 'tier', max: 4, label: '社区卫生机构', options: [
    { key: 'a', label: '1公里内有社区卫生机构', score: 4 }, { key: 'b', label: '5公里内有社区卫生机构', score: 2 }] },
  { key: 'u1_5', section: 'u1', type: 'tier', max: 4, label: '综合医院', options: [
    { key: 'a', label: '5公里内有二级以上综合医院', score: 4 }, { key: 'b', label: '15公里内有二级以上综合医院', score: 2 }] },
  { key: 'u1_6', section: 'u1', type: 'tier', max: 4, label: '公园绿地', options: [
    { key: 'a', label: '1公里内：有公园或广场', score: 4 }, { key: 'b', label: '2公里内：有公园或广场', score: 2 }, { key: 'c', label: '3公里内：有公园或广场', score: 1 }] },
  { key: 'u1_7', section: 'u1', type: 'tier', max: 4, label: '文旅资源', options: [
    { key: 'a', label: '5公里内有旅游景区、博物馆/美术馆、康养资源（森林温泉等）等', score: 4 }, { key: 'b', label: '15公里内有旅游景区、博物馆/美术馆、康养资源（森林温泉等）等', score: 2 }, { key: 'c', label: '25公里内有旅游景区、博物馆/美术馆、康养资源（森林温泉等）等', score: 1 }] },
  // ── B.1 通用项目 · 2 房源设施品质（32 分）
  { key: 'u2_1', section: 'u2', type: 'tier', max: 4, label: '实拍数量', options: [
    { key: 'a', label: '提供覆盖全屋区域的12张及以上照片，3个月内更新', score: 4 }, { key: 'b', label: '提供覆盖全屋区域的8张及以上照片，3个月内更新', score: 2 }, { key: 'c', label: '有卧室、客厅等主要空间的实拍照片，3个月内更新', score: 1 }] },
  { key: 'u2_2', section: 'u2', type: 'tier', max: 4, label: '装修美观', options: [
    { key: 'a', label: '精装修，各功能区域装修状况良好、风格统一', score: 4 }, { key: 'b', label: '装修状况良好，主要功能区域无明显破损', score: 2 }, { key: 'c', label: '有基本装修，满足居住基本要求', score: 1 }] },
  { key: 'u2_3', section: 'u2', type: 'tier', max: 4, label: '卫生间', options: [
    { key: 'a', label: '有智能马桶', score: 4 }, { key: 'b', label: '有马桶', score: 2 }, { key: 'c', label: '有蹲厕', score: 1 }] },
  { key: 'u2_4a', section: 'u2', type: 'check', max: 2, label: '外窗有纱窗' },
  { key: 'u2_4b', section: 'u2', type: 'check', max: 2, label: '有智能门锁' },
  { key: 'u2_5a', section: 'u2', type: 'check', max: 2, label: '主要家具家电：沙发' },
  { key: 'u2_5b', section: 'u2', type: 'check', max: 2, label: '主要家具家电：窗帘' },
  { key: 'u2_5c', section: 'u2', type: 'check', max: 2, label: '主要家具家电：餐桌或书桌' },
  { key: 'u2_5d', section: 'u2', type: 'check', max: 2, label: '主要家具家电：储物柜' },
  { key: 'u2_5e', section: 'u2', type: 'check', max: 2, label: '主要家具家电：空调' },
  { key: 'u2_5f', section: 'u2', type: 'check', max: 2, label: '主要家具家电：冰箱' },
  { key: 'u2_5g', section: 'u2', type: 'check', max: 2, label: '主要家具家电：电视' },
  { key: 'u2_5h', section: 'u2', type: 'check', max: 2, label: '主要家具家电：净水器' },
  // ── B.1 通用项目 · 3 服务品质（20 分）
  { key: 'u3_1', section: 'u3', type: 'tier', max: 5, label: '响应时效', options: [
    { key: 'a', label: '配备客服人员，15分钟内响应', score: 5 }, { key: 'b', label: '配备客服人员，30分钟内响应', score: 3 }, { key: 'c', label: '配备客服人员，2小时内响应', score: 1 }] },
  { key: 'u3_2', section: 'u3', type: 'tier', max: 5, label: '履约情况', options: [
    { key: 'a', label: '30日内无商家原因取消订单', score: 5 }, { key: 'b', label: '30日内商家原因取消订单≤1件', score: 3 }] },
  { key: 'u3_3', section: 'u3', type: 'tier', max: 5, label: '客户投诉', options: [
    { key: 'a', label: '30日内投诉≤1件', score: 5 }, { key: 'b', label: '30日内投诉≤3件', score: 3 }, { key: 'c', label: '30日内投诉≤5件', score: 1 }] },
  { key: 'u3_4', section: 'u3', type: 'tier', max: 5, label: '故障频次', options: [
    { key: 'a', label: '30日内设施无故障', score: 5 }, { key: 'b', label: '30日内设施故障≤1次', score: 1 }] },
  // ── B.1 通用项目 · 4 加分项（10 分，10×check 1）
  { key: 'a1', section: 'bonus', type: 'check', max: 1, label: '为宾客购买保险服务' },
  { key: 'a2', section: 'bonus', type: 'check', max: 1, label: '无障碍设施完善，轮椅可顺畅通行' },
  { key: 'a3', section: 'bonus', type: 'check', max: 1, label: '套内配备一键报警装置' },
  { key: 'a4', section: 'bonus', type: 'check', max: 1, label: '提供旅居管家' },
  { key: 'a5', section: 'bonus', type: 'check', max: 1, label: '提供共享办公空间' },
  { key: 'a6', section: 'bonus', type: 'check', max: 1, label: '服务者经培训或认证上岗' },
  { key: 'a7', section: 'bonus', type: 'check', max: 1, label: '提供至高铁站、机场的免费接驳' },
  { key: 'a8', section: 'bonus', type: 'check', max: 1, label: '提供至主要景区的摆渡车' },
  { key: 'a9', section: 'bonus', type: 'check', max: 1, label: '提供导游服务' },
  { key: 'a10', section: 'bonus', type: 'check', max: 1, label: '提供住客交流、社群活动' },
  // ── B.2 业态专项 · 旅居公寓（20 分：房源设施 14 + 服务品质 6）
  { key: 'ap1_1', section: 'ap1', form: 'apartment', type: 'tier', max: 3, label: '居住面积', options: [
    { key: 'a', label: '按最大入住人数计算，人均居住使用面积≥35㎡（含独立卫生间、客厅、餐厅）', score: 3 }, { key: 'b', label: '按最大入住人数计算，人均居住使用面积≥30㎡', score: 2 }, { key: 'c', label: '按最大入住人数计算，人均居住使用面积≥25㎡', score: 1 }] },
  { key: 'ap1_2a', section: 'ap1', form: 'apartment', type: 'check', max: 1, label: '厨房配置：独立厨房' },
  { key: 'ap1_2b', section: 'ap1', form: 'apartment', type: 'check', max: 1, label: '厨房配置：燃气灶' },
  { key: 'ap1_2c', section: 'ap1', form: 'apartment', type: 'check', max: 1, label: '厨房配置：油烟机' },
  { key: 'ap1_2d', section: 'ap1', form: 'apartment', type: 'check', max: 1, label: '厨房配置：操作台面' },
  { key: 'ap1_2e', section: 'ap1', form: 'apartment', type: 'check', max: 1, label: '厨房配置：微波炉' },
  { key: 'ap1_3', section: 'ap1', form: 'apartment', type: 'tier', max: 3, label: '卧室美观度', options: [
    { key: 'a', label: '美观、风格统一', score: 3 }, { key: 'b', label: '整洁', score: 2 }, { key: 'c', label: '一般', score: 1 }] },
  { key: 'ap1_4', section: 'ap1', form: 'apartment', type: 'tier', max: 3, label: '起居空间采光', options: [
    { key: 'a', label: '明亮', score: 3 }, { key: 'b', label: '中等', score: 2 }, { key: 'c', label: '一般', score: 1 }] },
  { key: 'ap2_1', section: 'ap2', form: 'apartment', type: 'tier', max: 3, label: '服务管家配置', options: [
    { key: 'a', label: '至少配1名24h响应的专职管家', score: 3 }, { key: 'b', label: '配有线下专职管家', score: 2 }, { key: 'c', label: '提供线上管家服务', score: 1 }] },
  { key: 'ap2_2', section: 'ap2', form: 'apartment', type: 'tier', max: 3, label: '保洁服务', options: [
    { key: 'a', label: '提供每日免费保洁服务', score: 3 }, { key: 'b', label: '提供7天内2次免费保洁服务', score: 2 }, { key: 'c', label: '可按住客需求提供付费保洁服务', score: 1 }] },
  // ── B.3 业态专项 · 旅居酒店（20 分：房源设施 14 + 服务品质 6）
  { key: 'ht1_1', section: 'ht1', form: 'hotel', type: 'tier', max: 3, label: '客房面积与房型', options: [
    { key: 'a', label: '70%客房面积(不包括卫生间和门廊)≥36㎡', score: 3 }, { key: 'b', label: '70%客房面积(不包括卫生间和门廊)≥24㎡', score: 2 }, { key: 'c', label: '70%客房面积≥14㎡（不包括卫生间和门廊）', score: 1 }] },
  { key: 'ht1_2', section: 'ht1', form: 'hotel', type: 'tier', max: 3, label: '客房采光', options: [
    { key: 'a', label: '明亮', score: 3 }, { key: 'b', label: '中等', score: 2 }, { key: 'c', label: '较暗', score: 1 }] },
  { key: 'ht1_3a', section: 'ht1', form: 'hotel', type: 'check', max: 2, label: '客房休闲设施：套内阳台或露台' },
  { key: 'ht1_3b', section: 'ht1', form: 'hotel', type: 'check', max: 1, label: '客房休闲设施：迷你吧' },
  { key: 'ht1_4a', section: 'ht1', form: 'hotel', type: 'check', max: 2, label: '文体活动场所：健身房' },
  { key: 'ht1_4b', section: 'ht1', form: 'hotel', type: 'check', max: 2, label: '文体活动场所：游泳池' },
  { key: 'ht1_4c', section: 'ht1', form: 'hotel', type: 'check', max: 1, label: '文体活动场所：咖啡厅' },
  { key: 'ht2_1', section: 'ht2', form: 'hotel', type: 'tier', max: 3, label: '前台与管家服务', options: [
    { key: 'a', label: '有24h前台及客房服务，为长住15天以上的客人配专属管家', score: 3 }, { key: 'b', label: '有24h前台及客房服务', score: 2 }, { key: 'c', label: '有24h值班人员', score: 1 }] },
  { key: 'ht2_2', section: 'ht2', form: 'hotel', type: 'tier', max: 3, label: '餐饮服务', options: [
    { key: 'a', label: '有餐厅，可提供早、中、晚餐', score: 3 }, { key: 'b', label: '提供外卖送餐到客房服务', score: 1 }] },
  // ── B.4 业态专项 · 旅居民宿（20 分：房源设施 14 + 服务品质 6）
  { key: 'ms1_1', section: 'ms1', form: 'minsu', type: 'tier', max: 3, label: '客房面积', options: [
    { key: 'a', label: '客房面积≥50㎡（不含卫生间）', score: 3 }, { key: 'b', label: '客房面积≥30㎡（不含卫生间）', score: 2 }, { key: 'c', label: '客房面积≥25㎡（不含卫生间）', score: 1 }] },
  { key: 'ms1_2', section: 'ms1', form: 'minsu', type: 'tier', max: 3, label: '景观与山地特色', options: [
    { key: 'a', label: '建筑外观、园林展示梯田峡谷等山地特色，50%以上外窗具有景观视野', score: 3 }, { key: 'b', label: '建筑环境体现山地特色，有室外景观', score: 2 }, { key: 'c', label: '建筑或室外环境能体现山地特色', score: 1 }] },
  { key: 'ms1_3a', section: 'ms1', form: 'minsu', type: 'check', max: 1, label: '房源设施：有独立厨房' },
  { key: 'ms1_3b', section: 'ms1', form: 'minsu', type: 'check', max: 1, label: '房源设施：有1层室外院落或顶层露台' },
  { key: 'ms1_3c', section: 'ms1', form: 'minsu', type: 'check', max: 1, label: '房源设施：配备洗衣机' },
  { key: 'ms1_3d', section: 'ms1', form: 'minsu', type: 'check', max: 1, label: '房源设施：配备烘干机' },
  { key: 'ms1_4', section: 'ms1', form: 'minsu', type: 'tier', max: 4, label: '起居空间采光', options: [
    { key: 'a', label: '明亮', score: 4 }, { key: 'b', label: '中等', score: 2 }, { key: 'c', label: '较暗', score: 1 }] },
  { key: 'ms2_1a', section: 'ms2', form: 'minsu', type: 'check', max: 1, label: '特色活动：有采摘、垂钓、加工等特色餐饮活动' },
  { key: 'ms2_1b', section: 'ms2', form: 'minsu', type: 'check', max: 1, label: '特色活动：有自然徒步活动' },
  { key: 'ms2_1c', section: 'ms2', form: 'minsu', type: 'check', max: 1, label: '特色活动：有手工体验活动' },
  { key: 'ms2_2', section: 'ms2', form: 'minsu', type: 'tier', max: 3, label: '管家/接待服务', options: [
    { key: 'a', label: '配专属管家或驻店接待，提供入住引导与全程响应', score: 3 }, { key: 'b', label: '有固定联系人，可远程响应住客需求', score: 2 }, { key: 'c', label: '仅提供入住联系方式', score: 1 }] },
];

const GZLVJU_SECTIONS = [
  { key: 'u1', label: '区位配套', max: 28 },
  { key: 'u2', label: '房源设施品质', max: 32 },
  { key: 'u3', label: '服务品质', max: 20 },
  { key: 'bonus', label: '加分项', max: 10 },
  { key: 'ap1', label: '房源设施（公寓）', max: 14, form: 'apartment' },
  { key: 'ap2', label: '服务品质（公寓）', max: 6, form: 'apartment' },
  { key: 'ht1', label: '房源设施（酒店）', max: 14, form: 'hotel' },
  { key: 'ht2', label: '服务品质（酒店）', max: 6, form: 'hotel' },
  { key: 'ms1', label: '房源设施（民宿）', max: 14, form: 'minsu' },
  { key: 'ms2', label: '服务品质（民宿）', max: 6, form: 'minsu' },
];

const RATING_SCHEMES = {
  haofangzi: {
    key: 'haofangzi', name: '好房子评级', codePrefix: 'SY-RENT', type: 'dims',
    channels: ['rental'], dims: RATING_DIMS.rental, dimMeta: RATING_DIM_META.rental,
    gradeLabel: '星级',
  },
  caibei: {
    key: 'caibei', name: '旅居彩贝', codePrefix: 'MZ', type: 'dims',
    channels: ['minsu'], dims: RATING_DIMS.minsu, dimMeta: RATING_DIM_META.minsu,
    gradeLabel: '彩贝级',
  },
  gzlvju: {
    key: 'gzlvju', name: '贵州旅居平台体系', codePrefix: 'GZ', type: 'checklist',
    channels: ['rental', 'minsu'], cities: GUIZHOU_CITIES, totalPossible: 110,
    items: GZLVJU_ITEMS, sections: GZLVJU_SECTIONS, grades: GZLVJU_GRADES_DEFAULT,
    forms: {
      universal: { label: '通用项目（B.1）', max: 80, sections: ['u1', 'u2', 'u3', 'bonus'] },
      specialty: {
        label: '业态专项（B.2/B.3/B.4 三选一）', max: 20, required: true,
        options: { apartment: 'B.2 旅居公寓', hotel: 'B.3 旅居酒店', minsu: 'B.4 旅居民宿' },
      },
    },
    standardUrl: '/lvju-rating-standard.html',
  },
};

// scope 覆盖（settings KV `rating_scheme_scopes`）：{ gzlvju: { channels: [...], cities: [...] } }
function scopeOf(schemeKey, scopesOverride) {
  const sch = RATING_SCHEMES[schemeKey];
  if (!sch) return null;
  const ov = scopesOverride && scopesOverride[schemeKey];
  return {
    channels: (ov && Array.isArray(ov.channels) ? ov.channels : sch.channels) || [],
    cities: (ov && Array.isArray(ov.cities) ? ov.cities : sch.cities) || null, // null=不限城市
  };
}

/** 体系是否适用该房源：channel 必命中；cities 非空时城市名须命中（双向前缀匹配，兼容「黔东南」vs「黔东南州」） */
function schemeAppliesTo(schemeKey, ctx, scopesOverride) {
  const scope = scopeOf(schemeKey, scopesOverride);
  if (!scope) return false;
  if (!ctx || !scope.channels.includes(ctx.channel)) return false;
  if (scope.cities && scope.cities.length && ctx.cityName) {
    const hit = scope.cities.some((c) => ctx.cityName.startsWith(c) || c.startsWith(ctx.cityName));
    if (!hit) return false;
  }
  return true;
}

/** 房源生效体系：显式 rating_scheme 优先，NULL=channel 默认 */
function resolveSchemeKey(ratingScheme, channel) {
  if (ratingScheme && RATING_SCHEMES[ratingScheme]) return ratingScheme;
  return CHANNEL_DEFAULT_SCHEME[channel] || null;
}

function schemeOf(schemeKey) { return RATING_SCHEMES[schemeKey] || null; }

/** 体系编号前缀（code = 前缀-项目id）；存量 channel 直查口径兜底 */
function codePrefixOf(schemeKey, channel) {
  const sch = schemeOf(schemeKey);
  if (sch) return sch.codePrefix;
  return RATING_CODE_PREFIX[channel] || 'SY';
}

/** 下发给前端/开放接口的体系元数据（题库全量带出，页面按 form 渲染） */
function schemesMeta(scopesOverride) {
  return Object.values(RATING_SCHEMES).map((s) => {
    const base = {
      key: s.key, name: s.name, codePrefix: s.codePrefix, type: s.type,
      channels: s.channels, scope: scopeOf(s.key, scopesOverride),
      gradeLabel: s.gradeLabel || null, standardUrl: s.standardUrl || null,
    };
    if (s.type === 'dims') {
      base.dims = s.dims.map((k) => Object.assign({ key: k }, s.dimMeta[k] || { label: k }));
    } else {
      base.totalPossible = s.totalPossible;
      base.forms = s.forms;
      base.sections = s.sections;
      base.items = s.items.map((it) => ({
        key: it.key, section: it.section, form: it.form || null, type: it.type,
        max: it.max, label: it.label,
        options: it.options ? it.options.map((o) => ({ key: o.key, label: o.label, score: o.score })) : null,
      }));
      base.grades = s.grades;
    }
    return base;
  });
}

function schemeMetaForClient(schemeKey, scopesOverride) {
  const found = schemesMeta(scopesOverride).find((m) => m.key === schemeKey);
  return found || null;
}

/** 总分→等级（grades 为 [{min,grade}] 降序；override 由调用方从 settings KV 传入） */
function computeGrade(schemeKey, total, gradesOverride) {
  const sch = schemeOf(schemeKey);
  if (!sch || sch.type !== 'checklist') return null;
  const grades = Array.isArray(gradesOverride) && gradesOverride.length ? gradesOverride : sch.grades;
  const sorted = grades.slice().sort((a, b) => b.min - a.min);
  for (const g of sorted) {
    if (total >= Number(g.min)) return String(g.grade);
  }
  return sorted.length ? String(sorted[sorted.length - 1].grade) : null;
}

/**
 * gzlvju 清单入参校验 + 服务端算分（不信任客户端合计）。
 * body: { specialty: 'apartment'|'hotel'|'minsu', answers: { itemKey: optionKey|true|false } }
 * 返回: { specialty, answers, score_universal, score_bonus, score_specialty, score_total }
 */
function normalizeChecklistInput(schemeKey, body) {
  const sch = schemeOf(schemeKey);
  if (!sch || sch.type !== 'checklist') throw new Error('该体系不支持清单式打分');
  if (!body || typeof body !== 'object') throw new Error('body 须为对象');
  const forms = sch.forms;
  const specialty = body.specialty;
  if (!specialty || !forms.specialty.options[specialty]) {
    throw new Error('specialty 缺失或非法（可选: ' + Object.keys(forms.specialty.options).join('/') + '）');
  }
  const raw = body.answers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('answers 须为对象');

  const byKey = {};
  for (const it of sch.items) byKey[it.key] = it;
  const answers = {};
  let scoreUniversal = 0, scoreBonus = 0, scoreSpecialty = 0;

  for (const [key, val] of Object.entries(raw)) {
    const it = byKey[key];
    if (!it) throw new Error('answers 含未知题项: ' + key);
    if (it.form && it.form !== specialty) continue; // 未选业态的专项答案忽略
    if (it.type === 'tier') {
      if (val == null || val === '' || val === false) continue; // 未选=0
      const opt = (it.options || []).find((o) => o.key === val);
      if (!opt) throw new Error('answers.' + key + ' 非法档位: ' + val);
      answers[key] = opt.key;
      const bucket = it.section === 'bonus' ? () => scoreBonus += opt.score : it.form ? () => scoreSpecialty += opt.score : () => scoreUniversal += opt.score;
      bucket();
    } else { // check
      const on = val === true || val === 1 || val === '1' || val === 'true';
      if (!on) continue;
      answers[key] = true;
      const bucket = it.section === 'bonus' ? () => scoreBonus += it.max : it.form ? () => scoreSpecialty += it.max : () => scoreUniversal += it.max;
      bucket();
    }
  }

  const scoreTotal = scoreUniversal + scoreBonus + scoreSpecialty;
  return {
    specialty,
    answers,
    score_universal: scoreUniversal,
    score_bonus: scoreBonus,
    score_specialty: scoreSpecialty,
    score_total: scoreTotal,
  };
}

/** 清单题库元数据（复核详情/自评页渲染用） */
function checklistMetaOf(schemeKey) {
  const sch = schemeOf(schemeKey);
  if (!sch || sch.type !== 'checklist') return null;
  return { sections: sch.sections, items: sch.items, forms: sch.forms, grades: sch.grades, totalPossible: sch.totalPossible };
}

module.exports = {
  // 旧口径（兼容存量调用方）
  RATING_DIMS, RATING_CODE_PREFIX, RATING_DIM_META, normalizeDimsInput, dimsMetaOf,
  // v2 体系注册表
  RATING_SCHEMES, CHANNEL_DEFAULT_SCHEME, GUIZHOU_CITIES, GZLVJU_GRADES_DEFAULT,
  scopeOf, schemeAppliesTo, resolveSchemeKey, schemeOf, codePrefixOf,
  schemesMeta, schemeMetaForClient, computeGrade, normalizeChecklistInput, checklistMetaOf,
};
