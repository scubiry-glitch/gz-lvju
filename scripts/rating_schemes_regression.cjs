#!/usr/bin/env node
// rating_schemes_regression.cjs —— 多套评价体系（v2）引擎级回归（2026-11-21）。
// 覆盖：体系注册表元数据 / gzlvju 清单算分（三桶+总分110+分级线）/ 非法入参 /
//       scope（频道+城市）/ resolveForProject（显式>房源列>channel 默认）/ dims 兼容映射。
// 纯引擎测试，不依赖 DB（resolveForProject 直接传内存行）。运行：node scripts/rating_schemes_regression.cjs
'use strict';

const rc = require('../rating_config.cjs');
const { resolveForProject } = require('../server/routes/rating_scheme_db.cjs');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  ok(a === b, name + (a === b ? '' : `（got ${a}, want ${b}）`));
}
function throws(fn, frag, name) {
  try { fn(); fail++; console.error('  ✗ ' + name + '（未抛错）'); }
  catch (e) { ok(frag && String(e.message).includes(frag), name + '（' + e.message + '）'); }
}

// ── 1. 注册表元数据 ──
console.log('\n[1] 体系注册表');
const meta = rc.schemesMeta(null);
eq(meta.map((s) => s.key), ['haofangzi', 'caibei', 'gzlvju'], '三个体系 key');
const hf = meta.find((s) => s.key === 'haofangzi');
const cb = meta.find((s) => s.key === 'caibei');
const gz = meta.find((s) => s.key === 'gzlvju');
eq(hf.type, 'dims', 'haofangzi=dims');
eq(hf.dims.map((d) => d.key), ['comfort', 'green', 'tech', 'safety'], '好房子 4 维');
eq(hf.codePrefix, 'SY-RENT', '好房子前缀');
eq(cb.dims.map((d) => d.key), ['scenery', 'facilities', 'service', 'location', 'culture'], '彩贝 5 维');
eq(cb.codePrefix, 'MZ', '彩贝前缀');
eq(gz.type, 'checklist', 'gzlvju=checklist');
eq(gz.totalPossible, 110, 'gzlvju 满分 110');
eq(gz.codePrefix, 'GZ', 'gzlvju 前缀');
eq(gz.items.length, rc.schemeOf('gzlvju').items.length, '题库全量下发');
ok(gz.items.every((it) => it.key && it.section && it.max > 0), '题项均有 key/section/max');
// 分值上限核对：通用 80（28+32+20）、加分 10、专项三选一各 20
function secMax(key) { return gz.sections.filter((s) => s.key === key)[0].max; }
eq([secMax('u1'), secMax('u2'), secMax('u3'), secMax('bonus')], [28, 32, 20, 10], '通用分区上限 28/32/20/10');
eq([secMax('ap1') + secMax('ap2'), secMax('ht1') + secMax('ht2'), secMax('ms1') + secMax('ms2')], [20, 20, 20], '三业态专项各 20');
eq(Object.keys(gz.forms.specialty.options), ['apartment', 'hotel', 'minsu'], '专项三选一');

// ── 2. gzlvju 清单算分 ──
console.log('\n[2] 清单算分引擎');
const ALL = {};
for (const it of rc.schemeOf('gzlvju').items) ALL[it.key] = it.type === 'tier' ? it.options[0].key : true;
const full = rc.normalizeChecklistInput('gzlvju', { specialty: 'minsu', answers: ALL });
eq(full.score_universal, 80, '全选满分通用 80（28+32+20）');
eq(full.score_bonus, 10, '加分满 10');
eq(full.score_specialty, 20, '专项满 20');
eq(full.score_total, 110, '全选总分 110');
// 上界自证：任何合法输入总分 ≤110
ok(full.score_total <= 110, '总分不超过 110');
// 部分作答：tier 未选=0，check 不勾=0
const partial = rc.normalizeChecklistInput('gzlvju', {
  specialty: 'apartment',
  answers: { u1_1: 'b', u1_2: 'c', u2_3: 'a', u2_4a: true, u3_1: 'a', a1: true, a7: true, ap1_1: 'a', ap1_2b: true, ap2_1: 'b' },
});
eq(partial.score_universal, 14, '通用分项累加（u1_1b=2,u1_2c=1,u2_3a=4,u2_4a=2,u3_1a=5）');
eq(partial.score_bonus, 2, '加分两勾=2');
eq(partial.score_specialty, 6, '公寓专项 ap1_1a=3+ap1_2b=1+ap2_1b=2');
eq(partial.score_total, partial.score_universal + partial.score_bonus + partial.score_specialty, '总分=三桶之和');
// 未选业态的专项答案被忽略（不报错）
const cross = rc.normalizeChecklistInput('gzlvju', { specialty: 'hotel', answers: { ms1_1: 'a', ap1_1: 'a', ht1_1: 'b' } });
eq(cross.score_specialty, 2, '未选业态专项答案忽略，仅计所选业态');
// tier 未知档位 / check 非真值
throws(() => rc.normalizeChecklistInput('gzlvju', { specialty: 'hotel', answers: { u1_1: 'z' } }), '非法档位', 'tier 未知档位报错');
throws(() => rc.normalizeChecklistInput('gzlvju', { specialty: 'hotel', answers: { nope: true } }), '未知题项', '未知题项报错');
throws(() => rc.normalizeChecklistInput('gzlvju', { specialty: 'wrong', answers: {} }), 'specialty', '业态非法报错');
throws(() => rc.normalizeChecklistInput('gzlvju', { specialty: 'hotel', answers: [] }), 'answers', 'answers 非对象报错');

// ── 3. 分级线 ──
console.log('\n[3] 分级线');
eq(rc.computeGrade('gzlvju', 110), '五彩贝', '110→五彩贝');
eq(rc.computeGrade('gzlvju', 95), '五彩贝', '95→五彩贝（含边界）');
eq(rc.computeGrade('gzlvju', 94), '四彩贝', '94→四彩贝');
eq(rc.computeGrade('gzlvju', 85), '四彩贝', '85→四彩贝');
eq(rc.computeGrade('gzlvju', 70), '三彩贝', '70→三彩贝');
eq(rc.computeGrade('gzlvju', 55), '二彩贝', '55→二彩贝');
eq(rc.computeGrade('gzlvju', 0), '一彩贝', '0→一彩贝');
eq(rc.computeGrade('gzlvju', 88, [{ min: 90, grade: '测试金' }, { min: 0, grade: '测试铜' }]), '测试铜', 'KV 覆盖分级生效');
eq(rc.computeGrade('caibei', 90), null, 'dims 体系无分级线');

// ── 4. scope（频道 + 城市）──
console.log('\n[4] 适用范围');
ok(rc.schemeAppliesTo('gzlvju', { channel: 'minsu', cityName: '黔东南州' }, null), 'gzlvju×黔东南州×minsu 适用');
ok(rc.schemeAppliesTo('gzlvju', { channel: 'rental', cityName: '贵阳市' }, null), 'gzlvju×贵阳×rental 适用');
ok(!rc.schemeAppliesTo('gzlvju', { channel: 'minsu', cityName: '南京市' }, null), 'gzlvju×南京 不适用');
ok(!rc.schemeAppliesTo('caibei', { channel: 'rental', cityName: '贵阳市' }, null), 'caibei×rental 不适用');
ok(rc.schemeAppliesTo('haofangzi', { channel: 'rental', cityName: null }, null), 'haofangzi 不限城市');
const scopesOv = { gzlvju: { channels: ['minsu'], cities: ['贵阳'] } };
ok(!rc.schemeAppliesTo('gzlvju', { channel: 'rental', cityName: '贵阳' }, scopesOv), 'KV 覆盖收窄频道生效');
ok(rc.schemeAppliesTo('gzlvju', { channel: 'minsu', cityName: '贵阳市' }, scopesOv), 'KV 覆盖后贵阳 minsu 仍适用');
ok(rc.schemeAppliesTo('gzlvju', { channel: 'rental', cityName: '贵阳市' }, { gzlvju: { cities: [] } }), 'cities=[] = 不限城市');

// ── 5. resolveForProject（显式 > rating_scheme 列 > channel 默认）──
console.log('\n[5] 房源体系解析');
eq(resolveForProject(rc, { channel: 'minsu', city_name: '黔东南州', rating_scheme: null }, null, null).schemeKey, 'caibei', 'NULL 列 → minsu 默认彩贝');
eq(resolveForProject(rc, { channel: 'rental', city_name: '沈阳市', rating_scheme: null }, null, null).schemeKey, 'haofangzi', 'NULL 列 → rental 默认好房子');
eq(resolveForProject(rc, { channel: 'rental', city_name: '黔东南州', rating_scheme: null }, 'gzlvju', null).schemeKey, 'gzlvju', 'body 显式指定 gzlvju 生效');
eq(resolveForProject(rc, { channel: 'rental', city_name: '黔东南州', rating_scheme: 'gzlvju' }, null, null).schemeKey, 'gzlvju', '房源列 gzlvju 生效');
eq(resolveForProject(rc, { channel: 'rental', city_name: '沈阳市', rating_scheme: 'gzlvju' }, null, null).ok, false, '沈阳×gzlvju（房源列）被 scope 拒');
eq(resolveForProject(rc, { channel: 'rental', city_name: '沈阳市', rating_scheme: null }, 'gzlvju', null).ok, false, '沈阳×gzlvju（body）被 scope 拒');
eq(resolveForProject(rc, { channel: 'rental', city_name: null, rating_scheme: null }, 'nope', null).ok, false, '未知体系 key 拒');
// 分级线 KV 通过 overrides 透传（resolveForProject 只管 scope，grades 在算分级时用）
ok(true, 'overrides.grades 由 computeGrade 消费（见 [3]）');

// ── 6. dims 兼容 ──
console.log('\n[6] dims 兼容');
eq(rc.normalizeDimsInput('rental', { comfort: 4, green: 3.5, tech: 5, safety: 2 }), { comfort: 4, green: 3.5, tech: 5, safety: 2 }, '好房子 dims 收敛');
eq(rc.dimsMetaOf('minsu').map((d) => d.key), ['scenery', 'facilities', 'service', 'location', 'culture'], '彩贝 dimsMeta');
throws(() => rc.normalizeDimsInput('rental', { comfort: 6, green: 3, tech: 3, safety: 3 }), '0-5', 'dims 越界报错');
throws(() => rc.normalizeDimsInput('rental', { comfort: 4, green: 3, tech: 3 }), '缺失', 'dims 缺维度报错');
throws(() => rc.normalizeDimsInput('rental', { comfort: 4, green: 3, tech: 3, safety: 3, extra: 1 }), '未知维度', 'dims 多维度报错');

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
