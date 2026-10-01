/* _jzapi.js · 家政工单 API 总线（前后端分离，MySQL 为唯一数据源）
 * 页面通过本模块读写 /api/juzhu/jiazheng/*，不再使用 localStorage 造数。
 *
 * 【数据源边界 · 参见 CLAUDE.md 规则 8/9】
 *   权威数据源 = MySQL，经 app.js 暴露。
 *   2026-09-22 并轨：原 screens/_orderbus.js（报修 · localStorage `bzf_orders`）已退役，
 *   报修/旅居客工单统一走本总线的 repairs 系列（createRepair/listRepairs/repairGet/repairCancel，
 *   服务端 /api/juzhu/jiazheng/repairs*，phone+source 双过滤），与家政订单同一张 jz_orders。
 *   家政"目录/SKU 配置"的前端适配 + 离线 mock 见根目录 jiazheng-data.js。
 */
(function () {
  'use strict';

  var API_KEY_STORAGE = 'JUZHU_API_KEY';
  // 禁止内嵌历史默认密钥；须由运维/本地在 localStorage 或部署配置写入
  var DEFAULT_KEY = '';
  var CHANGE_EVT = 'bzf-jz-orders-change';
  var POLL_MS = 4000;

  var STATUS = {
    pending:    { c: '待派单', worker: '待接单', admin: '待派',   pct: 15,  cls: 'pending',  step: 0 },
    dispatched: { c: '已派单', worker: '待接单', admin: '已派单', pct: 35,  cls: 'progress', step: 1 },
    accepted:   { c: '处理中', worker: '待出发', admin: '已接单', pct: 55,  cls: 'progress', step: 2 },
    serving:    { c: '服务中', worker: '服务中', admin: '服务中', pct: 80,  cls: 'progress', step: 3 },
    done:       { c: '待评价', worker: '已完成', admin: '已完结', pct: 100, cls: 'done',     step: 4 },
    rated:      { c: '已评价', worker: '已评价', admin: '已评价', pct: 100, cls: 'done',     step: 5 }
  };

  var ICON = {
    '保洁': '🧹', '维修': '🔧', '搬家': '📦', '保姆': '👶', '家政': '✨',
    '报修': '🔧', '管家': '🛎', '管家服务': '🛎', '送物': '📦', '家电安装': '🔌',
    '除螨消杀': '🧴', '接送': '🚗', '其他': '🧰',
    '电讯服务': '📱', '财险服务': '🛡', '消费金融': '💳', '健康养老': '🏥',
    '居家维护': '🏠', '资产服务': '🏦', '二手回收': '♻️'
  };

  var _pollTimer = null;
  var _listeners = [];

  function apiKey() {
    return (localStorage.getItem(API_KEY_STORAGE) || DEFAULT_KEY).trim();
  }

  function setApiKey(key) {
    if (key) localStorage.setItem(API_KEY_STORAGE, key.trim());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function notify() {
    window.dispatchEvent(new CustomEvent(CHANGE_EVT));
    _listeners.forEach(function (fn) { try { fn(); } catch (e) {} });
  }

  function fetchJSON(url, options) {
    options = options || {};
    options.headers = options.headers || {};
    if (!options.headers['Content-Type'] && options.body) {
      options.headers['Content-Type'] = 'application/json';
    }
    return fetch(url, options).then(function (r) {
      if (r.status === 401 && window.BZF_BEIKE_LOGIN && typeof BZF_BEIKE_LOGIN.handleUnauthorized === 'function') {
        try { BZF_BEIKE_LOGIN.handleUnauthorized(); } catch (e) {}
      }
      return r.json().then(function (data) {
        if (!r.ok) {
          var error = new Error(data.error || data.message || ('HTTP ' + r.status));
          error.status = r.status; error.code = data.code; error.data = data;
          throw error;
        }
        return data;
      });
    });
  }

  var SESSION_STORAGE = 'BZF_SESSION_TOKEN';

  // 账号中心会话 token（/api/auth/login 签发）。存在时优先于 API Key：
  // S/C 端登录用户带本人会话，管理台仍可用 localStorage JUZHU_API_KEY。
  function sessionToken() {
    return (localStorage.getItem(SESSION_STORAGE) || '').trim();
  }

  function setSessionToken(token) {
    if (token) localStorage.setItem(SESSION_STORAGE, String(token).trim());
    else localStorage.removeItem(SESSION_STORAGE);
    notify();
  }

  function authHeaders() {
    // C 端 App：优先走 _beike-login（X-Lianjia-Token 为主，BJZ 可选）
    try {
      if (typeof window !== 'undefined' && window.BZF_BEIKE_LOGIN &&
          typeof window.BZF_BEIKE_LOGIN.authHeaders === 'function') {
        var bh = window.BZF_BEIKE_LOGIN.authHeaders() || {};
        if (bh['X-Lianjia-Token'] || bh.Authorization) return bh;
      }
    } catch (e) {}
    var t = sessionToken();
    if (t) return { Authorization: 'Bearer ' + t };
    var k = apiKey();
    return k ? { Authorization: 'Bearer ' + k } : {};
  }

  function normalizeItem(o) {
    if (!o) return o;
    for(var pair of [['worker','worker_json'],['rating','rating_json'],['log','log_json']]){if(!o[pair[0]]&&o[pair[1]]){try{o[pair[0]]=typeof o[pair[1]]==='string'?JSON.parse(o[pair[1]]):o[pair[1]];}catch{}}}
    o.category=o.category||o.type;
    o.expectTime = o.expectTime || o.expect_time || '';
    o.createdLabel = o.createdLabel || (o.created_at || '').replace('T', ' ').replace('Z', '').slice(0, 16);
    o.icon = o.icon || ICON[o.type] || '✨';
    o.live = true;
    return o;
  }

  function list(params) {
    params = params || {};
    var qs = new URLSearchParams();
    Object.keys(params).forEach(function (k) {
      if (params[k] != null && params[k] !== '') qs.set(k, params[k]);
    });
    var url = '/api/juzhu/jiazheng/orders' + (qs.toString() ? '?' + qs : '');
    return fetchJSON(url, { headers: authHeaders() }).then(function (res) {
      return (res.items || []).map(normalizeItem);
    });
  }

  function stats() {
    return fetchJSON('/api/juzhu/jiazheng/orders/stats', { headers: authHeaders() })
      .then(function (res) { return res.stats || res; });
  }

  function get(id) {
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id), { headers: authHeaders() })
      .then(function (res) { return normalizeItem(res.order || res); });
  }

  function byStatus(st) {
    var wanted = Array.isArray(st) ? st : [st];
    return list({ status: wanted.join(','), pay_status: 'paid,not_required', limit: 100 });
  }

  function all() {
    return list({ limit: 100, pay_status: 'paid,not_required' });
  }

  function create(payload) {
    payload = payload || {};
    var headers = authHeaders();
    // Legacy callers had no request key. Let the server deduplicate their full
    // body and advance its generation after the original order is terminal.
    // The current checkout supplies an explicit key and retains it on retry.
    if (payload.idempotency_key) headers['Idempotency-Key'] = payload.idempotency_key;
    return fetchJSON('/api/juzhu/jiazheng/orders', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(payload)
    }).then(function (res) {
      notify();
      return normalizeItem(res.order || res);
    });
  }

  var memoryRequestKeys = Object.create(null), cashierLoading;
  function requestKey(scope, renew) {
    if (window.BZF_CASHIER) return BZF_CASHIER.requestKey('jiazheng:' + scope, !!renew);
    var key = 'jz.request.' + scope, value = memoryRequestKeys[key];
    try { value = sessionStorage.getItem(key) || value; } catch (_) {}
    if (!value || renew) {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') value = window.crypto.randomUUID();
      else if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        var random = new Uint8Array(16); window.crypto.getRandomValues(random);
        value = Array.from(random, function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
      } else value = 'jz-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      memoryRequestKeys[key] = value;
      try { sessionStorage.setItem(key, value); } catch (_) {}
    }
    return value;
  }

  function paymentResult(res) {
    res = res || {};
    var order = normalizeItem(res.order);
    var payment = Object.assign({}, order || {}, res);
    if (window.BZF_CASHIER && BZF_CASHIER.normalize) payment = BZF_CASHIER.normalize(payment);
    else {
      payment.pay_status = payment.pay_status || payment.payStatus;
      payment.cashier_url = payment.cashier_url || payment.cashierUrl;
      payment.cashier_type = payment.cashier_type || payment.cashierType;
    }
    if (!payment.order_pay_status && order) payment.order_pay_status = order.status === 'cancelled' ? 'closed' : order.pay_status;
    return payment;
  }
  function cashier() {
    if (window.BZF_CASHIER) return Promise.resolve(window.BZF_CASHIER);
    if (!cashierLoading) cashierLoading = new Promise(function (resolve, reject) {
      var script = document.createElement('script'); script.src = '/screens/_cashier.js?v=2';
      script.onload = function () { resolve(window.BZF_CASHIER); };
      script.onerror = function () { cashierLoading = null; reject(new Error('收银台组件加载失败，请刷新后重试')); };
      document.head.appendChild(script);
    });
    return cashierLoading;
  }
  async function legacyPayment(id, payment) {
    var sdk = await cashier();
    function confirmed(p) {
      var order = p.order || {};
      if (sdk.orderStatus) return sdk.orderStatus(p, order) === 'paid';
      if (order.status === 'cancelled' || ['refunding', 'refunded', 'partially_refunded'].indexOf(order.refund_status) >= 0
        || ['refunding', 'refunded', 'partially_refunded'].indexOf(order.pay_status) >= 0) return false;
      return p.order_pay_status === 'paid' || (!p.order_pay_status && p.pay_status === 'paid');
    }
    async function paidOrder(p) {
      // Payment replies can precede cancellation/refund projection. Always
      // read the latest business order before an old success continuation.
      var order = await get(id);
      if (!confirmed({ order: order, order_pay_status: order.pay_status })) throw new Error('尚未确认支付成功，请从订单页查看结果');
      return normalizeItem(order);
    }
    if (confirmed(payment)) return paidOrder(payment);
    if (!payment.cashier_url) payment = await sdk.waitForCashier(function () { return paymentStatus(id); });
    if (confirmed(payment)) return paidOrder(payment);
    if (!payment.cashier_url) throw new Error('支付结果确认中，请到订单页查看，请勿重复下单');
    if (String(payment.cashier_type || sdk.cashierType()) === '1' && sdk.ensureAppBridge) await sdk.ensureAppBridge();
    return new Promise(function (resolve, reject) {
      var opened = sdk.open(payment, {
        onCancel: function () { reject(new Error('支付已取消，可从原订单继续付款')); },
        onResult: function () {
          paymentStatus(id).then(function (p) {
            if (!confirmed(p)) throw new Error('尚未确认支付成功，请从订单页查看结果');
            return paidOrder(p);
          }).then(resolve, reject);
        }
      });
      if (!opened) reject(new Error('订单当前不可付款，请从订单页查看结果'));
    });
  }
  function payIntent(id, renew, payMethod) {
    renew = renew === true;
    var cashierType = window.BZF_CASHIER ? BZF_CASHIER.cashierType()
      : (window.__BZF_IS_BEIKE_APP || /beike|lianjia/i.test(navigator.userAgent || '') ? '1' : '2');
    var headers = authHeaders(); headers['Idempotency-Key'] = requestKey('pay:' + id + ':' + cashierType, renew);
    var body = { cashier_type: cashierType };
    if (payMethod) body.pay_method = payMethod;
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id) + '/pay', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (res) {
      res = paymentResult(res);
      if (res.next_action === 'new_attempt' && !renew) return payIntent(id, true, payMethod);
      notify();
      return res;
    });
  }
  // Original public method: its optional second argument was a payment label,
  // and success continuations assume a completed payment. Intent creation has
  // a separate name so omitted/undefined/null labels keep that old contract.
  function pay(id, payMethod) {
    return payIntent(id, false, payMethod || '贝壳支付').then(function (payment) { return legacyPayment(id, payment); });
  }
  function paymentStatus(id) {
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id) + '/payment', { headers: authHeaders() }).then(paymentResult);
  }
  function cancelOrder(id, reason) {
    var headers = authHeaders(); headers['Idempotency-Key'] = requestKey('cancel:' + id);
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id) + '/cancel', { method: 'POST', headers: headers,
      body: JSON.stringify({ reason: reason || '用户取消' }) }).then(function (res) { notify(); return res; });
  }

  function dispatch(id, worker) {
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id) + '/dispatch', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(worker ? { worker: worker } : {})
    }).then(function (res) {
      notify();
      return normalizeItem(res.order);
    });
  }

  function advance(id) {
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id) + '/advance', {
      method: 'POST',
      headers: authHeaders()
    }).then(function (res) {
      notify();
      return normalizeItem(res.order);
    });
  }

  function rate(id, rating) {
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id) + '/rate', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        score: rating.score,
        tags: rating.tags || [],
        text: rating.text || ''
      })
    }).then(function (res) {
      notify();
      return normalizeItem(res.order);
    });
  }

  // ===== 报修单（旅居客 App 提交，写入同一张 jz_orders；读接口 phone 必填 + source 限定）=====
  // type 为中文报修类型字面量（报修/保洁/管家/送物…），服务端 type_label 原样透传。
  function createRepair(payload) {
    return fetchJSON('/api/juzhu/jiazheng/repairs', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload || {})
    }).then(function (res) {
      notify();
      return normalizeItem(res.order);
    });
  }

  function listRepairs(phone) {
    var url = '/api/juzhu/jiazheng/repairs?phone=' + encodeURIComponent(phone || '');
    return fetchJSON(url, { headers: authHeaders() }).then(function (res) {
      return (res.items || []).map(normalizeItem);
    });
  }

  function repairGet(id, phone) {
    var url = '/api/juzhu/jiazheng/repairs/' + encodeURIComponent(id) + '?phone=' + encodeURIComponent(phone || '');
    return fetchJSON(url, { headers: authHeaders() }).then(function (res) {
      return normalizeItem(res.order || res);
    });
  }

  function repairCancel(id, phone) {
    return fetchJSON('/api/juzhu/jiazheng/repairs/' + encodeURIComponent(id) + '?phone=' + encodeURIComponent(phone || ''), {
      method: 'DELETE',
      headers: authHeaders()
    }).then(function (res) {
      notify();
      return res;
    });
  }

  function categories() {
    var qs = new URLSearchParams();
    var city = regionCity();
    if (city) qs.set('city', city);
    var url = '/api/juzhu/jiazheng/categories' + (qs.toString() ? '?' + qs : '');
    return fetchJSON(url).then(function (r) { return r.items || []; });
  }

  function skus(params) {
    params = params || {};
    var qs = new URLSearchParams();
    if (params.category) qs.set('category', params.category);
    if (params.q) qs.set('q', params.q);
    var city = regionCity();
    if (city) qs.set('city', city);
    var url = '/api/juzhu/jiazheng/skus' + (qs.toString() ? '?' + qs : '');
    return fetchJSON(url).then(function (r) { return r.items || []; });
  }

  function sku(slug, vendorId) {
    var u = '/api/juzhu/jiazheng/skus/' + encodeURIComponent(slug);
    var qs = new URLSearchParams();
    if (vendorId) qs.set('vendor', vendorId);
    var city = regionCity();
    if (city) qs.set('city', city);
    if (qs.toString()) u += '?' + qs.toString();
    return fetchJSON(u);
  }

  function workers() {
    return fetchJSON('/api/juzhu/jiazheng/workers').then(function (r) { return r.items || []; });
  }

  function onChange(fn) {
    _listeners.push(fn);
    window.addEventListener(CHANGE_EVT, fn);
    if (!_pollTimer) {
      _pollTimer = setInterval(notify, POLL_MS);
    }
  }

  var CITY_KEY = 'bzf_jz_city';
  var CITY_EVT = 'bzf-jz-city';

  // 家政频道 · 展示用「省 / 市」位置模型（多省市演示）。
  // 规则 7 边界：此处是频道展示地名（省级/市级两档可选），非 _region.js 的 relabel
  // 换皮主体名词；不参与换皮，仅决定"X · 频道名称"里的 X。
  // 一个"位置"可以是省名（省级）或市名（市级）；regionCity() 存/取任一档。
  var CITY_TREE = [
    { prov: '辽宁', cities: ['沈阳', '大连', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口'] },
    { prov: '江苏', cities: ['南京', '苏州', '无锡', '常州', '镇江', '扬州', '泰州', '南通', '盐城', '徐州'] },
    { prov: '四川', cities: ['成都', '绵阳', '德阳', '南充', '宜宾', '自贡', '泸州', '乐山'] },
    { prov: '贵州', cities: ['贵阳', '遵义', '六盘水', '安顺', '毕节', '铜仁'] }
  ];
  var DEFAULT_CITY = '沈阳';

  function regionCapital() {
    var R = window.BZF_REGION;
    return (R && R.prov && R.prov.capital) ? R.prov.capital : '沈阳';
  }

  // 省/市树（只读副本），供切换器渲染级联
  function regionCityTree() {
    return CITY_TREE.map(function (n) { return { prov: n.prov, cities: n.cities.slice() }; });
  }
  function regionProvinces() {
    return CITY_TREE.map(function (n) { return n.prov; });
  }
  function citiesOf(prov) {
    for (var i = 0; i < CITY_TREE.length; i++) {
      if (CITY_TREE[i].prov === prov) return CITY_TREE[i].cities.slice();
    }
    return [];
  }
  // 位置所属省：loc 为省名则返回自身，为市名则返回其省，未知返回 null
  function provinceOf(loc) {
    for (var i = 0; i < CITY_TREE.length; i++) {
      if (CITY_TREE[i].prov === loc) return CITY_TREE[i].prov;
      if (CITY_TREE[i].cities.indexOf(loc) >= 0) return CITY_TREE[i].prov;
    }
    return null;
  }
  function isProvince(loc) {
    return regionProvinces().indexOf(loc) >= 0;
  }
  // 所有可选位置（省级 + 市级）扁平表，用于校验存储值
  function regionCities() {
    var out = [];
    CITY_TREE.forEach(function (n) {
      out.push(n.prov);
      n.cities.forEach(function (c) { out.push(c); });
    });
    return out;
  }

  // 默认位置：优先 DEFAULT_CITY（沈阳），不在树内则退回首个省会/省
  function defaultCity() {
    if (regionCities().indexOf(DEFAULT_CITY) >= 0) return DEFAULT_CITY;
    return regionProvinces()[0] || regionCapital();
  }

  // URL ?city= 参数优先（多城市直链：regionCity() 只读，不写存储；无参数时行为不变）
  function urlCity() {
    try {
      var c = new URLSearchParams(location.search).get('city');
      if (c && regionCities().indexOf(c) >= 0) return c;
    } catch (e) {}
    return null;
  }

  function regionCity() {
    var u = urlCity();
    if (u) return u;
    var stored = null;
    try { stored = localStorage.getItem(CITY_KEY); } catch (e) {}
    if (stored && regionCities().indexOf(stored) >= 0) return stored;
    return defaultCity();
  }

  // 接受省级或市级位置；回默认位置时清空存储
  function setRegionCity(loc) {
    if (!loc || regionCities().indexOf(loc) < 0) return regionCity();
    try {
      if (loc === defaultCity()) localStorage.removeItem(CITY_KEY);
      else localStorage.setItem(CITY_KEY, loc);
    } catch (e) {}
    try { window.dispatchEvent(new CustomEvent(CITY_EVT, { detail: { city: loc } })); } catch (e) {}
    return loc;
  }

  function onCityChange(fn) {
    window.addEventListener(CITY_EVT, function (e) { fn((e.detail && e.detail.city) || regionCity()); });
    window.addEventListener('storage', function (e) {
      if (e.key === CITY_KEY) fn(regionCity());
    });
  }

  // 为 URL 添加 city 查询参数（链式传递城市）
  function chainCity(url) {
    var city = regionCity();
    if (!city) return url;
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'city=' + encodeURIComponent(city);
  }

  function regionOperator() {
    var R = window.BZF_REGION;
    return (R && R.operator) ? R.operator : '贝壳';
  }

  function regionDeptStem() {
    var R = window.BZF_REGION;
    return (R && R.dept && R.dept.stem) ? R.dept.stem : '住建';
  }

  function regionBankName() {
    var R = window.BZF_REGION;
    return (R && R.bank && R.bank.name) ? R.bank.name : '江苏银行';
  }

  var DEFAULT_CHANNEL_NAME = '新居住频道';
  var _channelName = DEFAULT_CHANNEL_NAME;
  var _channelPromise = null;

  function channelBrand(raw) {
    var name = String(raw == null ? '' : raw).trim() || DEFAULT_CHANNEL_NAME;
    var short = name.replace(/(频道|专区)$/, '') || name;
    return { name: name, short: short, zone: short + '专区' };
  }

  function currentBrand() {
    if (window.JUZHU && typeof JUZHU.channelBrand === 'function' && JUZHU.getSettings && JUZHU.getSettings()) {
      return JUZHU.channelBrand();
    }
    return channelBrand(_channelName);
  }

  function loadChannelBrand() {
    if (window.JUZHU && typeof JUZHU.loadSettings === 'function') {
      return JUZHU.loadSettings().then(function() { return currentBrand(); });
    }
    if (_channelPromise) return _channelPromise;
    _channelPromise = fetch('/api/juzhu/settings').then(function(r) { return r.json(); }).then(function(s) {
      if (s && s.channel_name) _channelName = String(s.channel_name).trim() || DEFAULT_CHANNEL_NAME;
      return channelBrand(_channelName);
    }).catch(function() { return channelBrand(_channelName); });
    return _channelPromise;
  }

  function applyRegionChrome(map) {
    map = map || {};
    function paint(brand) {
      brand = brand || currentBrand();
      if (map.titleSub) {
        var el = typeof map.titleSub === 'string' ? document.querySelector(map.titleSub) : map.titleSub;
        if (el) el.textContent = regionCity() + ' · ' + brand.name;
      }
      if (map.loc) {
        var loc = typeof map.loc === 'string' ? document.querySelector(map.loc) : map.loc;
        if (loc) loc.textContent = regionCity();
      }
      if (map.docTitle) {
        document.title = map.docTitle.replace('{city}', regionCity()).replace('{op}', regionOperator());
      }
    }
    paint(currentBrand());
    loadChannelBrand().then(paint);
  }

  // ===== 演示模式开关 =====
  // 跨角色/开发导线（如"看中台工单池"）标记 class="demo-only"，仅在演示模式下可见，
  // 与首页"方案切换/预设切换"同属演示态内容，避免污染顾客视角。
  // 开关：?demo=1/0 或 localStorage bzf_demo；默认关闭（顾客视角）。
  var DEMO_KEY = 'bzf_demo';
  function isDemo() {
    try {
      var q = new URLSearchParams(location.search).get('demo');
      if (q != null) localStorage.setItem(DEMO_KEY, (q === '1' || q === 'on') ? '1' : '0');
      return localStorage.getItem(DEMO_KEY) === '1';
    } catch (e) { return false; }
  }
  function setDemo(on) {
    try { localStorage.setItem(DEMO_KEY, on ? '1' : '0'); } catch (e) {}
    applyDemoMode();
  }
  function applyDemoMode() {
    try {
      if (!document.getElementById('bzf-demo-css')) {
        var s = document.createElement('style');
        s.id = 'bzf-demo-css';
        s.textContent = 'html:not(.demo-on) .demo-only{display:none !important;}';
        (document.head || document.documentElement).appendChild(s);
      }
      document.documentElement.classList.toggle('demo-on', isDemo());
    } catch (e) {}
  }
  applyDemoMode();

  // 用户 id：App 内经 jsbridge3（window.JsBridgeV3）获取真实值后 setUserId 写入；
  // 获取不到时返回 null，不兜底演示 id（未登录态由页面自行处理：隐藏模块/提示登录）。
  var USER_KEY = 'jz_demo_user_id';

  function userId() {
    try { return localStorage.getItem(USER_KEY) || null; } catch (e) { return null; }
  }

  function setUserId(id) {
    try {
      if (id) localStorage.setItem(USER_KEY, id);
      else localStorage.removeItem(USER_KEY); // 清空残留的旧演示用户
    } catch (e) {}
    return userId();
  }

  // 从 App 注入的 jsbridge3 同步解析用户身份：成功写入并返回 userId，失败/无注入清空返回 null。
  // 需页面先引入根目录 jsbridgesdk.js（挂载 window.JsBridgeV3）。
  function bridgeUserId() {
    var uid = '';
    try {
      if (window.JsBridgeV3) {
        JsBridgeV3.init({ preventDomainSetting: true }); // v3 需业务主动 init；token 前端透传，不种主域 cookie
        var u = JsBridgeV3.getUserInfo() || {};
        uid = u.userId || u.user_id || u.uid || u.ucid || '';
      }
    } catch (e) { /* 非 App 环境无注入 */ }
    setUserId(uid ? String(uid) : '');
    return uid ? String(uid) : null;
  }

  // ===== C 端统一身份入口（异步）：测试环境模拟登录 / 生产 jsbridge3 真实登录 =====
  // 环境开关来自后端 /api/juzhu/settings 的 mock_login（服务端由 JUZHU_ENV 驱动，生产恒 false）：
  //   mock_login=true（测试/本地）：不经 jsbridge3，直接使用模拟用户（共享订单池，便于联调）。
  //     模拟 id 优先级：URL ?mock_uid=xxx > localStorage（含 BZF_JZ.setUserId 手动设置）> 默认 demo_user_001。
  //   mock_login=false（生产/拉取失败）：走 bridgeUserId() 真实登录；取不到即未登录，
  //     严禁模拟用户兜底（未登录态由页面处理：隐藏模块/提示登录）。
  var MOCK_USER_DEFAULT = 'demo_user_001';
  var _settingsEnvP = null;

  function envSettings() {
    if (window.JUZHU && typeof JUZHU.loadSettings === 'function') return JUZHU.loadSettings();
    if (_settingsEnvP) return _settingsEnvP;
    _settingsEnvP = fetch('/api/juzhu/settings')
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; }); // 失败视为非 test：按生产逻辑走，不模拟兜底
    return _settingsEnvP;
  }

  function ensureUserId() {
    return envSettings().then(function (s) {
      if (s && s.mock_login) {
        var q = '';
        try { q = String(new URLSearchParams(location.search).get('mock_uid') || '').trim(); } catch (e) {}
        if (q) return setUserId(q);           // URL 切换模拟身份（跨页面用 chainMockUser 传递）
        return userId() || setUserId(MOCK_USER_DEFAULT); // 保持已设身份（含手动 setUserId），无则落默认
      }
      return bridgeUserId();
    });
  }

  // 为 URL 追加 mock_uid 查询参数（模拟身份跨页链式传递，语义同 chainCity）
  function chainMockUser(url) {
    var uid = userId();
    if (!uid) return url;
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    return url + sep + 'mock_uid=' + encodeURIComponent(uid);
  }

  // 家政分类配色「单一数据源」：列表页 hero/poster/标签/按钮 与 详情页 hero/底部按钮 共用。
  // 改分类色只改这里，页面不得再各写一份。moving 取《搬家服务原型说明》蓝犀牛 × 贝壳 的
  // 频道蓝（#1678ff 系）；repair 让出原来的蓝、改用搬家腾出的橙。
  var CAT_THEME = {
    cleaning:         { brand: '#0f766e', brand2: '#14b8a6', deep: '#0b5d56' },
    repair:           { brand: '#ea580c', brand2: '#fb923c', deep: '#bf4b13' },
    moving:           { brand: '#1678ff', brand2: '#168FFA', deep: '#0E61FF' },
    nanny:            { brand: '#7c3aed', brand2: '#a78bfa', deep: '#4d2579' },
    telecom:          { brand: '#1d4e89', brand2: '#60a5fa', deep: '#123a66' },
    insurance:        { brand: '#8c6224', brand2: '#c9a24b', deep: '#6b4a1a' },
    consumer_finance: { brand: '#0f1a4d', brand2: '#8ba3e0', deep: '#0a1028' },
    health_care:      { brand: '#0e7490', brand2: '#67e8f9', deep: '#0a5568' },
    home_maintain:    { brand: '#3f6212', brand2: '#a3e635', deep: '#2d4a0c' },
    asset:            { brand: '#1e3a5f', brand2: '#93c5fd', deep: '#152a45' },
    recycle:          { brand: '#166534', brand2: '#86efac', deep: '#0f4a26' },
    community:        { brand: '#6d28d9', brand2: '#c4b5fd', deep: '#4c1d95' }
  };

  function catTheme(type) {
    return CAT_THEME[type] || CAT_THEME.cleaning;
  }

  // 把分类色写成 CSS 变量，供页面元素按 var(--cat-brand) 消费；element 为空时只返回主题对象。
  //   --cat-brand / -brand-2 / -deep  主色三档
  //   --cat-soft   12% 品牌色**透明**混合（叠在白卡上作浅底，别用在深色 hero 上，会隐形）
  //   --cat-tint   **不透明**浅底（白底 8% 品牌色），用于本身就是浅色底的容器，不会透出下层
  function applyCatTheme(element, type) {
    var t = catTheme(type);
    if (element && element.style && element.style.setProperty) {
      element.style.setProperty('--cat-brand', t.brand);
      element.style.setProperty('--cat-brand-2', t.brand2);
      element.style.setProperty('--cat-deep', t.deep);
      element.style.setProperty('--cat-soft', 'color-mix(in oklab,' + t.brand + ' 12%, transparent)');
      element.style.setProperty('--cat-tint', 'color-mix(in oklab,' + t.brand + ' 8%, #fff)');
    }
    return t;
  }

  window.BZF_JZ = {
    STATUS: STATUS,
    ORDER: Object.keys(STATUS),
    ICON: ICON,
    CAT_THEME: CAT_THEME,
    catTheme: catTheme,
    applyCatTheme: applyCatTheme,
    apiKey: apiKey,
    setApiKey: setApiKey,
    sessionToken: sessionToken,
    setSessionToken: setSessionToken,
    esc: esc,
    list: list,
    all: all,
    byStatus: byStatus,
    get: get,
    stats: stats,
    create: create,
    pay: pay,
    payIntent: payIntent,
    paymentStatus: paymentStatus,
    cancelOrder: cancelOrder,
    requestKey: requestKey,
    authHeaders: authHeaders,
    dispatch: dispatch,
    advance: advance,
    rate: rate,
    createRepair: createRepair,
    listRepairs: listRepairs,
    repairGet: repairGet,
    repairCancel: repairCancel,
    categories: categories,
    skus: skus,
    sku: sku,
    workers: workers,
    isDemo: isDemo,
    setDemo: setDemo,
    applyDemoMode: applyDemoMode,
    onChange: onChange,
    notify: notify,
    regionCity: regionCity,
    urlCity: urlCity,
    regionCapital: regionCapital,
    userId: userId,
    setUserId: setUserId,
    bridgeUserId: bridgeUserId,
    ensureUserId: ensureUserId,
    chainMockUser: chainMockUser,
    regionCities: regionCities,
    regionCityTree: regionCityTree,
    regionProvinces: regionProvinces,
    citiesOf: citiesOf,
    provinceOf: provinceOf,
    isProvince: isProvince,
    setRegionCity: setRegionCity,
    onCityChange: onCityChange,
    chainCity: chainCity,
    regionOperator: regionOperator,
    regionDeptStem: regionDeptStem,
    regionBankName: regionBankName,
    channelBrand: currentBrand,
    channelName: function() { return currentBrand().name; },
    channelShort: function() { return currentBrand().short; },
    channelZone: function() { return currentBrand().zone; },
    loadChannelBrand: loadChannelBrand,
    applyRegionChrome: applyRegionChrome
  };
})();
