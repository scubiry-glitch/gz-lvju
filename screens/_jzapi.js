/* _jzapi.js · 家政工单 API 总线（前后端分离，SQLite 为唯一数据源）
 * 页面通过本模块读写 /api/juzhu/jiazheng/*，不再使用 localStorage 造数。
 */
(function () {
  'use strict';

  var API_KEY_STORAGE = 'JUZHU_API_KEY';
  var DEFAULT_KEY = 'dev-juzhu-key';
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
    return fetchJSON('/api/juzhu/jiazheng/categories').then(function (r) { return r.items || []; });
  }

  function skus(params) {
    params = params || {};
    var qs = new URLSearchParams();
    if (params.category) qs.set('category', params.category);
    if (params.q) qs.set('q', params.q);
    var url = '/api/juzhu/jiazheng/skus' + (qs.toString() ? '?' + qs : '');
    return fetchJSON(url).then(function (r) { return r.items || []; });
  }

  function sku(slug) {
    return fetchJSON('/api/juzhu/jiazheng/skus/' + encodeURIComponent(slug));
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

  function regionCity() {
    var R = window.BZF_REGION;
    return (R && R.prov && R.prov.capital) ? R.prov.capital : '南京';
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
    onChange: onChange,
    notify: notify,
    regionCity: regionCity,
    regionOperator: regionOperator,
    regionDeptStem: regionDeptStem,
    regionBankName: regionBankName,
    applyRegionChrome: applyRegionChrome
  };
})();
