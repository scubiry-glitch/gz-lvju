/* _orderbus.js · 居住服务工单总线（localStorage 单一数据源）
 * ------------------------------------------------------------------
 * 让"客户提交需求 → 中台派单 → 服务者接单/完成 → 客户评价 → 评价回流"
 * 这条闭环在纯静态原型里真正可点击、可贯通、可演示。
 *
 * 共享方：
 *   repair.html            C端 · 提交需求 + 查看进度 + 评价
 *   p-service-demand.html  P端 · 工单池 · 派单
 *   s-orders.html          S端 · 服务者接单 / 推进 / 完工
 *   p-service-review.html  P端 · 评价回流
 *
 * 状态机：pending → dispatched → accepted → serving → done → rated
 *   pending    待派    （C端提交后）
 *   dispatched 已派单  （中台派单，绑定服务者）
 *   accepted   已接单  （服务者接单）
 *   serving    服务中  （服务者出发/作业）
 *   done       已完成  （服务者完工，待客户评价）
 *   rated      已评价  （客户评价回流）
 *
 * 所有"主体名词"沿用江苏基准字面量（房源/服务者姓名等为样例数据），
 * 与 _region.js 解耦：本总线只产数据，不参与 relabel。
 */
(function () {
  'use strict';

  var KEY = 'bzf_orders';
  var SEQ_KEY = 'bzf_order_seq';

  // 状态配置：c=客户视角 / worker=服务者视角 / admin=中台视角 / pct=进度条 / cls=样式键 / step=序
  var STATUS = {
    pending:    { c: '待派单', worker: '待接单', admin: '待派',   pct: 15,  cls: 'pending',  step: 0 },
    dispatched: { c: '已派单', worker: '待接单', admin: '已派单', pct: 35,  cls: 'progress', step: 1 },
    accepted:   { c: '处理中', worker: '待出发', admin: '已接单', pct: 55,  cls: 'progress', step: 2 },
    serving:    { c: '服务中', worker: '服务中', admin: '服务中', pct: 80,  cls: 'progress', step: 3 },
    done:       { c: '待评价', worker: '已完成', admin: '已完结', pct: 100, cls: 'done',     step: 4 },
    rated:      { c: '已评价', worker: '已评价', admin: '已评价', pct: 100, cls: 'done',     step: 5 }
  };
  var ORDER = ['pending', 'dispatched', 'accepted', 'serving', 'done', 'rated'];

  // 服务者样例池（白名单运营商旗下持证服务者）
  var WORKERS = [
    { name: '陈建国', level: 'L4', tags: ['细致', '主动'] },
    { name: '杨秀芳', level: 'L4', tags: ['准时', '周到'] },
    { name: '王志强', level: 'L3', tags: ['专业', '稳重'] },
    { name: '刘海燕', level: 'L3', tags: ['热情', '耐心'] }
  ];

  // 需求类型 → 服务费基准（演示口径）
  var FEE = { '报修': 186, '保洁': 248, '管家': 298, '送物': 68, '其他': 128 };
  // 需求类型 → emoji
  var ICON = { '报修': '🔧', '保洁': '🧹', '管家': '🛎', '送物': '📦', '其他': '🧰' };

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || []; }
    catch (e) { return []; }
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
  }
  function all() {
    return load().slice().sort(function (a, b) {
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
  }
  function byStatus(s) {
    return all().filter(function (o) {
      return Array.isArray(s) ? s.indexOf(o.status) > -1 : o.status === s;
    });
  }
  function get(id) {
    var list = load();
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function nextSeq() {
    var n = parseInt(localStorage.getItem(SEQ_KEY) || '0', 10) + 1;
    localStorage.setItem(SEQ_KEY, String(n));
    return n;
  }
  function fmtId(n) { return 'WO-2026-' + String(80000 + n); }

  function nowStamp() {
    var d = new Date();
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 客户提交需求 → 产生待派工单
  function create(d) {
    d = d || {};
    var list = load();
    var seq = nextSeq();
    var type = d.type || '报修';
    var o = {
      id: fmtId(seq),
      type: type,
      category: d.category || '',
      desc: d.desc || '',
      house: d.house || '',
      phone: d.phone || '',
      expectTime: d.expectTime || '',
      source: d.source || '旅居客 App',
      fee: FEE[type] || FEE['其他'],
      status: 'pending',
      worker: null,
      rating: null,
      createdAt: new Date().toISOString(),
      createdLabel: nowStamp(),
      log: [{ s: 'pending', at: nowStamp() }],
      live: true
    };
    list.push(o);
    save(list);
    return o;
  }

  function pushLog(o, s) {
    o.log = o.log || [];
    o.log.push({ s: s, at: nowStamp() });
  }

  function update(id, patch) {
    var list = load();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        list[i] = Object.assign({}, list[i], patch);
        save(list);
        return list[i];
      }
    }
    return null;
  }

  // 中台派单：绑定一名服务者（不传则按池轮转）
  function dispatch(id, worker) {
    var o = get(id);
    if (!o) return null;
    var w = worker;
    if (!w) {
      var assigned = byStatus(['dispatched', 'accepted', 'serving', 'done', 'rated']).length;
      w = WORKERS[assigned % WORKERS.length];
    }
    pushLog(o, 'dispatched');
    return update(id, { status: 'dispatched', worker: w, log: o.log });
  }

  // 推进一步（服务者侧：接单/出发/完工）。封顶到 done，rated 由客户评价触发。
  function advance(id) {
    var o = get(id);
    if (!o) return null;
    var i = ORDER.indexOf(o.status);
    if (i < 0 || i >= ORDER.length - 1) return o;
    var next = ORDER[i + 1];
    if (next === 'rated') return o; // 评价只能由客户触发
    pushLog(o, next);
    return update(id, { status: next, log: o.log });
  }

  // 客户评价回流
  function rate(id, rating) {
    var o = get(id);
    if (!o) return null;
    pushLog(o, 'rated');
    return update(id, { status: 'rated', rating: rating, log: o.log });
  }

  function reset() {
    localStorage.removeItem(KEY);
    localStorage.removeItem(SEQ_KEY);
  }

  // 跨标签页 / 跨页面联动：localStorage 变更时回调
  function onChange(fn) {
    window.addEventListener('storage', function (e) {
      if (e.key === KEY) fn();
    });
  }

  window.BZF_ORDERS = {
    STATUS: STATUS, ORDER: ORDER, WORKERS: WORKERS, FEE: FEE, ICON: ICON,
    all: all, byStatus: byStatus, get: get,
    create: create, update: update, dispatch: dispatch, advance: advance, rate: rate,
    reset: reset, onChange: onChange,
    esc: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
  };
})();
