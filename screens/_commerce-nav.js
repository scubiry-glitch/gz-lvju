(function(){
'use strict';
// 权益域自有导航（2026-10-02 拍板：commerce 前端「彻底自含」，工作台页不再挂共享 _nav.js）。
// 单一数据源 = VIEW_MENUS；权限裁剪用 window.COMMERCE.can（commerce 权限面），
// 未登录/演示态一律全显（与 _nav.js 同一口径，保静态演示基线观感）。
// 挂载：<aside id="commerce-nav" data-view="admin|merchant" data-active="模块key"></aside>
// data-active 缺省回落 body[data-section]（工作台壳页都有）。登录后自动重渲染，
// 也可手动 window.BZF_COMMERCE_NAV.refresh()。
const V='20261002-1';
const MODULES={dashboard:'经营概览',merchants:'商户管理',stores:'门店管理',staff:'核销人员',skus:'券商品',rules:'报价与分配规则',packages:'券包配置',plans:'会员方案',inventory:'库存管理',capacity:'预约产能',orders:'订单管理',coupons:'卡券发放',memberships:'会员记录',appointments:'预约管理',redemptions:'核销记录',cases:'售后工单',audit:'操作审计',exchanges:'兑换码管理',stats:'运营统计',settlement:'结算账单',refunds:'退款执行',reconciliation:'对账中心'};
const mod=(k,perms,label)=>({id:k,label:label||MODULES[k],href:'commerce-admin'+(k==='dashboard'?'':'-'+k)+'.html',perms});
const mmod=(k,perms,label)=>({id:k,label:label||MODULES[k],href:'commerce-merchant'+(k==='dashboard'?'':'-'+k)+'.html',perms});
const READ_A=['commerce.admin.read'],READ_M=['commerce.merchant.read'],FUND=['commerce.fund.read'];
const VIEW_MENUS={
 admin:{title:'新居住 · 权益运营中心',sub:'OPERATIONS',groups:[
  {name:'业务入口',items:[
   {id:'consumer',label:'生活权益',href:'../juzhu-commerce.html'},
   {id:'vouchers',label:'选券页 · 用户端',href:'../juzhu-vouchers.html?city=贵阳'},
   {id:'hotels',label:'酒店通兑名录',href:'../juzhu-hotels.html?city=贵阳'},
   {id:'promoter',label:'权益推广',href:'../juzhu-promoter.html'},
   {id:'merchant',label:'商户中心',href:'commerce-merchant.html',perms:READ_M},
   {id:'demo-accounts',label:'演示账号',href:'commerce-demo-accounts.html'},
  ]},
  {name:'配置管理',items:[mod('merchants',READ_A),mod('stores',READ_A),mod('staff',READ_A),mod('skus',READ_A),mod('rules',READ_A),mod('packages',READ_A),mod('plans',READ_A)]},
  {name:'履约运营',items:[mod('inventory',READ_A),mod('capacity',READ_A),mod('orders',READ_A,'订单与发放'),mod('appointments',READ_A),mod('redemptions',READ_A),mod('exchanges',READ_A)]},
  {name:'客户与售后',items:[mod('coupons',READ_A),mod('memberships',READ_A),mod('cases',READ_A)]},
  {name:'数据与审计',items:[mod('stats',READ_A),mod('audit',READ_A)]},
  {name:'结算与对账',items:[mod('settlement',FUND),mod('refunds',FUND),mod('reconciliation',FUND)]},
 ]},
 merchant:{title:'新居住 · 权益商户中心',sub:'MERCHANT',groups:[
  {name:'业务入口',items:[
   {id:'consumer',label:'生活权益',href:'../juzhu-commerce.html'},
   {id:'promoter',label:'权益推广',href:'../juzhu-promoter.html'},
   {id:'admin',label:'运营概览',href:'commerce-admin.html',perms:READ_A},
   {id:'demo-accounts',label:'演示账号',href:'commerce-demo-accounts.html'},
  ]},
  {name:'商户与门店',items:[mmod('dashboard',READ_M),mmod('merchants',READ_M),mmod('stores',READ_M),mmod('staff',READ_M)]},
  {name:'商品与产能',items:[mmod('skus',READ_M),mmod('inventory',READ_M),mmod('capacity',READ_M)]},
  {name:'履约',items:[mmod('orders',READ_M),mmod('appointments',READ_M),mmod('redemptions',READ_M),mmod('coupons',READ_M,'卡券台账')]},
  {name:'售后与结算',items:[mmod('cases',READ_M),mmod('settlement',READ_M,'应结与到账')]},
 ]},
};
const css=''
 +'.commerce-nav-side{position:sticky;top:0;align-self:start;width:100%;height:100vh;overflow:auto;background:#0b3d38;color:#e6f2f0;padding:18px 0 12px;box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#2dd4bf59 transparent}'
 +'.commerce-nav-side::-webkit-scrollbar{width:6px}.commerce-nav-side::-webkit-scrollbar-thumb{background:#2dd4bf59;border-radius:3px}.commerce-nav-side::-webkit-scrollbar-track{background:transparent}'
 +'.commerce-nav-brand{display:flex;align-items:center;gap:10px;padding:2px 18px 14px;border-bottom:1px solid #ffffff14;margin-bottom:8px}'
 +'.commerce-nav-logo{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#0f766e,#0d9488);display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-size:16px;flex-shrink:0;box-shadow:0 3px 10px #00000038,inset 0 1px 0 #ffffff2e}'
 +'.commerce-nav-bname{font-size:13.5px;font-weight:700;line-height:1.25}.commerce-nav-bsub{display:block;font-size:9.5px;letter-spacing:1.5px;color:#9fc7c1;font-weight:500}'
 +'.commerce-nav-group{padding:11px 18px 4px;font-size:10px;letter-spacing:1px;color:#8fbcb5;text-transform:uppercase}'
 +'.commerce-nav-link{display:flex;align-items:center;gap:8px;padding:7px 16px;font-size:12.5px;color:#d5eae6;text-decoration:none;border-left:3px solid transparent;transition:background-color .15s ease,padding-left .15s ease,color .15s ease}'
 +'.commerce-nav-link:hover{background:#ffffff0d;padding-left:19px;color:#fff}'
 +'.commerce-nav-link.active{background:linear-gradient(90deg,#ffffff1c,transparent 82%);border-left-color:#2dd4bf;color:#fff;font-weight:600}'
 +'.commerce-nav-foot{margin:14px 18px 0;padding-top:10px;border-top:1px solid #ffffff14}'
 +'.commerce-nav-foot a{color:#9fc7c1;font-size:11.5px;text-decoration:none;transition:color .15s ease}'
 +'.commerce-nav-foot a:hover{color:#e6f2f0}'
 +'@media(max-width:1023px){#commerce-nav,.commerce-nav-side{display:none}}'
 +'@media(prefers-reduced-motion:reduce){.commerce-nav-link,.commerce-nav-link:hover,.commerce-nav-foot a{transition:none}}';
function injectOnce(){
 if(document.getElementById('commerce-nav-style'))return;
 const s=document.createElement('style');s.id='commerce-nav-style';s.textContent=css;document.head.appendChild(s);
}
function canShow(item){
 const perms=item.perms;if(!perms)return true;
 const C=window.COMMERCE;
 if(!C||!C.identity)return true; // 未登录/演示态全显
 return perms.some(p=>C.can(p));
}
function render(el){
 const menu=VIEW_MENUS[el.dataset.view]||VIEW_MENUS.admin; // 未知 view 按 admin 兜底
 const active=el.dataset.active||document.body.dataset.section||'';
 const groups=menu.groups.map(g=>{
  const items=g.items.filter(canShow);
  if(g.items.some(it=>it.perms)&&!items.length)return ''; // 带 perms 的组裁空则整组不出
  return '<div class="commerce-nav-group">'+g.name+'</div>'+items.map(it=>
   '<a class="commerce-nav-link'+(it.id===active?' active':'')+'" href="'+it.href+'"'+(it.id===active?' aria-current="page"':'')+'>'+it.label+'</a>'
  ).join('');
 }).join('');
 el.innerHTML='<aside class="commerce-nav-side"><div class="commerce-nav-brand"><div class="commerce-nav-logo">券</div>'
  +'<div class="commerce-nav-bname">'+menu.title+'<span class="commerce-nav-bsub">'+menu.sub+'</span></div></div>'
  +'<nav>'+groups+'</nav>'
  +'<div class="commerce-nav-foot"><a href="../overview.html">📋 全站导航总览 →</a></div></aside>';
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
