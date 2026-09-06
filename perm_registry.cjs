/**
 * perm_registry.cjs —— 权限点注册表（单一数据源，docs/account-and-auth-design.md §3.3/§3.4 的落地层）
 *
 * 职责：
 *  1. PERMS   权限点目录：code/中文名/资源域/动作/建议角色。auth_center.cjs 的内置角色
 *             permissions 由此折叠（roleDefaults），不再手写两份。
 *  2. ROUTES  admin 域路由 → 权限点 + 细粒度审计 action 映射。app.js 入口闸据此校验与审计，
 *             替代旧"非 GET 一刀切 admin.write + 一条 admin.write 审计"。
 *  3. 兼容    admin.write 保留定义与既有角色归属，但不再作为任何路由的闸；过渡期
 *             （settings.perm_strict != '1'）requirePerm 额外接受 admin.write（app.js 侧实现），
 *             B7 翻 strict 后写权限按本表收口。
 *
 * 约定：
 *  - 既有已在校验的 code 一律不改名（order.dispatch / worker.manage / vendor.* ...）。
 *  - roles:[] = 已定义未授予（当前仅 platform_admin 的 '*' 隐含全权）；通过 roles CRUD
 *    （B5）或 scripts/perm_roles_resync.cjs 显式授予。
 *  - account.manage 为「机构自助开号」预留点：本轮不接任何路由（试点期平台代开）。
 *  - 折叠结果受 scripts/perm_registry_snapshot.cjs 基线快照约束，改角色权限面必须先改基线。
 */
'use strict';

const PERMS = [
  // ── 平台/基础字典 ──
  { code: 'admin.read',    name: '管理域只读',     domain: 'platform', action: 'read',   desc: 'admin 域业务只读（字典/城市/项目/设置）', roles: ['platform_op', 'operator_admin', 'operator_dispatcher'] },
  { code: 'admin.write',   name: '管理域写（旧）', domain: 'platform', action: 'write',  desc: '旧一刀切写权限点；已不作为路由闸，仅过渡期别名', roles: ['platform_op'] },
  { code: 'settings.write', name: '平台参数配置',  domain: 'platform', action: 'write',  desc: '全局设置/频道品牌名/预订电话', roles: [] },
  { code: 'dict.write',    name: '基础字典维护',   domain: 'platform', action: 'write',  desc: '城市/行政区/频道', roles: [] },
  // ── 房源与评级 ──
  { code: 'house.write',   name: '房源与评级录入', domain: 'housing',  action: 'write',  desc: '项目/户型/图片/上下架/评级提交', roles: ['operator_admin'] },
  { code: 'rating.review', name: '评级复核',       domain: 'rating',   action: 'review', desc: '好房子/旅居评级审定 pass/reject', roles: ['platform_op'] },
  { code: 'rating.write',  name: '评价提交',       domain: 'rating',   action: 'write',  desc: 'C 端工单评价/商家评级自报', roles: ['user'] },
  // ── 机构与运营 ──
  { code: 'org.read',      name: '机构信息只读',   domain: 'org',      action: 'read',   desc: '主体机构信息读取', roles: ['holding_viewer', 'operator_admin', 'operator_dispatcher', 'operator_housekeeper'] },
  { code: 'org.write',     name: '机构信息维护',   domain: 'org',      action: 'write',  desc: '主体机构信息维护', roles: ['operator_admin'] },
  { code: 'sla.read',      name: '运营商 SLA 只读', domain: 'org',     action: 'read',   desc: '运营商 SLA/绩效（资管口径，规则 4 只读）', roles: ['holding_viewer'] },
  { code: 'worker.manage', name: '花名册维护',     domain: 'org',      action: 'write',  desc: '运营商员工花名册增删改', roles: ['operator_admin'] },
  { code: 'order.dispatch', name: '派单/改派',     domain: 'order',    action: 'write',  desc: '工单派单与推进', roles: ['operator_admin', 'operator_dispatcher'] },
  { code: 'order.self',    name: '本人工单',       domain: 'order',    action: 'read',   desc: '服务者/管家本人名下工单', roles: ['operator_housekeeper', 'worker'] },
  { code: 'order.create',  name: '下单',           domain: 'order',    action: 'write',  desc: 'C 端提交家政/生活服务订单', roles: ['user'] },
  { code: 'income.self',   name: '本人收入',       domain: 'fund',     action: 'read',   desc: '服务者本人收入/对账', roles: ['worker'] },
  // ── 监管/金融只读（规则 4：出规则不出运营）──
  { code: 'report.read',   name: '资管/监管报表',  domain: 'report',   action: 'read',   desc: 'org/report 聚合报表（按 scope 过滤）', roles: ['holding_viewer', 'gov_viewer', 'bank_viewer'] },
  { code: 'report.export', name: '数据导出',       domain: 'report',   action: 'export', desc: '管理域数据导出', roles: [] },
  { code: 'complaint.read', name: '投诉只读',      domain: 'report',   action: 'read',   desc: '投诉与工单监管视角', roles: ['gov_viewer'] },
  { code: 'compliance.read', name: '合规只读',     domain: 'report',   action: 'read',   desc: '合规指标读取', roles: ['gov_viewer'] },
  { code: 'fund.read',     name: '资金只读',       domain: 'fund',     action: 'read',   desc: '监管账户/资金流（限本行口径）', roles: ['bank_viewer'] },
  // ── IAM（账号与权限中心）──
  { code: 'iam.read',      name: '账号与身份只读', domain: 'iam',      action: 'read',   desc: '账号/角色/会话/审计面读取', roles: [] },
  { code: 'iam.write',     name: '账号与身份维护', domain: 'iam',      action: 'write',  desc: '开号/改角色/重置密码/启停/强制下线', roles: [] },
  { code: 'iam.key.write', name: '机器密钥签发',   domain: 'iam',      action: 'write',  desc: '签发 per-account API Key（高危单列）', roles: [] },
  { code: 'role.write',    name: '角色与权限矩阵维护', domain: 'iam',  action: 'write',  desc: '角色 CRUD 与权限点授予', roles: [] },
  { code: 'account.manage', name: '机构自助开号',  domain: 'iam',      action: 'write',  desc: '【预留·未接路由】试点期由平台代开（设计文档待拍板#3）', roles: [] },
  { code: 'audit.read',    name: '审计查询',       domain: 'audit',    action: 'read',   desc: 'audit_log 查询', roles: ['platform_op'] },
  // ── 商家（vendor）域：既有校验点，code 不动 ──
  { code: 'vendor.summary.read',  name: '商家概览只读', domain: 'vendor', action: 'read',  desc: '商家后台概览', roles: ['vendor_owner', 'vendor_operator'] },
  { code: 'vendor.order.read',    name: '商家订单只读', domain: 'vendor', action: 'read',  desc: '商家订单列表/详情', roles: ['vendor_owner', 'vendor_operator'] },
  { code: 'vendor.order.write',   name: '商家订单处理', domain: 'vendor', action: 'write', desc: '接单/改派/完工', roles: ['vendor_owner', 'vendor_operator'] },
  { code: 'vendor.product.read',  name: '商家商品只读', domain: 'vendor', action: 'read',  desc: '商品/SKU 读取', roles: ['vendor_owner'] },
  { code: 'vendor.product.write', name: '商家商品维护', domain: 'vendor', action: 'write', desc: '商品/SKU 增删改', roles: ['vendor_owner'] },
  { code: 'vendor.worker.read',   name: '商家服务者只读', domain: 'vendor', action: 'read', desc: '花名册读取', roles: ['vendor_owner'] },
  { code: 'vendor.fund.read',     name: '商家资金只读', domain: 'vendor', action: 'read',  desc: '商家对账/佣金', roles: ['vendor_owner'] },
];

/**
 * admin 域路由 → 权限点。app.js 入口闸的唯一依据。
 * re 均锚定 ^...$（不得误伤共用 handler 的非 admin 路径，如公开的 /api/juzhu/settings）。
 * act = 审计 action（替代粗粒度 admin.write）；res = 审计资源；idGroup = re 中资源 id 的捕获组。
 * guard = 特殊闸（app.js 内实现），exempt = 完全免闸。
 */
const ROUTES = [
  // 平台参数 / 字典
  { method: 'PUT',    re: '^/api/juzhu/admin/settings$', perm: 'settings.write', act: 'settings.update', res: 'settings' },
  { method: 'POST',   re: '^/api/juzhu/admin/cities$', perm: 'dict.write', act: 'city.create', res: 'cities' },
  { method: 'PUT',    re: '^/api/juzhu/admin/cities/(\\d+)$', perm: 'dict.write', act: 'city.update', res: 'cities', idGroup: 1 },
  { method: 'DELETE', re: '^/api/juzhu/admin/cities/(\\d+)$', perm: 'dict.write', act: 'city.delete', res: 'cities', idGroup: 1 },
  { method: 'PUT',    re: '^/api/juzhu/admin/city$', perm: 'dict.write', act: 'city.update', res: 'cities' },
  { method: 'PUT',    re: '^/api/juzhu/admin/channels/([^/]+)$', perm: 'dict.write', act: 'channel.update', res: 'channels', idGroup: 1 },
  { method: 'POST',   re: '^/api/juzhu/admin/districts$', perm: 'dict.write', act: 'district.create', res: 'districts' },
  { method: 'PUT',    re: '^/api/juzhu/admin/districts/(\\d+)$', perm: 'dict.write', act: 'district.update', res: 'districts', idGroup: 1 },
  { method: 'DELETE', re: '^/api/juzhu/admin/districts/(\\d+)$', perm: 'dict.write', act: 'district.delete', res: 'districts', idGroup: 1 },
  // 房源 / 户型 / 图片
  { method: 'POST',   re: '^/api/juzhu/admin/projects$', perm: 'house.write', act: 'project.create', res: 'projects' },
  { method: 'PUT',    re: '^/api/juzhu/admin/projects/(\\d+)$', perm: 'house.write', act: 'project.update', res: 'projects', idGroup: 1 },
  { method: 'DELETE', re: '^/api/juzhu/admin/projects/(\\d+)$', perm: 'house.write', act: 'project.delete', res: 'projects', idGroup: 1 },
  { method: 'POST',   re: '^/api/juzhu/admin/projects/(\\d+)/units$', perm: 'house.write', act: 'unit.create', res: 'units', idGroup: 1 },
  { method: 'PUT',    re: '^/api/juzhu/admin/units/(\\d+)$', perm: 'house.write', act: 'unit.update', res: 'units', idGroup: 1 },
  { method: 'DELETE', re: '^/api/juzhu/admin/units/(\\d+)$', perm: 'house.write', act: 'unit.delete', res: 'units', idGroup: 1 },
  { method: 'POST',   re: '^/api/juzhu/admin/units/(\\d+)/photos$', perm: 'house.write', act: 'unit.photo.add', res: 'photos', idGroup: 1 },
  { method: 'PUT',    re: '^/api/juzhu/admin/photos/(\\d+)$', perm: 'house.write', act: 'photo.update', res: 'photos', idGroup: 1 },
  { method: 'DELETE', re: '^/api/juzhu/admin/photos/(\\d+)$', perm: 'house.write', act: 'photo.delete', res: 'photos', idGroup: 1 },
  { method: 'POST',   re: '^/api/juzhu/admin/upload$', perm: 'house.write', act: 'upload', res: 'photos' },
  // 导出
  { method: 'POST',   re: '^/api/juzhu/admin/export$', perm: 'report.export', act: 'export.run', res: 'export' },
  // IAM
  { method: 'POST',   re: '^/api/juzhu/admin/accounts$', perm: 'iam.write', act: 'account.create', res: 'account' },
  { method: 'PUT',    re: '^/api/juzhu/admin/accounts/(\\d+)$', perm: 'iam.write', act: 'account.update', res: 'account', idGroup: 1 },
  { method: 'POST',   re: '^/api/juzhu/admin/accounts/(\\d+)/api-key$', perm: 'iam.key.write', act: 'account.issue-api-key', res: 'account', idGroup: 1 },
  { method: 'PUT',    re: '^/api/juzhu/admin/idp-configs$', perm: 'iam.write', act: 'idp_config.upsert', res: 'idp_configs' },
  // 评级（提交走归属 guard；复核走平台复核点）
  { method: 'POST',   re: '^/api/juzhu/admin/projects/(\\d+)/rating/submit$', perm: 'rating.write', act: 'rating.submit', res: 'projects', idGroup: 1, guard: 'ratingSubmit' },
  { method: 'POST',   re: '^/api/juzhu/admin/ratings/([^/]+)/review$', perm: 'rating.review', act: 'rating.review', res: 'projects', idGroup: 1 },
  // ── GET 收口（旧全局 key 在这些路由不再畅通；此前仅 accounts/idp-configs/audit 有手写闸）──
  { method: 'GET',    re: '^/api/juzhu/admin/(dictionary|cities|settings|projects|units|districts)$', perm: 'admin.read', act: null, res: null },
  { method: 'GET',    re: '^/api/juzhu/admin/projects/(\\d+)$', perm: 'admin.read', act: null, res: null },
  { method: 'GET',    re: '^/api/juzhu/admin/units/(\\d+)(/photos)?$', perm: 'admin.read', act: null, res: null },
  { method: 'GET',    re: '^/api/juzhu/admin/(accounts|idp-configs)$', perm: 'admin.read', act: null, res: null },
  { method: 'GET',    re: '^/api/juzhu/admin/audit$', perm: 'audit.read', act: null, res: null },
  // 免闸：登录/会话检查
  { method: 'POST',   re: '^/api/juzhu/admin/auth/login$', exempt: true },
  { method: 'GET',    re: '^/api/juzhu/admin/auth/check$', exempt: true },
];

const _compiled = ROUTES.map((r) => Object.assign({}, r, { _re: new RegExp(r.re) }));
const _permByCode = new Map(PERMS.map((p) => [p.code, p]));

/** 命中路由规则；未命中返回 null（调用方回退旧行为） */
function match(urlPath, method) {
  const p = String(urlPath || '').replace(/\/+$/, '') || '/';
  for (const r of _compiled) {
    if (r.method === method && r._re.test(p)) return r;
  }
  return null;
}

function labelOf(code) {
  const p = _permByCode.get(code);
  return p ? p.name : code;
}

function permOf(code) { return _permByCode.get(code) || null; }
function permCodes() { return PERMS.map((p) => p.code); }

/** 角色默认权限：由 PERMS[].roles 折叠（单一数据源）；platform_admin 显式 '*' */
function roleDefaults(roleCode) {
  if (roleCode === 'platform_admin') return ['*'];
  const out = [];
  for (const p of PERMS) {
    if ((p.roles || []).includes(roleCode)) out.push(p.code);
  }
  return out;
}

/** 全部内置角色 → 默认权限（快照脚本用） */
function allRoleDefaults() {
  const codes = new Set();
  for (const p of PERMS) for (const r of p.roles || []) codes.add(r);
  codes.add('platform_admin');
  const out = {};
  for (const c of codes) out[c] = roleDefaults(c);
  return out;
}

module.exports = { PERMS, ROUTES, match, labelOf, permOf, permCodes, roleDefaults, allRoleDefaults };
