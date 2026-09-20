'use strict';
const fs=require('node:fs');
const modules={dashboard:'经营概览',merchants:'商户管理',stores:'门店管理',staff:'核销人员',skus:'券商品',rules:'报价与分配规则',packages:'券包配置',plans:'会员方案',inventory:'库存管理',capacity:'预约产能',orders:'订单管理',coupons:'卡券发放',memberships:'会员记录',appointments:'预约管理',redemptions:'核销记录',cases:'售后工单',audit:'操作审计',exchanges:'兑换码管理',stats:'运营统计',settlement:'结算账单',refunds:'退款执行',reconciliation:'对账中心'};
const account='<div class="account-bar"><span id="account-name">新居住账号</span><button class="btn" id="account-login">账号登录</button><button class="btn" id="account-logout">退出</button></div>';
for(const area of ['admin','merchant'])for(const [kind,moduleTitle]of Object.entries(modules)){
 if(area==='merchant'&&['rules','packages','plans','memberships','audit','exchanges','stats'].includes(kind))continue;
 const title=area==='merchant'&&kind==='settlement'?'应结与到账':moduleTitle;
 const file='commerce-'+area+(kind==='dashboard'?'':'-'+kind)+'.html';
 fs.writeFileSync('screens/'+file,`<!doctype html>
<html lang="zh-CN" data-console-login="off"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · 新居住权益${area==='merchant'?'商户':'运营'}中心</title><link rel="stylesheet" href="../lvju-app.css"><link rel="stylesheet" href="_commerce.css"></head>
<body class="commerce-page commerce-desktop" data-commerce-view="${area}" data-section="${kind}"><div class="console"><aside id="side-nav" data-series="commerce" data-active="${kind==='dashboard'?area:'commerce-'+kind}"></aside><div class="main"><header class="appbar"><a class="bk" href="../overview.html" aria-label="返回全站总览">‹</a><div class="ttl">新居住 · 权益${area==='merchant'?'商户':'运营'}中心</div></header>${account}<nav id="commerce-tabs" class="commerce-tabs" aria-label="权益管理导航"></nav><p id="commerce-status" role="status" aria-live="polite"></p><main id="commerce-content" class="commerce-content"><section class="commerce-card wide" aria-busy="true">正在加载业务数据…</section></main></div></div><script src="_console-login.js"></script><script src="_nav.js"></script><script src="_commerce-official.js"></script><script src="_commerce-management.js?v=20260920-2"></script></body></html>\n`);
}
for(const area of ['consumer','promoter']){
 if(area==='consumer'){fs.copyFileSync('scripts/commerce/consumer-page.html','juzhu-commerce.html');continue;}
 const title=area==='consumer'?'生活权益':'权益推广';fs.writeFileSync(area==='consumer'?'juzhu-commerce.html':'juzhu-promoter.html',`<!doctype html>
<html lang="zh-CN" data-console-login="off"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${title} · 新居住频道</title><link rel="stylesheet" href="lvju-app.css"><link rel="stylesheet" href="screens/_commerce.css"></head><body class="commerce-page" data-commerce-view="${area}"><div class="app"><header class="appbar"><a class="bk" href="index.html?tab=jiazheng" aria-label="返回新居住频道">‹</a><div class="ttl">${title}<small>新居住频道 · 券包与会员</small></div></header><div class="scr">${account}<nav id="commerce-tabs" class="commerce-tabs" aria-label="权益导航"></nav><p id="commerce-status" role="status" aria-live="polite"></p><main id="commerce-content" class="commerce-content"><p>正在加载生活权益…</p></main><div class="commerce-toolbar"><a href="juzhu-commerce.html">生活权益</a><a href="juzhu-promoter.html">权益推广</a><a href="screens/commerce-merchant.html">商户中心</a></div></div></div><script src="screens/_console-login.js"></script><script src="screens/_commerce-official.js"></script><script src="screens/_commerce-customer.js"></script></body></html>\n`);
}

fs.writeFileSync('juzhu-voucher.html',fs.readFileSync('scripts/commerce/consumer-page.html','utf8').replace('<title>生活权益 · 新居住频道</title>','<title>权益详情 · 新居住频道</title>').replace('data-commerce-view="consumer"','data-commerce-view="consumer" data-product-detail="true"').replace('>生活权益<small>','>权益详情<small>'));

fs.writeFileSync('juzhu-vouchers.html',fs.readFileSync('scripts/commerce/consumer-page.html','utf8').replace('<title>生活权益 · 新居住频道</title>','<title>选券 · 新居住频道</title>').replace('data-commerce-view="consumer"','data-commerce-view="consumer" data-product-shop="true"').replace('>生活权益<small>','>选券<small>'));

fs.writeFileSync('juzhu-hotels.html',fs.readFileSync('scripts/commerce/consumer-page.html','utf8').replace('<title>生活权益 · 新居住频道</title>','<title>酒店通兑名录 · 新居住频道</title>').replace('data-commerce-view="consumer"','data-commerce-view="consumer" data-hotel-directory="true"').replace('>生活权益<small>','>酒店名录<small>'));
