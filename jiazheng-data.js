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
          rank:{type:'city',label:'沈阳销量榜第 8'}, live:false, start_price:79.8, unit:'2小时', hours:'08:00-22:00',
          address:'和平区中华路', dist:'2.4km', products:[
            { id:101, title:'日常保洁 2小时', sub:'上门除尘 · 死无死角', area:'≤50㎡', earliest:'今天 18:00',
              price:79.8, original:200, discount:'4折', unit:'2小时', sales:53000, rating:4.7,
              tags:['每个角落都仔细清洁','死无死角','专业工具'] },
            { id:102, title:'深度清洁 2小时', sub:'3人团队 · 含厨卫去污', area:'≤50㎡', earliest:'明天 09:00',
              price:99.8, original:200, discount:'5折', unit:'2小时', sales:16000, rating:4.8,
              tags:['专业团队','深度去污'] }
          ]},
        { id:2, name:'美团自营·保洁', logo:'🛡', rating:4.8, review_count:12800, badges:['whitelist','insurance','commitment'],
          rank:{type:'platform',label:'平台自营'}, live:true, start_price:59.8, unit:'2小时', hours:'07:00-23:00',
          address:'沈河区青年大街', dist:'0.8km', products:[
            { id:201, title:'日常保洁 2小时', sub:'美团直营 · 急速上门', area:'≤60㎡', earliest:'今天 18:00',
              price:59.8, original:180, discount:'3.3折', unit:'2小时', sales:128000, rating:4.8,
              tags:['急速上门','不满意重做','百万保障'] }
          ]},
        { id:5, name:'永盛家政', logo:'🏆', rating:4.7, review_count:5420, badges:['whitelist','backcheck','top10'],
          rank:{type:'district',label:'浑南销量榜第 1'}, live:false, start_price:89.8, unit:'2小时', hours:'07:00-22:00',
          address:'浑南区星耀城', dist:'4.6km', products:[
            { id:501, title:'日常保洁 2小时', sub:'金牌服务者 · 专业工具', area:'≤60㎡', earliest:'今天 18:00',
              price:89.8, original:240, discount:'3.7折', unit:'2小时', sales:31000, rating:4.7,
              tags:['金牌服务者','专业工具'] }
          ]}
      ],
      repair: [
        { id:11, name:'快修家电', logo:'🔌', rating:4.6, review_count:2300, badges:['whitelist','backcheck'],
          rank:{type:'district',label:'家电维修口碑第 1'}, live:false, start_price:89, unit:'次', hours:'07:00-22:00',
          address:'大东区东边街', dist:'1.8km', products:[
            { id:1102, title:'管道疏通', sub:'30分钟上门 · 不通不收费', earliest:'30分钟内',
              price:99, original:220, discount:'4.5折', sales:5600, rating:4.7, tags:['30分钟上门','不通不收费'] },
            { id:1105, title:'空调清洗', sub:'挂机/柜机 拆装深度', earliest:'今天 19:00',
              price:89, original:200, discount:'4.5折', sales:9100, rating:4.6, tags:['高温蒸汽','拆装深度'] }
          ]}
      ],
      moving: [
        { id:21, name:'蚂蚁搬家', logo:'🚚', rating:4.7, review_count:5600, badges:['whitelist','backcheck','top10'],
          rank:{type:'city',label:'沈阳销量榜第 2'}, live:false, start_price:398, unit:'车次', hours:'06:00-22:00',
          address:'和平区太原街', dist:'3.5km', products:[
            { id:2101, title:'居民搬家 同城', sub:'金杯车 · 2名师傅', earliest:'今天 19:00',
              price:398, original:680, discount:'5.8折', sales:23000, rating:4.7, tags:['金杯车','2名师傅'] }
          ]}
      ],
      nanny: [
        { id:31, name:'阿姨来了', logo:'👶', rating:4.8, review_count:8800, badges:['whitelist','backcheck','insurance'],
          rank:{type:'city',label:'沈阳口碑第 1'}, live:false, start_price:8800, unit:'月', hours:'住家',
          address:'沈河区中街', dist:'0km', products:[
            { id:3102, title:'月嫂 26天', sub:'5年以上经验 · 三甲护', earliest:'30日内',
              price:12800, original:18000, discount:'7.1折', sales:2100, rating:4.9, tags:['持证','三甲护'] },
            { id:3101, title:'住家育儿嫂', sub:'3年以上经验 · 持证', earliest:'5日内',
              price:8800, original:12000, discount:'7.3折', sales:5200, rating:4.8, tags:['持证','3年经验'] }
          ]}
      ]
    };

    var WORKERS = [
      { id:101, vendor_id:1, name:'陈建国', avatar:'👨', level:'L4', credit:88, tags:['细致','主动','准时','日常保洁'], rating:4.9, completed:2317, years:5, certs:['id_card','health','skill','insurance'], whitelist_id:2401, online:true, distance:2.4 },
      { id:102, vendor_id:1, name:'杨秀芳', avatar:'👩', level:'L4', credit:92, tags:['周到','经验丰富','深度清洁'], rating:4.8, completed:1820, years:6, certs:['id_card','health','skill','insurance'], whitelist_id:2402, online:true, distance:3.1 },
      { id:103, vendor_id:1, name:'李明', avatar:'👨', level:'L3', credit:78, tags:['稳重','开荒保洁'], rating:4.6, completed:920, years:3, certs:['id_card','health','skill'], online:false, distance:4.2 },
      { id:201, vendor_id:2, name:'张美玲', avatar:'👩', level:'L5', credit:95, tags:['平台金牌','极速上门'], rating:4.9, completed:4102, years:7, certs:['id_card','health','skill','insurance'], whitelist_id:2403, online:true, distance:0.8 },
      { id:202, vendor_id:2, name:'赵丽', avatar:'👩', level:'L4', credit:90, tags:['专业工具','玻璃清洗'], rating:4.8, completed:2680, years:5, certs:['id_card','health','skill','insurance'], online:true, distance:1.2 },
      { id:501, vendor_id:5, name:'周洁', avatar:'👩', level:'L5', credit:94, tags:['金牌服务者','深度清洁','团队长'], rating:4.9, completed:3560, years:8, certs:['id_card','health','skill','insurance'], online:true, distance:4.6 },
      { id:502, vendor_id:5, name:'吴敏', avatar:'👩', level:'L4', credit:86, tags:['专业工具','细致'], rating:4.7, completed:1980, years:5, certs:['id_card','health','skill','insurance'], online:true, distance:3.9 },
      { id:1101, vendor_id:11, name:'赵德明', avatar:'👨', level:'L5', credit:91, tags:['持证电工','30分钟响应','灯具电路'], rating:4.8, completed:1680, years:9, certs:['id_card','health','skill','insurance'], whitelist_id:2411, online:true, distance:1.8 },
      { id:1102, vendor_id:11, name:'孙海波', avatar:'👨', level:'L4', credit:85, tags:['管道疏通','不通不收费'], rating:4.7, completed:1420, years:6, certs:['id_card','health','skill','insurance'], whitelist_id:2412, online:true, distance:2.2 },
      { id:1103, vendor_id:11, name:'李建军', avatar:'👨', level:'L4', credit:83, tags:['家电维修','空调清洗'], rating:4.6, completed:980, years:5, certs:['id_card','health','skill'], online:false, distance:3.0 },
      { id:2101, vendor_id:21, name:'刘师傅', avatar:'👨', level:'L4', credit:87, tags:['居民搬家','队长','准时到达'], rating:4.8, completed:1260, years:8, certs:['id_card','health','skill','insurance'], online:true, distance:3.5 },
      { id:2103, vendor_id:21, name:'王师傅', avatar:'👨', level:'L5', credit:93, tags:['钢琴搬运','专业团队'], rating:4.9, completed:380, years:10, certs:['id_card','health','skill','insurance'], online:false, distance:5.2 },
      { id:3101, vendor_id:31, name:'王淑芬', avatar:'👩', level:'L6', credit:96, tags:['金牌月嫂','医护背景','26天套餐'], rating:4.9, completed:286, years:12, certs:['id_card','health','skill','insurance'], whitelist_id:2431, online:true, distance:0 },
      { id:3102, vendor_id:31, name:'李春华', avatar:'👩', level:'L5', credit:92, tags:['住家育儿嫂','辅食早教'], rating:4.8, completed:412, years:8, certs:['id_card','health','skill','insurance'], online:true, distance:0 },
      { id:3103, vendor_id:31, name:'张桂英', avatar:'👩', level:'L5', credit:90, tags:['月嫂','催乳师','42天套餐'], rating:4.9, completed:198, years:10, certs:['id_card','health','skill','insurance'], online:false, distance:0 },
      { id:3104, vendor_id:31, name:'陈阿姨', avatar:'👩', level:'L4', credit:85, tags:['钟点工','做饭保洁'], rating:4.7, completed:860, years:6, certs:['id_card','health','skill'], online:true, distance:0 }
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

  // ===== 本地订单 mock（静态 http.server 无 POST API 时使用） ======
  var ORDER_KEY = 'jz_orders';
  var ORDER_SEQ_KEY = 'jz_order_seq';

  function loadOrders(){
    try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); }
    catch (e) { return []; }
  }
  function saveOrders(list){
    localStorage.setItem(ORDER_KEY, JSON.stringify(list));
  }
  function findMockVendor(vendorId){
    var found = null;
    Object.keys(MOCK.VENDORS).forEach(function(t){
      (MOCK.VENDORS[t] || []).forEach(function(v){
        if (v.id == vendorId) found = v;
      });
    });
    return found;
  }
  function enrichMockOrder(order){
    if (!order) return order;
    if (order.worker_id && !order.worker) {
      var w = MOCK.WORKERS.find(function(x){ return x.id == order.worker_id; });
      if (w) {
        order.worker = window.JZ_CERTS ? JZ_CERTS.enrichWorker(Object.assign({}, w)) : Object.assign({}, w);
      }
    }
    if (order.vendor_id && !order.vendor_platform_certs) {
      var v = findMockVendor(order.vendor_id);
      if (v && window.JZ_CERTS) {
        v = JZ_CERTS.enrichVendor(JSON.parse(JSON.stringify(v)));
        order.vendor_platform_certs = v.platform_certs;
        order.vendor_no = v.vendor_no;
      }
    }
    return order;
  }
  function mockCreateOrder(data){
    var seq = parseInt(localStorage.getItem(ORDER_SEQ_KEY) || '80000', 10) + 1;
    localStorage.setItem(ORDER_SEQ_KEY, String(seq));
    var vendor = findMockVendor(data.vendor_id);
    var product = vendor ? (vendor.products || []).find(function(p){ return p.id == data.product_id; }) : null;
    var now = new Date().toISOString();
    var order = {
      id: 'WO-2026-' + seq,
      type: data.type || (vendor && vendor.type) || 'cleaning',
      vendor_id: data.vendor_id,
      product_id: data.product_id,
      vendor_name: vendor ? vendor.name : '',
      vendor_logo: vendor ? vendor.logo : '',
      product_title: product ? product.title : '',
      product_sub: product ? (product.subtitle || product.sub || '') : '',
      product_price: product ? product.price : data.fee,
      address: data.address || '',
      phone: data.phone || '',
      scheduled_at: data.scheduled_at || '',
      fee: data.fee != null ? data.fee : (product ? product.price : 0),
      status: 'pending',
      source: 'jz',
      created_at: now,
      updated_at: now
    };
    var list = loadOrders();
    list.unshift(order);
    saveOrders(list);
    return { ok: true, order: order };
  }
  function mockGetOrder(oid){
    var order = loadOrders().find(function(o){ return o.id === oid; });
    return enrichMockOrder(order ? Object.assign({}, order) : null);
  }
  function mockPatchOrder(oid, patch){
    var list = loadOrders();
    var i = list.findIndex(function(o){ return o.id === oid; });
    if (i < 0) return { error: 'order not found' };
    Object.assign(list[i], patch, { updated_at: new Date().toISOString() });
    saveOrders(list);
    return { ok: true, order: enrichMockOrder(Object.assign({}, list[i])) };
  }

  function orderFallback(apiFn, mockFn){
    return apiFn().catch(function(err){
      console.warn('JZ_DATA: order API failed, using localStorage mock', err && err.message);
      return mockFn();
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
        function(){
          return (MOCK.VENDORS[type] || []).map(function(v){
            return window.JZ_CERTS ? JZ_CERTS.enrichVendor(JSON.parse(JSON.stringify(v))) : v;
          });
        }
      );
    },
    getVendor: function(type, id){
      return fallback(
        function(){ return getJson(API + '/vendors/' + id).then(function(d){ return d; }); },
        function(){
          var list = MOCK.VENDORS[type] || [];
          for (var i=0; i<list.length; i++) {
            if (list[i].id == id) {
              var v = JSON.parse(JSON.stringify(list[i]));
              v.workers = MOCK.WORKERS.filter(function(w){ return w.vendor_id == id; });
              if (window.JZ_CERTS) {
                v = JZ_CERTS.enrichVendor(v);
                v.workers = v.workers.map(JZ_CERTS.enrichWorker);
              }
              return v;
            }
          }
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
          var list = MOCK.WORKERS.filter(function(w){return w.vendor_id == vendorId;});
          return window.JZ_CERTS ? list.map(JZ_CERTS.enrichWorker) : list;
        }
      );
    },

    // ====== 订单（优先 API，静态预览回落 localStorage） ======
    createOrder: function(data){
      return orderFallback(
        function(){ return postJson(API + '/orders', data); },
        function(){ return mockCreateOrder(data); }
      );
    },
    getOrder: function(oid){
      return orderFallback(
        function(){ return getJson(API + '/orders/' + oid); },
        function(){ return mockGetOrder(oid); }
      );
    },
    dispatchOrder: function(oid, workerId){
      return orderFallback(
        function(){ return postJson(API + '/orders/' + oid + '/dispatch', { worker_id: workerId }); },
        function(){
          var patch = { status: 'dispatched' };
          if (workerId) patch.worker_id = workerId;
          else {
            var online = MOCK.WORKERS.filter(function(w){ return w.online; });
            if (online.length) patch.worker_id = online[0].id;
          }
          return mockPatchOrder(oid, patch);
        }
      );
    },
    updateOrderStatus: function(oid, status){
      return orderFallback(
        function(){ return postJson(API + '/orders/' + oid + '/status', { status: status }); },
        function(){ return mockPatchOrder(oid, { status: status }); }
      );
    },
    rateOrder: function(oid, score, tags, text){
      return orderFallback(
        function(){
          return postJson(API + '/orders/' + oid + '/rate', { score: score, tags: tags, text: text });
        },
        function(){
          return mockPatchOrder(oid, {
            status: 'rated',
            rating: { score: score, tags: tags, text: text, created_at: new Date().toISOString() }
          });
        }
      );
    }
  };
})();
