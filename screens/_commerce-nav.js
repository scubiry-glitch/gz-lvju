(function(){
'use strict';
// 权益域自有导航（2026-10-02 拍板：commerce 前端「彻底自含」，工作台页不再挂共享 _nav.js）。
// 单一数据源 = VIEW_MENUS；图标与视觉词汇对齐全站 _nav.js（同套线性 SVG + 渐变侧栏 + 用户盒）。
// 权限裁剪用 window.COMMERCE.can（commerce 权限面），未登录/演示态一律全显（保静态演示基线观感）。
// 挂载：<aside id="commerce-nav" data-view="admin|merchant" data-active="模块key"></aside>
// data-active 缺省回落 body[data-section]（工作台壳页都有）。登录后自动重渲染，
// 也可手动 window.BZF_COMMERCE_NAV.refresh()。
const V='20261008-1';
const MODULES={dashboard:'经营概览',merchants:'商户管理',stores:'门店管理',staff:'核销人员',skus:'券商品',rules:'报价与分配规则',packages:'券包配置',plans:'会员方案',inventory:'库存管理',capacity:'预约产能',orders:'订单管理',coupons:'卡券发放',memberships:'会员记录',appointments:'预约管理',redemptions:'核销记录',cases:'售后工单',audit:'操作审计',exchanges:'兑换码管理',distributions:'券活动分发',stats:'运营统计',settlement:'结算账单',refunds:'退款执行',reconciliation:'对账中心'};
const ICONS={
 home:'<path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/>',
 chart:'<rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/>',
 search:'<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
 check:'<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
 star:'<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>',
 file:'<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>',
 chat:'<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
 book:'<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/>',
 user:'<path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>',
 settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33"/>',
 grid:'<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
 bank:'<path d="M3 21h18M3 10h18M5 10V6l7-3 7 3v4M6 10v11M10 10v11M14 10v11M18 10v11"/>',
 wallet:'<path d="M21 12V7H5a2 2 0 010-4h14v4"/><path d="M3 5v14a2 2 0 002 2h16v-5"/><path d="M18 12a2 2 0 100 4h4v-4z"/>',
 coin:'<circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 100 4h4a2 2 0 110 4H8M12 6v2m0 8v2"/>',
 pulse:'<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
 award:'<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
 list:'<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
 layers:'<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
 target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
 radio:'<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 010 8.49m-8.48-.01a6 6 0 010-8.49m11.31-2.82a10 10 0 010 14.14m-14.14 0a10 10 0 010-14.14"/>',
 bell:'<path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>',
 box:'<path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
 map:'<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
};
const ico=k=>'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">'+(ICONS[k]||ICONS.grid)+'</svg>';
const mod=(k,icon,perms,label)=>({id:k,label:label||MODULES[k],icon,href:'commerce-admin'+(k==='dashboard'?'':'-'+k)+'.html',perms});
const mmod=(k,icon,perms,label)=>({id:k,label:label||MODULES[k],icon,href:'commerce-merchant'+(k==='dashboard'?'':'-'+k)+'.html',perms});
const READ_A=['commerce.admin.read'],READ_M=['commerce.merchant.read'],FUND=['commerce.fund.read'];
const ENTRY=[
 {id:'consumer',label:'生活权益',icon:'wallet',href:'../juzhu-commerce.html'},
 {id:'vouchers',label:'选券页 · 用户端',icon:'search',href:'../juzhu-vouchers.html?city=贵阳'},
 {id:'hotels',label:'酒店通兑名录',icon:'map',href:'../juzhu-hotels.html?city=贵阳'},
 {id:'promoter',label:'权益推广',icon:'radio',href:'../juzhu-promoter.html'},
];
const VIEW_MENUS={
 admin:{title:'新居住 · 权益运营中心',sub:'OPERATIONS',primary:'#0f766e',deep:'#0b5d56',groups:[
  {name:'业务入口',items:[...ENTRY,{id:'merchant',label:'商户中心',icon:'home',href:'commerce-merchant.html',perms:READ_M},{id:'demo-accounts',label:'演示账号',icon:'book',href:'commerce-demo-accounts.html'}]},
  {name:'配置管理',items:[mod('merchants','bank',READ_A),mod('stores','home',READ_A),mod('staff','user',READ_A),mod('skus','box',READ_A),mod('rules','settings',READ_A),mod('packages','layers',READ_A),mod('plans','award',READ_A)]},
  {name:'履约运营',items:[mod('inventory','list',READ_A),mod('capacity','target',READ_A),mod('orders','file',READ_A,'订单与发放'),mod('appointments','bell',READ_A),mod('redemptions','check',READ_A),mod('exchanges','coin',READ_A),mod('distributions','layers',READ_A)]},
  {name:'客户与售后',items:[mod('coupons','wallet',READ_A),mod('memberships','star',READ_A),mod('cases','chat',READ_A)]},
  {name:'数据与审计',items:[mod('stats','pulse',READ_A),mod('audit','book',READ_A)]},
  {name:'结算与对账',items:[mod('settlement','coin',FUND),mod('refunds','wallet',FUND),mod('reconciliation','check',FUND),{id:'unified-settlement',label:'统一结算工作台',icon:'bank',href:'settlement-admin.html',perms:['settlement.fund.read']},{id:'settlement-statements',label:'收款方对账单',icon:'file',href:'settlement-statements.html',perms:['settlement.statement.read']},{id:'settlement-manual',label:'结算手册',icon:'book',href:'settlement-manual.html'}]},
 ]},
 merchant:{title:'新居住 · 权益商户中心',sub:'MERCHANT',primary:'#0f766e',deep:'#0b5d56',groups:[
  {name:'业务入口',items:[...ENTRY.filter(e=>e.id!=='vouchers'),{id:'admin',label:'运营概览',icon:'chart',href:'commerce-admin.html',perms:READ_A},{id:'demo-accounts',label:'演示账号',icon:'book',href:'commerce-demo-accounts.html'}]},
  {name:'商户与门店',items:[mmod('dashboard','chart',READ_M),mmod('merchants','bank',READ_M),mmod('stores','home',READ_M),mmod('staff','user',READ_M)]},
  {name:'商品与产能',items:[mmod('skus','box',READ_M),mmod('inventory','list',READ_M),mmod('capacity','target',READ_M)]},
  {name:'履约',items:[mmod('orders','file',READ_M),mmod('appointments','bell',READ_M),mmod('redemptions','check',READ_M),mmod('coupons','wallet',READ_M,'卡券台账')]},
  {name:'售后与结算',items:[mmod('cases','chat',READ_M),mmod('settlement','coin',READ_M,'应结与到账'),{id:'settlement-statements',label:'收款方对账单',icon:'file',href:'settlement-statements.html',perms:['settlement.statement.read']},{id:'settlement-manual',label:'结算手册',icon:'book',href:'settlement-manual.html'}]},
 ]},
 settlement:{title:'新居住 · 统一结算中心',sub:'SETTLEMENT',primary:'#0f766e',deep:'#0b5d56',groups:[
  {name:'结算与对账',items:[{id:'unified-settlement',label:'统一结算工作台',icon:'bank',href:'settlement-admin.html',perms:['settlement.fund.read','settlement.approval.act','settlement.policy.write','settlement.policy.review','settlement.external.import','settlement.external.review']},{id:'settlement-statements',label:'收款方对账单',icon:'file',href:'settlement-statements.html',perms:['settlement.statement.read']},{id:'settlement-manual',label:'结算手册',icon:'book',href:'settlement-manual.html'}]},
  {name:'业务入口',items:[{id:'commerce-admin',label:'权益运营中心',icon:'chart',href:'commerce-admin.html',perms:READ_A},{id:'commerce-merchant',label:'权益商户中心',icon:'home',href:'commerce-merchant.html',perms:READ_M},{id:'all-business',label:'全部业务入口',icon:'grid',href:'../overview.html'}]},
 ]},
};
const css=''
 +'.commerce-nav-side{position:sticky;top:0;align-self:start;width:100%;height:100vh;overflow-y:auto;background:linear-gradient(180deg,var(--cnv-deep,#0b5d56),var(--cnv-primary,#0f766e));color:#fff;display:flex;flex-direction:column;padding:0 0 10px;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#ffffff33 transparent}'
 +'.commerce-nav-side::-webkit-scrollbar{width:4px}.commerce-nav-side::-webkit-scrollbar-thumb{background:#ffffff33;border-radius:2px}.commerce-nav-side::-webkit-scrollbar-track{background:transparent}'
 +'.commerce-nav-brand{display:flex;align-items:center;gap:10px;padding:16px 18px 14px;border-bottom:1px solid #ffffff1f;flex-shrink:0}'
 +'.commerce-nav-logo{width:36px;height:36px;border-radius:8px;background:#ffffff2e;display:grid;place-items:center;font-weight:700;color:#fff;font-size:18px;flex-shrink:0}'
 +'.commerce-nav-bname{font-size:14px;font-weight:600;line-height:1.2}.commerce-nav-bsub{display:block;font-size:10px;opacity:.65;font-weight:400;margin-top:2px;letter-spacing:.14em}'
 +'.commerce-nav-body{flex:1;min-height:0;overflow-y:auto;padding:8px 0;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#ffffff33 transparent}'
 +'.commerce-nav-body::-webkit-scrollbar{width:4px}.commerce-nav-body::-webkit-scrollbar-thumb{background:#ffffff33;border-radius:2px}'
 +'.commerce-nav-group{font-size:11px;color:#ffffff80;padding:14px 18px 6px;letter-spacing:.5px;font-weight:500}'
 +'.commerce-nav-link{display:flex;align-items:center;gap:10px;padding:9px 18px;font-size:13px;color:#ffffffd1;text-decoration:none;border-left:3px solid transparent;transition:background .15s ease,color .15s ease}'
 +'.commerce-nav-link:hover{background:#ffffff0f;color:#fff}'
 +'.commerce-nav-link.active{background:#ffffff1a;border-left-color:#ffffffd9;color:#fff;font-weight:600}'
 +'.commerce-nav-link svg{width:16px;height:16px;flex-shrink:0}'
 +'.commerce-nav-user{display:flex;align-items:center;gap:10px;padding:12px 18px;border-top:1px solid #ffffff1f;flex-shrink:0;cursor:pointer}'
 +'.commerce-nav-user:hover{background:#ffffff0d}'
 +'.commerce-nav-avatar{width:30px;height:30px;border-radius:50%;background:#ffffff2e;display:grid;place-items:center;font-size:13px;font-weight:600;flex-shrink:0}'
 +'.commerce-nav-uinfo{min-width:0}.commerce-nav-uname{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.commerce-nav-uorg{font-size:10.5px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
 +'.commerce-nav-foot{flex-shrink:0;padding:0 18px 4px}.commerce-nav-foot a{color:#ffffffa6;font-size:11.5px;text-decoration:none;transition:color .15s ease}'
 +'.commerce-nav-foot a:hover{color:#fff}'
 +'@media(max-width:1023px){#commerce-nav,.commerce-nav-side{display:none}}'
 +'@media(prefers-reduced-motion:reduce){.commerce-nav-link,.commerce-nav-foot a,.commerce-nav-user{transition:none}}';
function injectOnce(){
 if(document.getElementById('commerce-nav-style'))return;
 const s=document.createElement('style');s.id='commerce-nav-style';s.textContent=css;document.head.appendChild(s);
}
function canShow(item){
 const perms=item.perms;if(!perms)return true;
 const C=window.BZF_SETTLEMENT||window.COMMERCE;
 if(!C||!C.identity)return true; // 未登录/演示态全显
 return perms.some(p=>C.can(p));
}
function userBox(){
 const C=window.BZF_SETTLEMENT||window.COMMERCE,me=C&&C.identity&&C.identity.account;
 if(!me)return '<div class="commerce-nav-user" style="cursor:default"><div class="commerce-nav-avatar">券</div><div class="commerce-nav-uinfo"><div class="commerce-nav-uname">权益业务中心</div><div class="commerce-nav-uorg">使用新居住账号与授权范围</div></div></div>';
 const name=me.display_name||me.login_name||('#'+(me.id||''));
 const org=(C.identity.roles||[]).map(r=>r.role_code||r).join('/')||me.principal_type||'';
 const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return '<div class="commerce-nav-user" data-cnv-logout="1" title="点击退出登录"><div class="commerce-nav-avatar">'+esc((name[0]||'?').toUpperCase())+'</div><div class="commerce-nav-uinfo"><div class="commerce-nav-uname">'+esc(name)+'</div><div class="commerce-nav-uorg">'+esc(org)+' · 退出 ↩</div></div></div>';
}
function render(el){
 const menu=VIEW_MENUS[el.dataset.view]||VIEW_MENUS.admin; // 未知 view 按 admin 兜底
 const active=el.dataset.active||document.body.dataset.section||'';
 const groups=menu.groups.map(g=>{
  const items=g.items.filter(canShow);
  if(g.items.some(it=>it.perms)&&!items.length)return ''; // 带 perms 的组裁空则整组不出
  return '<div class="commerce-nav-group">'+g.name+'</div>'+items.map(it=>
   '<a class="commerce-nav-link'+(it.id===active?' active':'')+'" href="'+it.href+'"'+(it.id===active?' aria-current="page"':'')+'>'+ico(it.icon)+'<span>'+it.label+'</span></a>'
  ).join('');
 }).join('');
 el.innerHTML='<aside class="commerce-nav-side" style="--cnv-primary:'+menu.primary+';--cnv-deep:'+menu.deep+'">'
  +'<div class="commerce-nav-brand"><div class="commerce-nav-logo">券</div><div class="commerce-nav-bname">'+menu.title+'<span class="commerce-nav-bsub">'+menu.sub+'</span></div></div>'
  +'<nav class="commerce-nav-body">'+groups+'</nav>'
  +userBox()
  +'<div class="commerce-nav-foot"><a href="../overview.html">📋 全站导航总览 →</a></div></aside>';
 el.querySelectorAll('[data-cnv-logout]').forEach(n=>{n.addEventListener('click',()=>{if(window.BZF_CONSOLE&&BZF_CONSOLE.logout)BZF_CONSOLE.logout();else location.reload();});});
 el.querySelector('.commerce-nav-link.active')?.scrollIntoView({block:'nearest'});
}
function mount(){
 injectOnce();
 document.querySelectorAll('#commerce-nav').forEach(el=>{render(el);el.dataset.commerceNavV=V;});
}
window.BZF_COMMERCE_NAV={refresh:mount,mount};
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount);else mount();
window.addEventListener('commerce-login',mount);
if(window.COMMERCE&&window.COMMERCE.ready&&window.COMMERCE.ready.then)window.COMMERCE.ready.then(mount).catch(()=>{});
})();
