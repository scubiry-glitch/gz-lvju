/* _jzapi.js · 家政工单 API 总线（前后端分离，SQLite 为唯一数据源）
 * 页面通过本模块读写 /api/juzhu/jiazheng/*，不再使用 localStorage 造数。
 *
 * 【数据源边界 · 参见 CLAUDE.md 规则 8/9】
 *   权威数据源 = SQLite（juzhu/juzhu.db），经 juzhu/server.py 暴露。
 *   本总线（家政工单闭环）与 screens/_orderbus.js（报修 · localStorage `bzf_orders`）
 *   并行、不混用：报修走 _orderbus.js，家政走本文件，二者不共享 key、不合并。
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

  var ICON = { '保洁': '🧹', '维修': '🔧', '搬家': '📦', '保姆': '👶', '家政': '✨' };

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
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || data.message || ('HTTP ' + r.status));
        return data;
      });
    });
  }

  function authHeaders() {
    return { Authorization: 'Bearer ' + apiKey() };
  }

  function normalizeItem(o) {
    if (!o) return o;
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
    var headers = params.phone ? {} : authHeaders();
    return fetchJSON(url, { headers: headers }).then(function (res) {
      return (res.items || []).map(normalizeItem);
    });
  }

  function stats() {
    return fetchJSON('/api/juzhu/jiazheng/orders/stats', { headers: authHeaders() })
      .then(function (res) { return res.stats || {}; });
  }

  function get(id) {
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id))
      .then(function (res) { return normalizeItem(res.order); });
  }

  function byStatus(st) {
    var wanted = Array.isArray(st) ? st : [st];
    return list({ status: wanted.join(','), pay_status: 'paid', limit: 100 });
  }

  function all() {
    return list({ limit: 100, pay_status: 'paid' });
  }

  function create(payload) {
    return fetchJSON('/api/juzhu/jiazheng/orders', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    }).then(function (res) {
      notify();
      return normalizeItem(res.order);
    });
  }

  function pay(id, payMethod) {
    return fetchJSON('/api/juzhu/jiazheng/orders/' + encodeURIComponent(id) + '/pay', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ pay_method: payMethod || '贝壳支付' })
    }).then(function (res) {
      notify();
      return normalizeItem(res.order);
    });
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
  // 换皮主体名词；不参与换皮，仅决定"X · 新居住频道"里的 X。
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

  function applyRegionChrome(map) {
    map = map || {};
    if (map.titleSub) {
      var el = typeof map.titleSub === 'string' ? document.querySelector(map.titleSub) : map.titleSub;
      if (el) el.textContent = regionCity() + ' · 新居住频道';
    }
    if (map.loc) {
      var loc = typeof map.loc === 'string' ? document.querySelector(map.loc) : map.loc;
      if (loc) loc.textContent = regionCity();
    }
    if (map.docTitle) {
      document.title = map.docTitle.replace('{city}', regionCity()).replace('{op}', regionOperator());
    }
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

  // 模拟用户 id（后期替换为真实获取用户 id 的代码）
  var USER_KEY = 'jz_demo_user_id';
  var DEMO_USER_ID = 'demo_user_001';

  function userId() {
    try { return localStorage.getItem(USER_KEY) || DEMO_USER_ID; } catch (e) { return DEMO_USER_ID; }
  }

  function setUserId(id) {
    try { if (id) localStorage.setItem(USER_KEY, id); } catch (e) {}
    return userId();
  }

  window.BZF_JZ = {
    STATUS: STATUS,
    ICON: ICON,
    apiKey: apiKey,
    setApiKey: setApiKey,
    esc: esc,
    list: list,
    all: all,
    byStatus: byStatus,
    get: get,
    stats: stats,
    create: create,
    pay: pay,
    dispatch: dispatch,
    advance: advance,
    rate: rate,
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
    applyRegionChrome: applyRegionChrome
  };
})();
