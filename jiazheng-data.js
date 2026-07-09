/* ===========================================
   居住服务·家政频道 共享数据（mock）
   真实数据从 /api/juzhu/jz/* 拉取
   =========================================== */
window.JZ_DATA = (function(){

  // 4 大类配置
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

  // 商家池（每类 5 家）
  var VENDORS = {
    cleaning: [
      { id:1, name:'春晖家政', logo:'🏠', rating:4.6, review_count:3566, badges:['whitelist','backcheck','top10'],
        rank:{type:'city',label:'同城销量榜第 8'}, live:false, start_price:79.8, unit:'2小时', hours:'08:00-22:00',
        address:'西湖区文三路', dist:'2.4km', products:[
          { id:101, title:'日常保洁 2小时', sub:'上门除尘 · 死无死角', area:'≤50㎡', earliest:'今天 18:00',
            price:79.8, original:200, discount:'4折', unit:'2小时', sales:53000, rating:4.7,
            tags:['每个角落都仔细清洁','死无死角','专业工具'] },
          { id:102, title:'深度清洁 2小时', sub:'3人团队 · 含厨卫去污', area:'≤50㎡', earliest:'明天 09:00',
            price:99.8, original:200, discount:'5折', unit:'2小时', sales:16000, rating:4.8,
            tags:['专业团队','深度去污','含厨卫'] },
          { id:103, title:'日常保洁 3小时', sub:'含厨房/卫生间', area:'51-90㎡', earliest:'今天 19:00',
            price:139.8, original:300, discount:'4.6折', unit:'3小时', sales:8000, rating:4.6,
            tags:['三小时更彻底','含厨卫'] }
        ]},
      { id:2, name:'美团自营·保洁', logo:'🛡', rating:4.8, review_count:12800, badges:['whitelist','insurance','commitment'],
        rank:{type:'platform',label:'平台自营'}, live:true, start_price:59.8, unit:'2小时', hours:'07:00-23:00',
        address:'全国连锁', dist:'0km', products:[
          { id:201, title:'日常保洁 2小时', sub:'美团直营 · 急速上门', area:'≤60㎡', earliest:'今天 18:00',
            price:59.8, original:180, discount:'3.3折', unit:'2小时', sales:128000, rating:4.8,
            tags:['急速上门','不满意重做','百万保障'] },
          { id:202, title:'深度清洁 3小时', sub:'3人组 · 含玻璃/油烟机', area:'≤80㎡', earliest:'明天 08:00',
            price:159.8, original:380, discount:'4.2折', unit:'3小时', sales:42000, rating:4.9,
            tags:['3人组','含玻璃'] }
        ]},
      { id:3, name:'杭州鑫禧', logo:'🏡', rating:4.5, review_count:2180, badges:['backcheck','commitment'],
        rank:null, live:false, start_price:69.8, unit:'2小时', hours:'09:00-21:00',
        address:'拱墅区运河路', dist:'3.1km', products:[
          { id:301, title:'日常保洁 2小时', sub:'本地团队', area:'≤50㎡', earliest:'明天 09:00',
            price:69.8, original:160, discount:'4.3折', unit:'2小时', sales:15000, rating:4.5,
            tags:['本地团队'] }
        ]},
      { id:4, name:'洁先锋', logo:'🧼', rating:4.3, review_count:980, badges:['whitelist'],
        rank:null, live:false, start_price:49.8, unit:'2小时', hours:'08:00-20:00',
        address:'滨江区江南大道', dist:'5.2km', products:[
          { id:401, title:'日常保洁 2小时', sub:'经济实惠', area:'≤50㎡', earliest:'今天 19:00',
            price:49.8, original:150, discount:'3.3折', unit:'2小时', sales:6800, rating:4.3,
            tags:['经济实惠'] }
        ]},
      { id:5, name:'永盛家政', logo:'🏆', rating:4.7, review_count:5420, badges:['whitelist','backcheck','top10'],
        rank:{type:'district',label:'滨江销量榜第 1'}, live:false, start_price:89.8, unit:'2小时', hours:'07:00-22:00',
        address:'滨江区星耀城', dist:'4.6km', products:[
          { id:501, title:'日常保洁 2小时', sub:'金牌服务者', area:'≤60㎡', earliest:'今天 18:00',
            price:89.8, original:240, discount:'3.7折', unit:'2小时', sales:31000, rating:4.7,
            tags:['金牌服务者','专业工具'] },
          { id:502, title:'深度清洁 4小时', sub:'3人团队 · 含全屋', area:'≤120㎡', earliest:'明天 09:00',
            price:268.0, original:480, discount:'5.6折', unit:'4小时', sales:12000, rating:4.8,
            tags:['3人团队','含全屋','深度去污'] }
        ]}
    ],
    repair: [
      { id:11, name:'快修家电', logo:'🔌', rating:4.6, review_count:2300, badges:['whitelist','backcheck'],
        rank:{type:'district',label:'家电维修口碑第 1'}, live:false, start_price:89, unit:'次', hours:'07:00-22:00',
        address:'上城区庆春路', dist:'1.8km', products:[
          { id:1101, title:'空调维修', sub:'不制冷/漏水/异响', area:'', earliest:'30分钟内',
            price:89, original:200, discount:'4.5折', unit:'次', sales:8200, rating:4.6,
            tags:['30分钟上门','原厂配件','90天质保'] }
        ]}
    ],
    moving: [
      { id:21, name:'蚂蚁搬家', logo:'🚚', rating:4.7, review_count:5600, badges:['whitelist','backcheck','top10'],
        rank:{type:'city',label:'同城销量榜第 2'}, live:false, start_price:398, unit:'车次', hours:'06:00-22:00',
        address:'下城区东新路', dist:'3.5km', products:[
          { id:2101, title:'居民搬家 同城', sub:'金杯车 · 2名师傅', area:'', earliest:'今天 19:00',
            price:398, original:680, discount:'5.8折', unit:'车次', sales:23000, rating:4.7,
            tags:['金杯车','2名师傅'] }
        ]}
    ],
    nanny: [
      { id:31, name:'阿姨来了', logo:'👶', rating:4.8, review_count:8800, badges:['whitelist','backcheck','insurance'],
        rank:{type:'city',label:'同城口碑第 1'}, live:false, start_price:8800, unit:'月', hours:'住家',
        address:'全国连锁', dist:'0km', products:[
          { id:3101, title:'住家育儿嫂', sub:'3年以上经验 · 持证', area:'', earliest:'5日内',
            price:8800, original:12000, discount:'7.3折', unit:'月', sales:5200, rating:4.8,
            tags:['持证','3年经验','健康证'] }
        ]}
    ]
  };

  // 服务者池
  var WORKERS = [
    { id:1, name:'陈建国', avatar:'👨', level:'L4', credit:88, tags:['细致','主动','准时'], rating:4.9, completed:2317, years:5, certs:['id_card','health','skill','insurance'], online:true, distance:2.4, vendor_id:1 },
    { id:2, name:'杨秀芳', avatar:'👩', level:'L4', credit:92, tags:['准时','周到','经验丰富'], rating:4.8, completed:1820, years:6, certs:['id_card','health','skill','insurance'], online:true, distance:3.1, vendor_id:5 },
    { id:3, name:'王志强', avatar:'👨', level:'L3', credit:78, tags:['专业','稳重'], rating:4.6, completed:920, years:3, certs:['id_card','health','skill'], online:true, distance:1.8, vendor_id:1 },
    { id:4, name:'刘海燕', avatar:'👩', level:'L3', credit:80, tags:['热情','耐心'], rating:4.7, completed:1280, years:4, certs:['id_card','health','skill'], online:false, distance:5.2, vendor_id:2 }
  ];

  // 订单（localStorage）
  var ORDER_KEY = 'bzf_orders';

  function getOrders(){
    try { return JSON.parse(localStorage.getItem(ORDER_KEY) || '[]'); } catch(e) { return []; }
  }
  function saveOrders(list){
    localStorage.setItem(ORDER_KEY, JSON.stringify(list));
  }
  function newOrderId(){
    var n = (parseInt(localStorage.getItem('bzf_order_seq') || '0', 10) || 0) + 1;
    localStorage.setItem('bzf_order_seq', String(n));
    return 'WO-2026-' + String(80000 + n);
  }

  function getCat(id){ return CATS[id]; }
  function getVendors(type){ return VENDORS[type] || []; }
  function getVendor(type, id){
    var list = VENDORS[type] || [];
    for (var i=0; i<list.length; i++) if (list[i].id == id) return list[i];
    return null;
  }
  function getProduct(type, vendorId, productId){
    var v = getVendor(type, vendorId);
    if (!v) return null;
    for (var i=0; i<v.products.length; i++) if (v.products[i].id == productId) return v.products[i];
    return null;
  }
  function getWorkers(){ return WORKERS; }
  function getWorker(id){
    for (var i=0; i<WORKERS.length; i++) if (WORKERS[i].id == id) return WORKERS[i];
    return null;
  }

  return {
    CATS: CATS, VENDORS: VENDORS, WORKERS: WORKERS,
    getCat: getCat, getVendors: getVendors, getVendor: getVendor, getProduct: getProduct,
    getWorkers: getWorkers, getWorker: getWorker,
    ORDER_KEY: ORDER_KEY, getOrders: getOrders, saveOrders: saveOrders, newOrderId: newOrderId
  };
})();
