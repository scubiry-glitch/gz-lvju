/* ===========================================
   居住服务·家政频道 共享数据 + API 适配层
   优先从后端 /api/juzhu/jz/* 拉取，失败时回落到本地 mock
   =========================================== */
window.JZ_DATA = (function(){
  var API = '/api/juzhu/jz';
  var MOCK = (function(){
    // ===== 4 大类配置 =====
    var CATS = {
      cleaning: { id:'cleaning', name:'保洁', color:'cleaning', slogan:'随叫随到 · 不满意重做', subs:[
        { id:'daily',    name:'日常保洁', icon:'🧹' },
        { id:'deep',     name:'深度清洁', icon:'✨' },
        { id:'initial',  name:'开荒保洁', icon:'🏠' },
        { id:'window',   name:'玻璃清洗', icon:'🪟' },
        { id:'hood',     name:'油烟机清洗', icon:'💨' },
        { id:'organize', name:'收纳整理', icon:'📦' }
      ]},
      repair:   { id:'repair',   name:'维修', color:'repair', slogan:'急速上门 · 30分钟响应', subs:[
        { id:'home_appliance', name:'家电维修', icon:'🔌' },
        { id:'plumb',          name:'管道疏通', icon:'🚿' },
        { id:'light',          name:'灯具电路', icon:'💡' },
        { id:'doorwin',        name:'门窗维修', icon:'🚪' },
        { id:'ac',             name:'空调维修', icon:'❄️' },
        { id:'water',          name:'水管维修', icon:'💧' }
      ]},
      moving:   { id:'moving',   name:'搬家', color:'moving', slogan:'专业搬运 · 全程不重', subs:[
        { id:'local',     name:'居民搬家', icon:'🚚' },
        { id:'long',      name:'长途搬家', icon:'🛣' },
        { id:'piano',     name:'钢琴搬运', icon:'🎹' },
        { id:'enterprise',name:'企业搬迁', icon:'🏢' },
        { id:'japanese',  name:'日式搬家', icon:'🍱' },
        { id:'cargo',     name:'搬货上下楼', icon:'📦' }
      ]},
      nanny:    { id:'nanny',    name:'保姆', color:'nanny', slogan:'持证上岗 · 100%背调', subs:[
        { id:'live_in',   name:'住家保姆', icon:'🏡' },
        { id:'day_shift', name:'白班保姆', icon:'☀️' },
        { id:'hourly',    name:'钟点工', icon:'⏱' },
        { id:'maternity', name:'月嫂', icon:'🤱' },
        { id:'yuesao',    name:'住家育儿嫂', icon:'👶' },
        { id:'elderly',   name:'养老护理', icon:'🧓' }
      ]}
    };

    var VENDORS = {
      cleaning: [
        { id:1, name:'春晖家政', logo:'🏠', rating:4.6, review_count:3566, badges:['whitelist','backcheck','top10'],
          rank:{type:'city',label:'同城销量榜第 8'}, live:false, start_price:79.8, unit:'2小时', hours:'08:00-22:00',
          address:'西湖区文三路', dist:'2.4km', products:[
            { id:101, title:'日常保洁 2小时', sub:'上门除尘 · 死无死角', area:'≤50㎡', earliest:'今天 18:00',
              price:79.8, original:200, discount:'4折', unit:'2小时', sales:53000, rating:4.7,
              tags:['每个角落都仔细清洁','死无死角','专业工具'] }
          ]},
        { id:2, name:'美团自营·保洁', logo:'🛡', rating:4.8, review_count:12800, badges:['whitelist','insurance','commitment'],
          rank:{type:'platform',label:'平台自营'}, live:true, start_price:59.8, unit:'2小时', hours:'07:00-23:00',
          address:'全国连锁', dist:'0km', products:[
            { id:201, title:'日常保洁 2小时', sub:'美团直营 · 急速上门', area:'≤60㎡', earliest:'今天 18:00',
              price:59.8, original:180, discount:'3.3折', unit:'2小时', sales:128000, rating:4.8,
              tags:['急速上门','不满意重做','百万保障'] }
          ]}
      ]
    };

    var WORKERS = [
      { id:1, name:'陈建国', avatar:'👨', level:'L4', credit:88, tags:['细致','主动','准时'], rating:4.9, completed:2317, years:5, certs:['id_card','health','skill','insurance'], online:true, distance:2.4, vendor_id:1 }
    ];

    return { CATS: CATS, VENDORS: VENDORS, WORKERS: WORKERS };
  })();

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

  // ====== 公开方法（异步） ======
  // 失败时返回 mock
  function fallback(fn, mockFn){
    return fn().catch(function(){
      console.warn('JZ_DATA: API failed, using mock');
      return mockFn();
    });
  }

  return {
    API_BASE: API,
    useMock: false,  // 标记当前是否用 mock

    getCat: function(id){
      // CATS 始终从 mock 取（量小且稳定）
      return MOCK.CATS[id];
    },
    getCategories: function(type){
      return fallback(
        function(){ return getJson(API + '/categories?type=' + type).then(function(d){ return d.list; }); },
        function(){ return (MOCK.CATS[type] && MOCK.CATS[type].subs) || []; }
      );
    },
    getVendors: function(type){
      return fallback(
        function(){ return getJson(API + '/vendors?type=' + type).then(function(d){ return d.list; }); },
        function(){ return MOCK.VENDORS[type] || []; }
      );
    },
    getVendor: function(type, id){
      return fallback(
        function(){ return getJson(API + '/vendors/' + id).then(function(d){ return d; }); },
        function(){
          var list = MOCK.VENDORS[type] || [];
          for (var i=0; i<list.length; i++) if (list[i].id == id) return list[i];
          return null;
        }
      );
    },
    getProduct: function(type, vendorId, productId){
      return fallback(
        function(){ return getJson(API + '/products/' + productId).then(function(d){ return d; }); },
        function(){
          var v = MOCK.VENDORS[type] ? (MOCK.VENDORS[type].find(function(x){return x.id==vendorId;})) : null;
          if (!v) return null;
          return v.products.find(function(p){return p.id==productId;}) || null;
        }
      );
    },
    getWorkers: function(vendorId){
      return fallback(
        function(){ return getJson(API + '/workers?vendor_id=' + vendorId).then(function(d){ return d.list; }); },
        function(){
          return MOCK.WORKERS.filter(function(w){return w.vendor_id == vendorId;});
        }
      );
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
