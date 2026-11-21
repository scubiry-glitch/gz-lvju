#!/usr/bin/env node
// rating_flow_verify.cjs —— 多套评价体系端到端验收（2026-11-21，打 38766 验证实例）。
// 覆盖：录入选 gzlvju（scope 命中/拒绝）→ pending 锁定 → 清单提审（服务端算分）→ 平台复核
//（三桶调分+等级覆盖）→ 通过 → 存量 NULL 行不受影响 → dims 体系回归 → 清理测试数据。
// 用法：VERIFY_BASE=http://127.0.0.1:38766 VERIFY_KEY=jz-xxx node scripts/rating_flow_verify.cjs
'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.VERIFY_BASE || 'http://127.0.0.1:38766';
// 管理面已停用旧全局 API Key：用平台管理员账号登录拿 Bearer 会话（本地验证库 admin 账号）
const ADMIN_USER = process.env.VERIFY_ADMIN_USER || 'admin';
const ADMIN_PWD = process.env.VERIFY_ADMIN_PWD || (() => {
  const envLocal = fs.readFileSync(path.join(__dirname, '..', 'juzhu', '.env.local'), 'utf8');
  const m = envLocal.match(/^JUZHU_ADMIN_PASSWORD=(.+)$/m);
  return m ? m[1].trim() : '';
})();
let TOKEN = '';

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name + (extra != null ? '（' + JSON.stringify(extra).slice(0, 300) + '）' : '')); }
}
async function api(method, urlPath, body, withAuth) {
  const headers = { 'Content-Type': 'application/json' };
  if (withAuth !== false && TOKEN) headers.Authorization = 'Bearer ' + TOKEN;
  const res = await fetch(BASE + urlPath, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json };
}

async function main() {
  const login = await api('POST', '/api/juzhu/admin/auth/login', { login_name: ADMIN_USER, password: ADMIN_PWD }, false);
  if (!(login.status === 200 && login.json.token)) {
    console.error('FATAL: 管理员登录失败', login.json);
    process.exit(1);
  }
  TOKEN = login.json.token;
  console.log('登录 ok（' + ADMIN_USER + '）\n');

  console.log('\n[A] 录入时选体系（scope）');
  const bad = await api('POST', '/api/juzhu/admin/projects', {
    name: '评级验收-南京-不应创建', channel: 'minsu', city_id: 2, district_id: 52, rating_scheme: 'gzlvju',
  });
  ok(bad.status === 400, '南京×gzlvju 录入被拒 400（且不留项目）', bad);
  const badKey = await api('POST', '/api/juzhu/admin/projects', {
    name: '评级验收-未知体系', channel: 'minsu', city_id: 3, district_id: 63, rating_scheme: 'nope',
  });
  ok(badKey.status === 400, '未知体系 key 录入被拒', badKey);
  const created = await api('POST', '/api/juzhu/admin/projects', {
    name: '评级验收-贵阳清单制-' + Date.now(), channel: 'minsu', city_id: 3, district_id: 65, status: 'draft',
    rating_scheme: 'gzlvju', tags: ['评级验收'], price_from: 288,
  });
  ok(created.status === 201 && created.json.project.rating_scheme === 'gzlvju', '贵阳 minsu 录入选 gzlvju 成功', created.json);
  const pid = created.json.project.id;

  console.log('\n[B] 换体系规则（draft 随意换，含换回）');
  const toCb = await api('PUT', '/api/juzhu/admin/projects/' + pid, { rating_scheme: 'caibei' });
  ok(toCb.status === 200 && toCb.json.project.rating_scheme === 'caibei', 'draft 换 caibei（贵阳 minsu 在彩贝 scope 内）放行', toCb.json && toCb.json.error);
  const putOk = await api('PUT', '/api/juzhu/admin/projects/' + pid, { rating_scheme: 'gzlvju' });
  ok(putOk.status === 200 && putOk.json.project.rating_scheme === 'gzlvju', 'draft 换回 gzlvju 放行', putOk.json && putOk.json.error);

  console.log('\n[C] 清单提审（服务端算分）');
  // 提交部分作答：通用 u1_1=a(4) u2_3=a(4) u2_4a=1(2) u3_1=a(5)；加分 a1,a4；民宿专项 ms1_1=a(3) ms1_4=a(4) ms2_2=b(2)
  const answers = {
    u1_1: 'a', u2_3: 'a', u2_4a: true, u3_1: 'a',
    a1: true, a4: true,
    ms1_1: 'a', ms1_4: 'a', ms2_2: 'b',
    ap1_1: 'a', // 未选业态的专项答案应被忽略
  };
  const uniExpect = 4 + 4 + 2 + 5, bonusExpect = 2, specExpect = 3 + 4 + 2;
  const noSpec = await api('POST', `/api/juzhu/admin/projects/${pid}/rating/submit`, { rating_scheme: 'gzlvju', answers });
  ok(noSpec.status === 400, '缺 specialty 提审被拒', noSpec.json);
  const sub = await api('POST', `/api/juzhu/admin/projects/${pid}/rating/submit`, {
    rating_scheme: 'gzlvju', specialty: 'minsu', answers,
  });
  const r0 = sub.json && sub.json.project && typeof sub.json.project.rating === 'string'
    ? JSON.parse(sub.json.project.rating) : (sub.json.project || {}).rating;
  ok(sub.status === 200 && sub.json.rating_scheme === 'gzlvju', '清单提审成功', sub.json && sub.json.error);
  ok(r0 && r0.score_universal === uniExpect, `通用分=${uniExpect}`, r0 && r0.score_universal);
  ok(r0 && r0.score_bonus === bonusExpect, `加分=${bonusExpect}`, r0 && r0.score_bonus);
  ok(r0 && r0.score_specialty === specExpect, `专项=${specExpect}`, r0 && r0.score_specialty);
  ok(r0 && r0.score_total === uniExpect + bonusExpect + specExpect, `总分=${uniExpect + bonusExpect + specExpect}`, r0 && r0.score_total);
  const totalExpect = uniExpect + bonusExpect + specExpect;
  ok(r0 && r0.code === 'GZ-' + pid, '编号=GZ-<id>', r0 && r0.code);
  ok(r0 && r0.grade === (totalExpect >= 95 ? '五彩贝' : totalExpect >= 85 ? '四彩贝' : totalExpect >= 70 ? '三彩贝' : totalExpect >= 55 ? '二彩贝' : '一彩贝'),
    '分级线按初版规则', r0 && r0.grade);
  ok(r0 && Array.isArray(r0.answers) === false && r0.answers && r0.answers.ms1_1 === 'a' && !r0.answers.ap1_1,
    'answers 快照落库且忽略未选业态答案');

  console.log('\n[D] pending 锁定');
  const lock = await api('PUT', '/api/juzhu/admin/projects/' + pid, { rating_scheme: 'gzlvju', name: '改名' });
  ok(lock.status === 400 && /复核进行中/.test(lock.json.error || ''), 'pending 锁体系', lock.json);
  const resub = await api('POST', `/api/juzhu/admin/projects/${pid}/rating/submit`, { rating_scheme: 'gzlvju', specialty: 'minsu', answers });
  ok(resub.status === 400, 'pending 重复提审被拒', resub.status);

  console.log('\n[E] 平台复核（三桶调分 + 等级覆盖）');
  const review = await api('POST', `/api/juzhu/admin/ratings/${encodeURIComponent('GZ-' + pid)}/review`, {
    action: 'pass', note: '验收通过',
    scores: { score_universal: uniExpect + 2, score_bonus: bonusExpect, score_specialty: specExpect + 1 },
    grade: '四彩贝',
  });
  ok(review.status === 200, '复核通过成功', review.json && review.json.error);
  const r1 = review.json && review.json.project && typeof review.json.project.rating === 'string'
    ? JSON.parse(review.json.project.rating) : (review.json.project || {}).rating;
  ok(r1 && r1.score_universal === uniExpect + 2, '人工调分 通用+2 落库', r1 && r1.score_universal);
  ok(r1 && r1.score_specialty === specExpect + 1, '人工调分 专项+1 落库', r1 && r1.score_specialty);
  ok(r1 && r1.score_total === uniExpect + 2 + bonusExpect + specExpect + 1, '总分=调整后三桶之和', r1 && r1.score_total);
  ok(r1 && r1.grade === '四彩贝', '等级覆盖=四彩贝', r1 && r1.grade);
  const projRow = review.json && review.json.project;
  ok(projRow && (projRow.rating_reviewed_at || (r1 && r1.reviewed_at)), '复核时间落库（rating_reviewed_at）', projRow && projRow.rating_reviewed_at);

  console.log('\n[F] passed 换体系=作废重审');
  const chg = await api('PUT', '/api/juzhu/admin/projects/' + pid, { rating_scheme: 'gzlvju' });
  // 同体系改回自己不算「换」；真正换需另一套适用体系——贵阳 minsu 无第二套（caibei 不限城市? 检查）
  ok(chg.status === 200 || chg.status === 400, '同体系 PUT 不报错即可', chg.status);
  const cb = await api('PUT', '/api/juzhu/admin/projects/' + pid, { rating_scheme: 'caibei' });
  if (cb.status === 200) {
    const projAfter = cb.json.project;
    ok(projAfter.rating_status === 'draft', 'passed 换体系 → 状态回 draft（作废重审）', projAfter.rating_status);
    // 再走一遍 caibei dims 流验证回归
    const dimsSave = await api('PUT', '/api/juzhu/admin/projects/' + pid, {
      rating: { dims: { scenery: 4.5, facilities: 4, service: 3.5, location: 4, culture: 4 } },
    });
    ok(dimsSave.status === 200, '彩贝 dims 自评保存', dimsSave.status);
    const dimsSub = await api('POST', `/api/juzhu/admin/projects/${pid}/rating/submit`, {});
    const rd = dimsSub.json && dimsSub.json.project && typeof dimsSub.json.project.rating === 'string'
      ? JSON.parse(dimsSub.json.project.rating) : (dimsSub.json.project || {}).rating;
    ok(dimsSub.status === 200 && dimsSub.json.rating_scheme === 'caibei' && rd && rd.dims && rd.dims_meta,
      'dims 体系提审走通且快照 dims_meta', dimsSub.json && dimsSub.json.error);
    ok(rd && rd.code === 'MZ-' + pid, 'dims 编号=MZ-<id>', rd && rd.code);
    const rev2 = await api('POST', `/api/juzhu/admin/ratings/${encodeURIComponent('MZ-' + pid)}/review`, {
      action: 'pass', dims: { scenery: 4.8, facilities: 4, service: 3.5, location: 4, culture: 4 }, note: 'dims 回归',
    });
    ok(rev2.status === 200, 'dims 复核通过走通', rev2.json && rev2.json.error);
  } else {
    ok(false, 'caibei 换体系放行（期望 200）', cb.json);
  }

  console.log('\n[G] 存量 NULL 行不受影响');
  const list = await api('GET', '/api/juzhu/ratings?status=passed');
  ok(list.status === 200 && Array.isArray(list.json), 'ratings 列表 200', list.status);
  const legacy = (list.json || []).find((p) => p.rating_scheme == null);
  ok(!!legacy, '存量 NULL 行仍在列表', null);
  if (legacy) {
    const lr = typeof legacy.rating === 'string' ? JSON.parse(legacy.rating) : legacy.rating || {};
    ok(lr.code == null || /^(SY-BZF|SY-RENT|MZ)-/.test(lr.code), '存量编号前缀未被改写', lr.code);
  }
  const gzList = await api('GET', '/api/juzhu/ratings?scheme=gzlvju');
  ok(gzList.status === 200 && (gzList.json || []).every((p) => (p.rating_scheme || '') === 'gzlvju'), '?scheme=gzlvju 过滤只回 gzlvju', gzList.json && gzList.json.length);
  const badScheme = await api('GET', '/api/juzhu/ratings?scheme=nope');
  ok(badScheme.status === 400, '未知 scheme 过滤 400', badScheme.status);

  console.log('\n[H] 清理');
  const del = await api('DELETE', '/api/juzhu/admin/projects/' + pid);
  ok(del.status === 200, '测试项目删除', del.status);

  console.log(`\n===== ${pass} passed, ${fail} failed =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
