/* ============================================================
   _navmobile.js — 移动端 chrome 集中配置（顶部 + 底部）
   全部移动端的 status-bar / 渐变 header / 底部 tabbar 都在这里。
   桌面端 sidebar 在 _nav.js，两者职责分离。
   每个移动页面用法（任选其一）：
     <div id="m-header" data-series="g"
          data-title="政策发布" data-icon="📜"></div>
     <div id="m-tabbar" data-series="g" data-active="policy"></div>
     <!-- 或纯 tabbar 页面（S/C 端）： -->
     <div id="tab-bar" data-series="s" data-active="orders"></div>
     <script src="_navmobile.js"></script>
   ============================================================ */
(function () {
  'use strict';

  // 地域/部门配置（来自 _region.js）。缺省回退到江苏基准。
  const R = window.BZF_REGION || {
    prov: { short: '江苏', capital: '南京' }, dept: { short: '住建厅', stem: '住建', division: '监管处' },
    biz: { term: '保租房' }, bank: { name: '江苏银行', div: '普惠金融部' },
    deptName: '住建厅', govOrg: '南京市住建局 · 监管处',
  };

  // 移动端系列元数据（与 _nav.js SERIES 互补 ── 这里只放移动端专属）
  const MOBILE = {
    g: {
      primary: '#1e40af', primaryDeep: '#1e3a8a', accent2: '#2563eb',
      stamp: R.deptName + ' · ' + R.dept.division,
      /* 领导画像 · 3 项极简 tabbar */
      tabbar: [
        { id: 'cockpit',  label: '驾驶舱', href: 'gov-admin.html', icon: 'chart' },
        { id: 'approval', label: '待批',   href: 'g-approval.html', icon: 'check', badge: 5 },
        { id: 'me',       label: '我',     href: 'g-me.html',       icon: 'user' },
      ],
      /* 汉堡抽屉的完整 11 页菜单（复用 _nav.js 的 G sidebar 结构） */
      drawer: {
        user: { avatar: '张', name: '张科长', org: R.govOrg },
        groups: [
          { name: '驾驶舱', items: [
            { id: 'cockpit',   label: '监管总览',     href: 'gov-admin.html',     icon: 'home' },
            { id: 'dashboard', label: '监管大屏',     href: 'g-dashboard.html',   icon: 'chart' },
          ]},
          { name: '日常处置', items: [
            { id: 'rent-alert', label: '租金合规预警', href: 'g-rent-alert.html', icon: 'warning',   badge: 9 },
            { id: 'complaint',  label: '投诉处置',     href: 'g-complaint.html',  icon: 'chat',      badge: 7 },
            { id: 'inspection', label: '抽查记录',     href: 'g-inspection.html', icon: 'search' },
          ]},
          { name: '主体准入', items: [
            { id: 'whitelist-operator', label: '运营方白名单', href: 'g-whitelist-operator.html', icon: 'check', badge: 5,  badgeKind: 'warn' },
            { id: 'whitelist-service',  label: '服务者白名单', href: 'g-whitelist-service.html',  icon: 'user',  badge: 11 },
            { id: 'whitelist-supplier', label: '供应商白名单', href: 'g-whitelist-supplier.html', icon: 'box',   badge: 3,  badgeKind: 'warn' },
          ]},
          { name: '政策与数据', items: [
            { id: 'policy', label: '政策发布', href: 'g-policy.html', icon: 'file' },
            { id: 'export', label: '数据导出', href: 'g-export.html', icon: 'download' },
          ]},
          { name: '我的', items: [
            { id: 'approval', label: '待我签批',   href: 'g-approval.html', icon: 'check', badge: 5 },
            { id: 'me',       label: '个人中心',   href: 'g-me.html',       icon: 'user' },
          ]},
        ],
      },
    },
    b: {
      primary: '#0f766e', primaryDeep: '#134e4a', accent2: '#14b8a6',
      stamp: '运营机构（国企+白名单）',
      tabbar: [
        { id: 'console',   label: '总览', href: 'b-operator-console.html', icon: 'home' },
        { id: 'listing',   label: '房源', href: 'b-listing-mgmt.html',     icon: 'list' },
        { id: 'occupancy', label: '工单', href: 'b-occupancy.html',        icon: 'pulse' },
        { id: 'dispatch',  label: '派单', href: 'b-dispatch-board.html',   icon: 'radio' },
        { id: 'staff',     label: '员工', href: 'b-staff-roster.html',     icon: 'user' },
      ],
    },
    f: {
      primary: '#0f1a4d', primaryDeep: '#0a1238', accent2: '#b45309',
      stamp: R.bank.name + ' · ' + R.bank.div,
      tabbar: [
        { id: 'escrow',       label: '账户', href: 'f-escrow.html',       icon: 'bank' },
        { id: 'housing-fund', label: '直付', href: 'f-housing-fund.html', icon: 'wallet' },
        { id: 'treasury',     label: '大盘', href: 'f-treasury.html',     icon: 'coin' },
      ],
    },
    /* S 端：服务者 App */
    s: {
      primary: '#0f766e', primaryDeep: '#134e4a', accent2: '#14b8a6',
      stamp: '服务者 App',
      tabbar: [
        { id: 'orders', label: '工单', href: 's-orders.html', icon: 'list' },
        { id: 'cert',   label: '认证', href: 's-cert.html',   icon: 'check' },
        { id: 'learn',  label: '学习', href: 's-learn.html',  icon: 'book' },
        { id: 'exam',   label: '考试', href: 's-exam.html',   icon: 'check' },
        { id: 'income', label: '收入', href: 's-income.html', icon: 'wallet' },
      ],
    },
    /* C 端：租客 */
    c: {
      primary: '#2563eb', primaryDeep: '#1e3a8a', accent2: '#3b82f6',
      stamp: R.biz.term + ' · 租客',
      tabbar: [
        { id: 'home',         label: '首页',       href: '../index.html',         icon: 'home' },
        { id: 'rating',       label: '★ 好房子',   href: 'c-house-rating.html',   icon: 'star' },
        { id: 'policy',       label: '政策',       href: 'policy.html',           icon: 'book' },
        { id: 'applications', label: '我的申请',   href: 'my-applications.html',  icon: 'file' },
        { id: 'profile',      label: '个人',       href: 'profile.html',          icon: 'user' },
      ],
    },
  };

  // 内联 SVG 图标库（与 _nav.js 同步）
  const ICONS = {
    home:'<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>',
    chart:'<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
    warning:'<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    check:'<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
    file:'<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
    chat:'<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
    list:'<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
    pulse:'<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    radio:'<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49"/>',
    user:'<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    bank:'<path d="M3 21h18M3 10h18M5 10V6l7-3 7 3v4M6 10v11M10 10v11M14 10v11M18 10v11"/>',
    wallet:'<path d="M21 12V7H5a2 2 0 010-4h14v4"/><path d="M3 5v14a2 2 0 002 2h16v-5"/>',
    coin:'<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 100 4h4a2 2 0 110 4H8"/>',
    menu:'<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    box:'<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    download:'<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    warning:'<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/>',
    search:'<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    user:'<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    chevronRight:'<polyline points="9 18 15 12 9 6"/>',
    close:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    star:'<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
  };
  function ico(k){ return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">'+(ICONS[k]||'')+'</svg>'; }

  // 注入共享 CSS
  function injectStyles(){
    if (document.getElementById('_navmobile-styles')) return;
    const css = `
      .nvm-status{display:flex; justify-content:space-between; padding:8px 20px 6px; font-size:12px; font-weight:600; background:var(--surface, #fff);}
      .nvm-header{
        color:white; padding:14px 16px 18px; position:relative; overflow:hidden;
        font-family:system-ui,-apple-system,'PingFang SC',sans-serif;
      }
      .nvm-header::after{
        content:attr(data-decor); position:absolute; right:-12px; bottom:-20px;
        font-size:90px; opacity:0.1; line-height:1; pointer-events:none;
      }
      .nvm-nav-row{display:flex; align-items:center; gap:10px; margin-bottom:10px;}
      .nvm-back{
        width:32px; height:32px; background:rgba(255,255,255,0.16); border-radius:50%;
        display:grid; place-items:center; cursor:pointer; border:0;
      }
      .nvm-back svg{width:16px; height:16px; color:white;}
      .nvm-nav-row h1{flex:1; font-size:16px; font-weight:600; margin:0; color:white;}
      .nvm-stamp{font-size:11px; opacity:0.85;}
      .nvm-ttl{font-size:18px; font-weight:700; margin:0; color:white;}
      .nvm-sub{font-size:12px; opacity:0.85; margin-top:4px; color:white;}

      /* 底部 tabbar */
      .nvm-tabbar{
        position:fixed; bottom:0; left:50%; transform:translateX(-50%);
        width:100%; max-width:430px;
        background:#fff; border-top:1px solid #e5e7eb;
        display:flex; padding:6px 0 calc(6px + env(safe-area-inset-bottom, 0px));
        z-index:100;
        font-family:system-ui,-apple-system,'PingFang SC',sans-serif;
      }
      .nvm-tabbar a{
        flex:1; display:flex; flex-direction:column; align-items:center; gap:2px;
        padding:4px 2px; color:#6b7280; font-size:9px; text-decoration:none;
      }
      .nvm-tabbar a.active{color:var(--nvm-primary, #1e40af); font-weight:600;}
      .nvm-tabbar a svg{width:20px; height:20px;}
      @media (min-width: 600px){ .nvm-tabbar{ max-width:760px; } }

      /* 汉堡按钮（位于 .nvm-header 左侧） */
      .nvm-menu{
        width:32px; height:32px; background:rgba(255,255,255,0.16); border-radius:8px;
        display:grid; place-items:center; cursor:pointer; border:0; flex-shrink:0;
      }
      .nvm-menu svg{width:18px; height:18px; color:white;}

      /* 全屏抽屉 */
      .nvm-drawer-mask{
        position:fixed; inset:0; background:rgba(0,0,0,0.5);
        z-index:300; opacity:0; pointer-events:none; transition:opacity 0.25s;
      }
      .nvm-drawer-mask.on{opacity:1; pointer-events:auto;}
      .nvm-drawer{
        position:fixed; top:0; left:0; bottom:0;
        width:84%; max-width:340px;
        background:linear-gradient(180deg, var(--nvm-primary-deep, #1e3a8a) 0%, var(--nvm-primary, #1e40af) 100%);
        color:white; z-index:301;
        transform:translateX(-100%); transition:transform 0.28s;
        display:flex; flex-direction:column;
        overflow-y:auto;
        font-family:system-ui,-apple-system,'PingFang SC',sans-serif;
      }
      .nvm-drawer.on{transform:translateX(0);}
      .nvm-drawer::-webkit-scrollbar{width:0;}
      .nvm-drawer-head{
        display:flex; align-items:center; gap:12px;
        padding:18px 18px 14px; border-bottom:1px solid rgba(255,255,255,0.12);
      }
      .nvm-drawer-avatar{
        width:44px; height:44px; border-radius:50%;
        background:rgba(255,255,255,0.22); display:grid; place-items:center;
        font-weight:700; font-size:18px; flex-shrink:0;
      }
      .nvm-drawer-uinfo{flex:1; min-width:0;}
      .nvm-drawer-uname{font-size:15px; font-weight:600;}
      .nvm-drawer-uorg{font-size:11px; opacity:0.75; margin-top:2px;}
      .nvm-drawer-close{
        width:32px; height:32px; background:rgba(255,255,255,0.16); border-radius:8px;
        display:grid; place-items:center; cursor:pointer; border:0; flex-shrink:0;
      }
      .nvm-drawer-close svg{width:16px; height:16px; color:white;}
      .nvm-drawer-nav{flex:1; padding:6px 0 12px;}
      .nvm-drawer-group{
        font-size:11px; color:rgba(255,255,255,0.5); letter-spacing:0.5px;
        padding:14px 18px 6px; font-weight:500;
      }
      .nvm-drawer-link{
        display:flex; align-items:center; gap:10px;
        padding:11px 18px; color:rgba(255,255,255,0.85);
        font-size:14px; text-decoration:none;
        border-left:3px solid transparent;
      }
      .nvm-drawer-link.active{
        background:rgba(255,255,255,0.1); color:white; font-weight:600;
        border-left-color:rgba(255,255,255,0.85);
      }
      .nvm-drawer-link svg{width:17px; height:17px; flex-shrink:0;}
      .nvm-drawer-link .nm{flex:1;}
      .nvm-drawer-link .bd{
        font-size:10px; padding:1px 6px; border-radius:8px;
        background:#dc2626; color:white; font-weight:600;
      }
      .nvm-drawer-link .bd.warn{background:#ea580c;}
      .nvm-drawer-foot{
        padding:14px 18px; border-top:1px solid rgba(255,255,255,0.12);
        font-size:11px; opacity:0.65;
      }
      .nvm-drawer-foot a{color:white;}

      /* ============ 通用 Bottom-Sheet 详情 ============ */
      .nvm-sheet-mask{
        position:fixed; inset:0; background:rgba(0,0,0,0.5);
        z-index:400; opacity:0; pointer-events:none; transition:opacity 0.25s;
      }
      .nvm-sheet-mask.on{opacity:1; pointer-events:auto;}
      .nvm-sheet{
        position:fixed; left:50%; bottom:0; transform:translate(-50%, 100%);
        width:100%; max-width:430px; max-height:90vh;
        background:#fff; border-radius:18px 18px 0 0;
        z-index:401; transition:transform 0.3s;
        display:flex; flex-direction:column;
        font-family:system-ui,-apple-system,'PingFang SC',sans-serif;
      }
      .nvm-sheet.on{transform:translate(-50%, 0);}
      .nvm-sheet-grab{
        width:36px; height:4px; background:#e5e7eb; border-radius:2px;
        margin:8px auto 0;
      }
      .nvm-sheet-head{
        display:flex; align-items:center; padding:14px 18px 12px;
        border-bottom:1px solid #e5e7eb;
      }
      .nvm-sheet-head .t{flex:1; font-size:16px; font-weight:600; color:#111;}
      .nvm-sheet-head .x{
        width:30px; height:30px; display:grid; place-items:center;
        color:#6b7280; font-size:22px; cursor:pointer; border:0; background:none;
      }
      .nvm-sheet-body{
        flex:1; overflow-y:auto; padding:16px 18px;
        font-size:14px; line-height:1.6; color:#111;
      }
      .nvm-sheet-body h4{margin:14px 0 8px; font-size:13px; font-weight:600; color:#6b7280; letter-spacing:0.5px; text-transform:uppercase;}
      .nvm-sheet-body h4:first-child{margin-top:0;}
      .nvm-sheet-body .kv{display:grid; grid-template-columns:auto 1fr; gap:6px 12px; font-size:13px; margin:8px 0;}
      .nvm-sheet-body .kv .k{color:#6b7280;}
      .nvm-sheet-body .kv .v{color:#111; font-weight:500;}
      .nvm-sheet-body .doc-row{display:flex; align-items:center; gap:10px; padding:10px 12px; background:#f3f4f6; border-radius:8px; margin-bottom:6px; font-size:13px; cursor:pointer;}
      .nvm-sheet-body .doc-row::before{content:'📄'; font-size:18px;}
      .nvm-sheet-body .doc-row .nm{flex:1;}
      .nvm-sheet-body .doc-row .sz{font-size:11px; color:#6b7280;}
      .nvm-sheet-body ul{margin:0; padding-left:18px;}
      .nvm-sheet-body ul li{margin-bottom:4px;}
      .nvm-sheet-foot{
        display:flex; gap:8px;
        padding:12px 18px calc(12px + env(safe-area-inset-bottom, 0px));
        border-top:1px solid #e5e7eb; background:#fff;
      }
      .nvm-sheet-foot a, .nvm-sheet-foot button{
        flex:1; padding:11px; border-radius:8px; text-align:center;
        font-size:14px; font-weight:600; cursor:pointer;
        text-decoration:none; border:0;
      }
      .nvm-sheet-foot .pri{background:#1e40af; color:#fff;}
      .nvm-sheet-foot .ok{background:#16a34a; color:#fff;}
      .nvm-sheet-foot .rej{background:#fff; color:#dc2626; border:1px solid #dc2626;}
      .nvm-sheet-foot .ghost{background:#f3f4f6; color:#6b7280; border:1px solid #e5e7eb;}

      /* PC 顶部条（移动端隐藏，PC 显示） */
      .nvm-pc-head{display:none;}
      @media (min-width: 1024px){
        /* 隐藏移动 chrome */
        .nvm-status, .nvm-header, .nvm-tabbar { display:none !important; }

        /* nv-with-side 全屏 grid（240 sidebar + 1fr 主区） */
        body.nv-with-side{
          display:grid; grid-template-columns:240px 1fr;
          min-height:100vh; background:#f3f4f6;
        }
        body.nv-with-side .app-shell{
          max-width:none !important; width:100%;
          padding:0 !important; margin:0 !important;
          min-height:auto !important; background:#f3f4f6;
        }
        /* PC 顶部条 */
        .nvm-pc-head{
          display:flex; align-items:center; gap:14px;
          padding:14px 28px;
          background:#fff; border-bottom:1px solid #e5e7eb;
          position:sticky; top:0; z-index:5;
          font-family:system-ui,-apple-system,'PingFang SC',sans-serif;
        }
        .nvm-pc-head .nvm-pc-icon{
          width:40px; height:40px; border-radius:10px;
          background:var(--nvm-primary, #1e40af); color:#fff;
          display:grid; place-items:center; font-size:20px; flex-shrink:0;
        }
        .nvm-pc-head .nvm-pc-title{flex:1; min-width:0;}
        .nvm-pc-head .nvm-pc-title strong{
          display:block; font-size:18px; font-weight:600; color:#111;
        }
        .nvm-pc-head .nvm-pc-title span{font-size:12px; color:#6b7280;}
        .nvm-pc-head .nvm-pc-right{
          font-size:12px; color:#6b7280;
          padding:5px 12px; background:#f3f4f6; border-radius:6px;
        }
      }
    `;
    const s = document.createElement('style');
    s.id = '_navmobile-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // 渲染顶部装饰头部（status-bar + 渐变 header）
  function renderHeader(el){
    const series = el.dataset.series;
    const cfg = MOBILE[series] || MOBILE.g;
    const title = el.dataset.title || '';
    const meta  = el.dataset.meta  || cfg.stamp || '';
    const icon  = el.dataset.icon  || '⚖';
    const sub   = el.dataset.sub   || '';
    const rightSlot = el.dataset.right || '';
    const ttl   = el.dataset.ttl   || title;
    const showBack = el.dataset.back !== 'false';

    // 默认行为：有 drawer 配置就显示汉堡，否则显示返回；可被 data-back / data-menu 覆写
    const hasDrawer = !!(cfg && cfg.drawer);
    const showMenu = el.dataset.menu === 'true' || (el.dataset.menu !== 'false' && hasDrawer && el.dataset.back !== 'true');
    const showBackFinal = el.dataset.back === 'true' || (el.dataset.back !== 'false' && !showMenu);

    const leftBtn = showMenu
      ? `<button class="nvm-menu" data-action="open-drawer">${ico('menu')}</button>`
      : (showBackFinal ? '<button class="nvm-back" onclick="history.back()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg></button>' : '');

    const html = `
      <div class="nvm-status"><span>9:41</span><span>🔋 100%</span></div>
      <div class="nvm-header" data-decor="${icon}"
           style="background:linear-gradient(135deg, ${cfg.primaryDeep} 0%, ${cfg.primary} 50%, ${cfg.accent2} 100%);">
        <div class="nvm-nav-row">
          ${leftBtn}
          <h1>${title}</h1>
          ${rightSlot ? `<span class="nvm-stamp">${rightSlot}</span>` : ''}
        </div>
        ${ttl !== title || sub ? `<div><div class="nvm-ttl">${ttl}</div>${sub ? `<div class="nvm-sub">${sub}</div>` : ''}</div>` : ''}
      </div>
      <div class="nvm-pc-head" style="--nvm-primary:${cfg.primary};">
        <div class="nvm-pc-icon">${icon}</div>
        <div class="nvm-pc-title">
          <strong>${ttl || title}</strong>
          ${sub ? `<span>${sub}</span>` : ''}
        </div>
        ${rightSlot ? `<div class="nvm-pc-right">${rightSlot}</div>` : ''}
      </div>
    `;
    el.outerHTML = html;
  }

  // 解析 href：data-base 前缀 + ../ 处理
  function resolveHref(href, base){
    if (!base) return href;
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('/')) return href;
    if (href.startsWith('../')) return href.replace(/^\.\.\//, '');
    return base + href;
  }

  // 渲染底部 tabbar
  function renderTabbar(el){
    const series = el.dataset.series;
    const active = el.dataset.active;
    const base   = el.dataset.base;
    const cfg = MOBILE[series];
    if (!cfg || !cfg.tabbar) { el.outerHTML = ''; return; }
    const items = cfg.tabbar.map(it => {
      const isActive = it.id === active ? ' active' : '';
      return `<a class="${isActive ? 'active' : ''}" href="${resolveHref(it.href, base)}">${ico(it.icon)}${it.label}</a>`;
    }).join('');
    el.outerHTML = `<nav class="nvm-tabbar" style="--nvm-primary:${cfg.primary};">${items}</nav>`;
  }

  // 渲染全屏抽屉 — 复用 sidebar 数据结构
  function renderDrawer(series, activeId){
    const cfg = MOBILE[series];
    if (!cfg || !cfg.drawer) return;
    if (document.querySelector('.nvm-drawer-mask')) return;  // 防重复
    const D = cfg.drawer;
    const groupsHtml = D.groups.map(g => {
      const items = g.items.map(it => {
        const isActive = it.id === activeId ? ' active' : '';
        const badge = it.badge != null
          ? `<span class="bd${it.badgeKind ? ' ' + it.badgeKind : ''}">${it.badge}</span>` : '';
        return `<a class="nvm-drawer-link${isActive}" href="${it.href}">${ico(it.icon)}<span class="nm">${it.label}</span>${badge}</a>`;
      }).join('');
      return `<div class="nvm-drawer-group">${g.name}</div>${items}`;
    }).join('');
    const html = `
      <div class="nvm-drawer-mask" data-action="close-drawer"></div>
      <aside class="nvm-drawer" style="--nvm-primary:${cfg.primary};--nvm-primary-deep:${cfg.primaryDeep};">
        <div class="nvm-drawer-head">
          <div class="nvm-drawer-avatar">${D.user.avatar}</div>
          <div class="nvm-drawer-uinfo">
            <div class="nvm-drawer-uname">${D.user.name}</div>
            <div class="nvm-drawer-uorg">${D.user.org}</div>
          </div>
          <button class="nvm-drawer-close" data-action="close-drawer">${ico('close')}</button>
        </div>
        <div class="nvm-drawer-nav">${groupsHtml}</div>
        <div class="nvm-drawer-foot">v2.6.0 · <a href="../overview.html">📋 全站导航</a></div>
      </aside>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function bindDrawerEvents(){
    document.addEventListener('click', e => {
      const t = e.target.closest('[data-action]');
      if (!t) return;
      const mask = document.querySelector('.nvm-drawer-mask');
      const drawer = document.querySelector('.nvm-drawer');
      if (t.dataset.action === 'open-drawer' && mask && drawer) {
        mask.classList.add('on'); drawer.classList.add('on');
      } else if (t.dataset.action === 'close-drawer' && mask && drawer) {
        mask.classList.remove('on'); drawer.classList.remove('on');
      } else if (t.dataset.action === 'close-sheet') {
        closeSheet();
      }
    });
  }

  // ============ 通用 Bottom-Sheet API ============
  function ensureSheet(){
    let mask = document.querySelector('.nvm-sheet-mask');
    if (mask) return mask;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="nvm-sheet-mask" data-action="close-sheet"></div>
      <div class="nvm-sheet">
        <div class="nvm-sheet-grab"></div>
        <div class="nvm-sheet-head">
          <div class="t"></div>
          <button class="x" data-action="close-sheet">×</button>
        </div>
        <div class="nvm-sheet-body"></div>
        <div class="nvm-sheet-foot"></div>
      </div>
    `);
    return document.querySelector('.nvm-sheet-mask');
  }
  function openSheet(opts){
    opts = opts || {};
    const mask = ensureSheet();
    const sheet = document.querySelector('.nvm-sheet');
    sheet.querySelector('.t').textContent = opts.title || '';
    sheet.querySelector('.nvm-sheet-body').innerHTML = opts.body || '';
    const foot = sheet.querySelector('.nvm-sheet-foot');
    foot.innerHTML = '';
    (opts.actions || []).forEach(a => {
      const el = document.createElement(a.href ? 'a' : 'button');
      el.className = a.kind || 'ghost';
      el.textContent = a.label;
      if (a.href) el.href = a.href;
      el.addEventListener('click', e => {
        if (a.onClick) a.onClick(e);
        if (a.close !== false) closeSheet();
      });
      foot.appendChild(el);
    });
    foot.style.display = (opts.actions && opts.actions.length) ? 'flex' : 'none';
    requestAnimationFrame(() => {
      mask.classList.add('on'); sheet.classList.add('on');
    });
  }
  function closeSheet(){
    const mask = document.querySelector('.nvm-sheet-mask');
    const sheet = document.querySelector('.nvm-sheet');
    if (mask) mask.classList.remove('on');
    if (sheet) sheet.classList.remove('on');
  }

  function mount(){
    injectStyles();
    // 先记录 series/active 再 render（outerHTML 会破坏原元素的 dataset）
    let drawerSeries = null, drawerActive = null;
    const headerEl = document.querySelector('#m-header, #m-tabbar, #tab-bar');
    if (headerEl) { drawerSeries = headerEl.dataset.series; drawerActive = headerEl.dataset.active; }
    document.querySelectorAll('#m-header').forEach(renderHeader);
    document.querySelectorAll('#m-tabbar, #tab-bar').forEach(renderTabbar);
    if (drawerSeries) renderDrawer(drawerSeries, drawerActive);
    bindDrawerEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.BZF_NAVMOBILE = { MOBILE, renderTabbar, openSheet, closeSheet };
})();
