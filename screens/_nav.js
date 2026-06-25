/* ============================================================
   _nav.js — 江苏保租房专用频道 · 共享导航模块（单一数据源）
   每个页面用法：
     桌面：<div id="side-nav" data-series="g" data-active="admin"></div>
     移动：<div id="tab-bar"  data-series="s" data-active="orders"></div>
     然后引入：<script src="_nav.js"></script>
   修改任何项都改这里 ── 不要在页面里再硬编码。
   ============================================================ */
(function () {
  'use strict';

  // 地域/部门配置（来自 _region.js）。缺省回退到江苏基准，保证单独引入也能用。
  const R = window.BZF_REGION || {
    prov: { short: '江苏', capital: '南京' }, dept: { short: '住建厅', stem: '住建', division: '监管处' },
    biz: { term: '保租房' }, bank: { name: '江苏银行', div: '普惠金融部' },
    soe: { full: '南京安居保障房集团' }, roster: { training: '家协培训' }, operator: '贝壳',
    channel: '江苏保租房', deptName: '住建厅', govOrg: '南京市住建局 · 监管处',
    bureau: function (m) { return m + '市住建局'; },
  };

  const ICONS = {
    home:        '<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>',
    chart:       '<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    download:    '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    warning:     '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    search:      '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    check:       '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
    star:        '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
    file:        '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    chat:        '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
    book:        '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
    user:        '<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    settings:    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33"/>',
    grid:        '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    bank:        '<path d="M3 21h18M3 10h18M5 10V6l7-3 7 3v4M6 10v11M10 10v11M14 10v11M18 10v11"/>',
    wallet:      '<path d="M21 12V7H5a2 2 0 010-4h14v4"/><path d="M3 5v14a2 2 0 002 2h16v-5"/><path d="M18 12a2 2 0 100 4h4v-4z"/>',
    coin:        '<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 100 4h4a2 2 0 110 4H8M12 6v2m0 8v2"/>',
    pulse:       '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    layout:      '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>',
    truck:       '<rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/>',
    award:       '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
    list:        '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
    layers:      '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    target:      '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    cpu:         '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
    radio:       '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>',
    plug:        '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    repair:      '<path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>',
    bell:        '<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>',
    box:         '<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    map:         '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
  };

  // 中文 label 自动映射到 icon（缺省 grid）
  function ico(k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + (ICONS[k] || ICONS.grid) + '</svg>'; }

  // ============ 6 系列定义（单一数据源） ============
  const SERIES = {
    g: {
      name: R.deptName + '监管端', short: R.channel + ' · G 端', icon: '⚖',
      primary: '#1e40af', primaryDeep: '#1e3a8a',
      user: { avatar: '张', name: '张科长', org: R.govOrg },
      groups: [
        { items: [
          { id: 'admin', label: '监管总览', href: 'gov-admin.html', icon: 'home' },
        ]},
        { name: '数据中心', items: [
          { id: 'dashboard', label: '监管大屏', href: 'g-dashboard.html', icon: 'chart' },
          { id: 'export',    label: '数据导出', href: 'g-export.html',    icon: 'download' },
        ]},
        { name: '房源监管', items: [
          { id: 'rent-alert', label: '租金合规预警', href: 'g-rent-alert.html', icon: 'warning', badge: 9 },
          { id: 'inspection', label: '抽查记录',     href: 'g-inspection.html', icon: 'search' },
        ]},
        { name: '主体准入 · 5 类机构', items: [
          { id: 'whitelist-service',  label: 'S 服务者白名单',  href: 'g-whitelist-service.html',  icon: 'user',  badge: 11 },
          { id: 'whitelist-operator', label: 'B 运营商白名单',  href: 'g-whitelist-operator.html', icon: 'check', badge: 5,  badgeKind: 'warn' },
          { id: 'whitelist-vendor',   label: 'V 人力服务商白名单', href: 'g-whitelist-vendor.html', icon: 'box',  badge: 3,  badgeKind: 'warn' },
          { id: 'whitelist-supplier', label: 'M 物资供应商白名单', href: 'g-whitelist-supplier.html', icon: 'box',   badge: 3,  badgeKind: 'warn' },
          { id: 'whitelist-training', label: 'T 培训机构白名单', href: 'g-whitelist-training.html', icon: 'award', badge: 3,  badgeKind: 'warn' },
        ]},
        { name: '服务者管理', items: [
          { id: 'pconsole-link', label: '服务认证中台 ↗', href: 'p-console.html', icon: 'grid' },
        ]},
        { name: '服务监管', items: [
          { id: 'complaint', label: '投诉处置', href: 'g-complaint.html', icon: 'chat', badge: 7 },
        ]},
        { name: '政策法规', items: [
          { id: 'policy', label: '政策发布', href: 'g-policy.html', icon: 'file' },
        ]},
      ],
    },

    b: {
      name: '运营机构工作台', short: '国企持有方 + 白名单运营商 共用', icon: '🏢',
      primary: '#0f766e', primaryDeep: '#134e4a',
      user: { avatar: '李', name: '李资管总监', org: R.soe.full + ' · 资管视角' },
      groups: [
        { name: '国企资管视角（持有方）', items: [
          { id: 'console',   label: '资管大盘（入住率/收入）', href: 'b-operator-console.html', icon: 'home' },
          { id: 'occupancy', label: '运营商绩效与 SLA',        href: 'b-occupancy.html',        icon: 'pulse' },
        ]},
        { name: '运营商工作台（白名单机构使用）', items: [
          { id: 'listing',         label: '房源上下架',       href: 'b-listing-mgmt.html',        icon: 'list' },
          { id: 'intake-api',      label: '房源接入 API ↗',   href: 'property-intake-api.html',   icon: 'plug' },
          { id: 'rating-input',    label: '★ 好房子评级录入', href: 'b-house-rating-input.html',  icon: 'star', badge: 7, badgeKind: 'warn' },
          { id: 'dispatch',        label: '派单看板',         href: 'b-dispatch-board.html',      icon: 'radio' },
          { id: 'staff',           label: '员工花名册',       href: 'b-staff-roster.html',        icon: 'user' },
          { id: 'perf-renewal',    label: '绩效与续约',       href: 'b-perf-renewal.html',       icon: 'pulse' },
        ]},
        { name: '业主托管', items: [
          { id: 'landlord', label: '业主端', href: 'landlord.html', icon: 'home' },
        ]},
        { name: '生态联动', items: [
          { id: 'pconsole', label: '服务认证中台 ↗', href: 'p-console.html',  icon: 'star' },
          { id: 'gov',      label: R.deptName + '监管 ↗',   href: 'gov-admin.html',  icon: 'award' },
        ]},
      ],
    },

    f: {
      name: R.bank.name + ' · ' + R.biz.term + '通道', short: R.channel + ' · F 端', icon: '🏛',
      primary: '#0f1a4d', primaryDeep: '#0a1238', accent: '#b45309',
      user: { avatar: '王', name: '王经理', org: R.bank.name + ' · ' + R.bank.div },
      groups: [
        { name: '账户与结算', items: [
          { id: 'escrow',          label: '监管账户对账',     href: 'f-escrow.html',          icon: 'bank' },
          { id: 'public-security', label: '公安备案核验',     href: 'f-public-security.html', icon: 'check' },
          { id: 'settlement',      label: '结算付款',         href: 'f-settlement.html',      icon: 'truck' },
          { id: 'account-config',  label: '结算账户配置',     href: 'f-account-config.html',  icon: 'settings' },
        ]},
        { name: '支付与数据', items: [
          { id: 'housing-fund', label: '公积金直付通道', href: 'f-housing-fund.html', icon: 'wallet' },
          { id: 'treasury',     label: '资金流水大盘',   href: 'f-treasury.html',     icon: 'coin' },
        ]},
        { name: '生态联动', items: [
          { id: 'gov', label: R.deptName + '监管 ↗', href: 'gov-admin.html', icon: 'award' },
        ]},
      ],
    },

    p: {
      name: '服务认证中台', short: '公共底座 + 5 类机构（S/B/V/M/T）分组', icon: 'CΛ',
      primary: '#0f172a', primaryDeep: '#020617',
      user: { avatar: 'A', name: 'Center Admin', org: R.operator + '服务认证中台' },
      groups: [
        { name: '🎛 总览', items: [
          { id: 'console',         label: '控制台',         href: 'p-console.html',         icon: 'home' },
        ]},
        { name: '🧱 公共底座（跨 5 类机构 / 共享基础设施）', items: [
          { id: 'cert-issue',      label: '发证管理 · 跨 5 类',  href: 'p-cert-issue.html',    icon: 'file',     badge: '2.4k' },
          { id: 'credit-engine',   label: '信用规则引擎',        href: 'p-credit-engine.html', icon: 'cpu',      badge: '42' },
          { id: 'data-hub',        label: '数据中台',            href: 'p-data-hub.html',      icon: 'plug',     badge: '24/7' },
          { id: 'permissions',     label: '权限 RBAC',           href: 'p-permissions.html',   icon: 'user',     badge: 'RBAC' },
          { id: 'workflow',        label: 'BPMN 工作流引擎',     href: 'p-workflow.html',      icon: 'layers',   badge: '18' },
          { id: 'webhooks',        label: '事件总线 · Webhook',  href: 'p-webhooks.html',      icon: 'radio',    badge: '38' },
          { id: 'api-gateway',     label: 'API 网关',            href: 'p-api-gateway.html',   icon: 'settings', badge: '86' },
          { id: 'notifications',   label: '通知中心',            href: 'p-notifications.html', icon: 'bell',     badge: '86' },
          { id: 'insurance',       label: '履约保障 · 责任险',   href: 'p-insurance.html',     icon: 'check' },
        ]},
        { name: '🛠 × S 服务者（个人持证轨道）', items: [
          { id: 'standards',       label: 'L0-L7 等级标准',      href: 'p-standards.html',      icon: 'layers',  badge: 'v3.0' },
          { id: 'question-bank',   label: '考题题库 + 试卷',     href: 'p-question-bank.html',  icon: 'list',    badge: '1.2k' },
          { id: 'service-demand',  label: '服务需求 · 工单池',   href: 'p-service-demand.html', icon: 'list' },
          { id: 'traffic-policy',  label: '派单流量策略 + 扶持', href: 'p-traffic-policy.html', icon: 'radio',   badge: '7' },
          { id: 'transaction',     label: '派单分账 + 结算',     href: 'p-transaction.html',    icon: 'coin',    badge: 'T+7' },
          { id: 'service-review',  label: '服务评价 · 口碑回流', href: 'p-service-review.html', icon: 'star' },
          { id: 'onboarding-review', label: '入驻申请受理',       href: 'p-onboarding-review.html', icon: 'user' },
          { id: 'sapp',            label: '服务者 App ↗',        href: 's-orders.html',         icon: 'user' },
        ]},
        { name: '🏬 × B 白名单运营商', items: [
          { id: 'b-standards',     label: '★ B 分级标准 + 星级评价', href: 'p-b-standards.html',         icon: 'layers', badge: 'NEW' },
          { id: 'b-whitelist',     label: '★ 白名单审定 + 同业开放', href: 'p-b-whitelist.html',         icon: 'check' },
          { id: 'rating-review',   label: '🐚 房源评级复核 · AI引擎', href: 'p-rating-review.html',       icon: 'star',   badge: '23' },
          { id: 'b-rating',        label: '好房子评级录入 ↗',        href: 'b-house-rating-input.html',  icon: 'star' },
          { id: 'b-console',       label: 'B 运营商工作台 ↗',        href: 'b-operator-console.html',    icon: 'home' },
        ]},
        { name: '👥 × V 人力服务商', items: [
          { id: 'v-standards',     label: '★ V 分级标准 + 持证率',   href: 'p-v-standards.html',         icon: 'layers', badge: 'NEW' },
          { id: 'v-onboarding',    label: 'V 入驻审定 ↗',            href: 'g-whitelist-supplier.html',  icon: 'check' },
          { id: 'vendor-cert',     label: '服务商商业认证 L5',       href: 'p-vendor-cert.html',         icon: 'award' },
          { id: 'v-portal',        label: 'V 服务商门户 ↗',          href: 'v-onboarding.html',          icon: 'user' },
        ]},
        { name: '🛒 × M 物资供应商', items: [
          { id: 'm-standards',     label: '★ M 6 品类标准 + 集采底价', href: 'p-m-standards.html',       icon: 'layers', badge: 'NEW' },
          { id: 'm-catalog-cert',  label: '6 品类认证审核',          href: 'p-m-catalog-cert.html',      icon: 'check' },
          { id: 'm-batch-qc',      label: '批次质检追溯',            href: 'p-m-batch-qc.html',          icon: 'box' },
          { id: 'm-portal',        label: 'M 供应商门户 ↗',          href: 'm-supplier-onboarding.html', icon: 'list' },
        ]},
        { name: '🎓 × T 培训机构', items: [
          { id: 't-partner-cert',  label: '★ T 合作伙伴认证 + 讲师持证', href: 'p-t-partner-cert.html', icon: 'layers', badge: 'NEW' },
          { id: 'training-center', label: '培训中心 + 排课',         href: 'p-training-center.html',     icon: 'book',   badge: '86 课' },
          { id: 'course-cert',     label: '课程认证审核',            href: 'p-course-cert.html',         icon: 'check' },
          { id: 'exam-admin',      label: '考务 · 排考与成绩核发',   href: 'p-exam-admin.html',          icon: 'list',   badge: 'NEW' },
          { id: 'graduation',      label: '结业核发 · 学时认定',     href: 'p-graduation.html',          icon: 'award',  badge: 'NEW' },
          { id: 't-courses',       label: 'T 课程开发 ↗',            href: 't-courses.html',             icon: 'list' },
        ]},
        { name: '🌐 生态联动', items: [
          { id: 'gov',  label: R.deptName + '监管 ↗',     href: 'gov-admin.html',        icon: 'award' },
          { id: 'portal', label: '公示门户 ↗',     href: 'portal-index.html',     icon: 'star' },
        ]},
      ],
    },

    /* S 和 C 系列（移动端）已移到 _navmobile.js，本文件只管桌面端 sidebar */

    m: {
      name: '物资供应商门户', short: R.channel + ' · M 端 · 物资集采', icon: '🛒',
      primary: '#6b21a8', primaryDeep: '#4c1d95',
      user: { avatar: '陈', name: '陈采购总监', org: '北新建材 · 物资供应商 LV2' },
      groups: [
        { name: '入驻与认证', items: [
          { id: 'onboarding', label: '入驻申请', href: 'm-supplier-onboarding.html', icon: 'check' },
        ]},
        { name: '物资目录', items: [
          { id: 'catalog',    label: '商品目录 + 集采报价', href: 'm-supplier-catalog.html',    icon: 'list' },
        ]},
        { name: '订单与对账', items: [
          { id: 'orders',     label: '集采订单 + 对账',     href: 'm-supplier-orders.html',     icon: 'box' },
        ]},
        { name: '生态联动', items: [
          { id: 'gws',       label: R.dept.stem + ' · 供应商白名单 ↗', href: 'g-whitelist-supplier.html',  icon: 'award' },
          { id: 'suppliers', label: '合格供应商公示 ↗',      href: 'suppliers.html',             icon: 'star' },
          { id: 'pconsole',  label: '服务认证中台 ↗',        href: 'p-console.html',             icon: 'grid' },
          { id: 'vportal',   label: '服务商门户 ↗',          href: 'v-onboarding.html',          icon: 'user' },
        ]},
      ],
    },

    v: {
      name: '服务商门户', short: R.channel + ' · V 端', icon: '🏭',
      primary: '#c2410c', primaryDeep: '#7c2d12',
      user: { avatar: '吴', name: '吴志强', org: '优家装饰 · 服务商负责人 L5' },
      groups: [
        { name: '入驻与资质', items: [
          { id: 'onboarding', label: '入驻申请', href: 'v-onboarding.html', icon: 'check' },
        ]},
        { name: '业务对接', items: [
          { id: 'projects',   label: '项目对接', href: 'v-projects.html',   icon: 'box' },
        ]},
        { name: '团队管理', items: [
          { id: 'team',       label: '旗下服务者', href: 'v-team.html',     icon: 'user' },
        ]},
        { name: '生态联动', items: [
          { id: 'pconsole',    label: '服务认证中台 ↗',     href: 'p-console.html',             icon: 'star' },
          { id: 'gov',         label: R.deptName + '监管 ↗',       href: 'gov-admin.html',             icon: 'award' },
          { id: 'mportal',     label: '物资供应商门户 ↗',   href: 'm-supplier-onboarding.html', icon: 'box' },
          { id: 'suppliers',   label: '合格供应商公示 ↗',   href: 'suppliers.html',             icon: 'check' },
        ]},
      ],
    },

    portal: {
      name: '公示门户', short: '公众查询 · 政府背书 · 可验真', icon: '🛡',
      primary: '#115e59', primaryDeep: '#064e3b',
      user: { avatar: '公', name: '公众访客', org: '面向社会公开' },
      groups: [
        { name: '公开查询', items: [
          { id: 'index',  label: '公示门户首页', href: 'portal-index.html',  icon: 'search' },
          { id: 'verify', label: '扫码验真详情', href: 'portal-verify.html', icon: 'check' },
        ]},
        { name: '对外开放规范', items: [
          { id: 'intake-api', label: '房源接入 API', href: 'property-intake-api.html', icon: 'plug' },
        ]},
      ],
    },

    d: {
      name: '方案与标准文档库', short: '对外发布物 · 顶层方案与标准', icon: '📐',
      primary: '#0f172a', primaryDeep: '#020617', accent: '#b45309',
      user: { avatar: '文', name: '方案文档', org: R.channel + ' · D 系列' },
      groups: [
        { name: '顶层图谱', items: [
          { id: 'master-blueprint', label: '总图谱', href: 'd-master-blueprint.html', icon: 'map' },
        ]},
        { name: '三大标准', items: [
          { id: 'people-standard',   label: '人的标准 · 服务者认证体系',        href: 'd-people-standard.html',   icon: 'user' },
          { id: 'property-standard', label: '房的标准 · 好房子四维度+综合星级',  href: 'd-property-standard.html', icon: 'star' },
          { id: 'org-standard',      label: '机构的标准 · 五类机构生态',         href: 'd-org-standard.html',      icon: 'box' },
        ]},
        { name: '专题', collapsed: true, items: [
          { id: 'research-platform', label: '研判中台 · ' + R.operator + '数据资产输出', href: 'd-research-platform.html', icon: 'cpu' },
          { id: 'org-gov-standard',  label: '机构+政府合作模式 · v1',     href: 'd-org-gov-standard.html',  icon: 'bank' },
        ]},
        { name: '三阶段交付', items: [
          { id: 'tier-overview', label: '三档总对比 ↗',           href: '../baozufang-channel-overview.html',    icon: 'layers' },
          { id: 'tier-v1',       label: '阶段一·展示型 ↗',        href: '../baozufang-overview-v1-basic.html',    icon: 'file' },
          { id: 'tier-v2',       label: '阶段二·+标准体系 ↗',     href: '../baozufang-overview-v2-standard.html', icon: 'file' },
          { id: 'tier-v3',       label: '阶段三·+交易闭环 ↗',     href: '../baozufang-overview-v3-full.html',     icon: 'file' },
        ]},
      ],
    },

    t: {
      name: '培训机构端', short: R.channel + ' · T 端 · 合作培训方', icon: '🎓',
      primary: '#7c3aed', primaryDeep: '#5b21b6',
      user: { avatar: '王', name: '王校长', org: R.prov.short + R.roster.training + '中心' },
      groups: [
        { name: '课程内容', items: [
          { id: 'courses',  label: '课程开发', href: 't-courses.html',  icon: 'book' },
        ]},
        { name: '学员服务', items: [
          { id: 'students', label: '学员管理', href: 't-students.html', icon: 'user' },
        ]},
        { name: '排期资源', items: [
          { id: 'schedule', label: '排课排考', href: 't-schedule.html', icon: 'list' },
        ]},
        { name: '生态联动', items: [
          { id: 'pconsole', label: '服务认证中台 ↗', href: 'p-console.html', icon: 'star' },
        ]},
      ],
    },

  };

  // ============ 注入共享 CSS（仅一次） ============
  function injectStyles() {
    if (document.getElementById('_nav-styles')) return;
    const css = `
      /* desktop sidebar */
      .nv-shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
      .nv-side {
        background: linear-gradient(180deg, var(--nv-deep, #1e3a8a) 0%, var(--nv-primary, #1e40af) 100%);
        color: white; position: sticky; top: 0; height: 100vh;
        overflow-y: auto;
        display: flex; flex-direction: column;
        font-family: system-ui, -apple-system, 'PingFang SC', sans-serif;
      }
      .nv-side::-webkit-scrollbar { width: 4px; }
      .nv-side::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
      .nv-brand {
        display: flex; align-items: center; gap: 10px;
        padding: 16px 18px; border-bottom: 1px solid rgba(255,255,255,0.12);
      }
      .nv-logo {
        width: 36px; height: 36px; border-radius: 8px;
        background: rgba(255,255,255,0.18);
        display: grid; place-items: center; font-size: 18px; font-weight: 700;
      }
      .nv-bname { font-size: 14px; font-weight: 600; line-height: 1.2; }
      .nv-bname .nv-bsub { font-size: 10px; opacity: 0.65; font-weight: 400; display: block; margin-top: 2px; }
      .nv-nav { flex: 1; padding: 8px 0; }
      .nv-group {
        font-size: 11px; color: rgba(255,255,255,0.5);
        padding: 14px 18px 6px; letter-spacing: 0.5px; font-weight: 500;
      }
      .nv-group-toggle {
        cursor: pointer; display: flex; align-items: center; justify-content: space-between;
        user-select: none; transition: color 0.15s;
      }
      .nv-group-toggle:hover { color: rgba(255,255,255,0.8); }
      .nv-group-toggle .nv-caret {
        font-size: 10px; opacity: 0.55; transition: transform 0.18s;
        display: inline-block;
      }
      .nv-group-toggle.open .nv-caret { transform: rotate(90deg); }
      .nv-link {
        display: flex; align-items: center; gap: 10px;
        padding: 9px 18px; color: rgba(255,255,255,0.82);
        font-size: 13px; cursor: pointer; text-decoration: none;
        border-left: 3px solid transparent; transition: background 0.15s;
      }
      .nv-link:hover { background: rgba(255,255,255,0.06); color: white; }
      .nv-link.active {
        background: rgba(255,255,255,0.1); color: white; font-weight: 600;
        border-left-color: rgba(255,255,255,0.85);
      }
      .nv-link svg { width: 16px; height: 16px; flex-shrink: 0; }
      .nv-link .nv-name { flex: 1; }
      .nv-badge {
        font-size: 10px; padding: 1px 6px; border-radius: 8px;
        background: #dc2626; color: white; font-weight: 600;
      }
      .nv-badge.warn { background: #ea580c; }
      .nv-badge.ok   { background: #16a34a; }
      .nv-badge.mute { background: rgba(255,255,255,0.18); color: rgba(255,255,255,0.85); }
      .nv-user {
        display: flex; align-items: center; gap: 10px;
        padding: 12px 18px; border-top: 1px solid rgba(255,255,255,0.12);
        font-size: 12px;
      }
      .nv-avatar {
        width: 32px; height: 32px; border-radius: 50%;
        background: rgba(255,255,255,0.2); display: grid; place-items: center;
        font-weight: 700;
      }
      .nv-uinfo { flex: 1; }
      .nv-uinfo .nv-uname { font-weight: 600; }
      .nv-uinfo .nv-uorg { font-size: 11px; opacity: 0.7; }
      .nv-overview-link {
        display: block; padding: 10px 18px;
        font-size: 11px; color: rgba(255,255,255,0.55);
        border-top: 1px solid rgba(255,255,255,0.08);
        text-decoration: none;
      }
      .nv-overview-link:hover { color: white; }

      /* 移动 tabbar 已移到 _navmobile.js */

      /* 当页面没有自定义 grid layout 时，给 body 加 .nv-with-side
         自动启用：240px 侧栏 + 剩余主区 */
      @media (min-width: 1024px) {
        body.nv-with-side {
          display: grid;
          grid-template-columns: 240px 1fr;
          min-height: 100vh;
        }
      }
      @media (max-width: 1023px) {
        body.nv-with-side .nv-side { display: none; }
      }
    `;
    const s = document.createElement('style');
    s.id = '_nav-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // 解析 href：若 mount 节点上有 data-base，则前缀加到非协议/非../的相对路径
  function resolveHref(href, base) {
    if (!base) return href;
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) return href;
    if (href.startsWith('../')) return href.replace(/^\.\.\//, '');  // 根目录可达
    return base + href;
  }

  // ============ render desktop sidebar ============
  function renderSidebar(seriesKey, activeId, base) {
    const S = SERIES[seriesKey];
    if (!S) { console.warn('[_nav] unknown series', seriesKey); return ''; }
    const groupsHtml = S.groups.map((g, gi) => {
      // 当前 active 项是否在此组内：若是，即使 collapsed 默认也展开
      const hasActive = activeId && g.items.some(it => it.id === activeId);
      const startOpen = !g.collapsed || hasActive;
      const items = g.items.map(it => {
        const isActive = it.id === activeId ? ' active' : '';
        const badge = it.badge != null
          ? `<span class="nv-badge${it.badgeKind ? ' ' + it.badgeKind : ''}">${it.badge}</span>` : '';
        return `<a class="nv-link${isActive}" href="${resolveHref(it.href, base)}">${ico(it.icon)}<span class="nv-name">${it.label}</span>${badge}</a>`;
      }).join('');
      if (!g.name) return items;
      if (g.collapsed) {
        const gid = `nvg-${seriesKey}-${gi}`;
        return `<div class="nv-group nv-group-toggle${startOpen ? ' open' : ''}" data-gid="${gid}">${g.name}<span class="nv-caret">▸</span></div>
          <div class="nv-group-body" id="${gid}" style="${startOpen ? '' : 'display:none;'}">${items}</div>`;
      }
      return `<div class="nv-group">${g.name}</div>${items}`;
    }).join('');
    return `
      <aside class="nv-side" style="--nv-primary:${S.primary};--nv-deep:${S.primaryDeep || S.primary};">
        <div class="nv-brand">
          <div class="nv-logo">${S.icon || '■'}</div>
          <div class="nv-bname">${S.name}<span class="nv-bsub">${S.short || ''}</span></div>
        </div>
        <div class="nv-nav">${groupsHtml}</div>
        <div class="nv-user">
          <div class="nv-avatar">${S.user.avatar}</div>
          <div class="nv-uinfo"><div class="nv-uname">${S.user.name}</div><div class="nv-uorg">${S.user.org}</div></div>
        </div>
        <a class="nv-overview-link" href="../overview.html">📋 全站导航总览 →</a>
      </aside>
    `;
  }

  // ============ auto mount ============
  function bindGroupToggle(root) {
    (root || document).querySelectorAll('.nv-group-toggle').forEach(h => {
      h.addEventListener('click', () => {
        const body = document.getElementById(h.dataset.gid);
        if (!body) return;
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        h.classList.toggle('open', !open);
      });
    });
  }
  function mount() {
    injectStyles();
    document.querySelectorAll('#side-nav').forEach(el => {
      el.outerHTML = renderSidebar(el.dataset.series, el.dataset.active, el.dataset.base);
    });
    bindGroupToggle();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // 暴露元数据供 overview.html 等使用
  window.BZF_NAV = { SERIES, renderSidebar };
})();
