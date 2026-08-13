/* ===========================================
   居住服务·家政频道 共享数据 · API 适配层（纯转发，无本地 mock）
   -------------------------------------------
   【数据源边界 · 参见 CLAUDE.md 规则 9】
   · 权威数据源 = SQLite（juzhu/juzhu.db），经 juzhu/server.py 的
     /api/juzhu/jz/*（jz_subcategories / jz_vendors / jz_products / jz_workers）
     与 /api/juzhu/jiazheng/*（jz_skus + jz_orders）暴露。
   · 本文件的 window.JZ_DATA 只是老消费页（jiazheng-list / jiazheng-vendor /
     jiazheng-booking / jiazheng-payment / jiazheng-order）对上述接口的薄适配层，
     失败即 reject，由页面自行呈现失败态；不含任何兜底假数据。
   · 工单闭环（下单/派单/推进/评价）另走 screens/_jzapi.js（/api/juzhu/jiazheng/*）。
   · 父类目名（保洁/维修/搬家/保姆）是频道 UI 术语，非业务数据，仅作标题映射。
   =========================================== */
window.JZ_DATA = (function(){
  var API = '/api/juzhu/jz';
  // 父类目术语映射：仅页面标题文案用（目录/商家/服务者数据一律走 API）
  var CAT_NAMES = { cleaning:'保洁', repair:'维修', moving:'搬家', nanny:'保姆' };

  // ===== HTTP 包装 =====
  function getJson(path){
    return fetch(path).then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function postJson(path, body){
    return fetch(path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body || {})
    }).then(function(r){
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // ====== 公开方法（异步，全部直连 API；失败即 reject，由页面呈现失败态） ======
  return {
    API_BASE: API,

    getCat: function(id){
      // 父类目术语映射（仅标题文案），业务数据仍走 API
      return { name: CAT_NAMES[id] || id };
    },
    getCategories: function(type){
      return getJson(API + '/categories?type=' + type).then(function(d){ return d.list; });
    },
    getVendors: function(type){
      return getJson(API + '/vendors?type=' + type).then(function(d){ return d.list; });
    },
    getVendor: function(type, id){
      return getJson(API + '/vendors/' + id).then(function(d){ return d; });
    },
    getProduct: function(type, vendorId, productId){
      return getJson(API + '/products/' + productId).then(function(d){ return d; });
    },
    getWorkers: function(vendorId){
      return getJson(API + '/workers?vendor_id=' + vendorId).then(function(d){ return d.list; });
    },

    // ====== 订单（落服务器） ======
    createOrder: function(data){
      return postJson(API + '/orders', data);
    },
    getOrder: function(oid){
      return getJson(API + '/orders/' + oid);
    },
    dispatchOrder: function(oid, workerId){
      return postJson(API + '/orders/' + oid + '/dispatch', {worker_id: workerId});
    },
    updateOrderStatus: function(oid, status){
      return postJson(API + '/orders/' + oid + '/status', {status: status});
    },
    rateOrder: function(oid, score, tags, text){
      return postJson(API + '/orders/' + oid + '/rate', {
        score: score, tags: tags, text: text
      });
    }
  };
})();
