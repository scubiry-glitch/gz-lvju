/* jz-datepick.js · 万能日期+时间选择器（家政「意向时段」通用组件）
 * 以「今天」为起点动态生成日期，可选任意日期（原生 date input 兜底），永不过期。
 * 用于：juzhu-jiazheng-detail.html（无真实排期时的意向模式）、jiazheng-booking.html（调整上门时间）。
 * 用法：JZ_DATEPICK.mount(boxEl, { value:'今天 18:00', onChange:function(str,meta){...} });
 *   - value：初值字符串，尽力解析（今天/明天/后天/ M月D日 + HH:MM）
 *   - onChange：每次变更回调，str 形如「今天 18:00」/「7月15日 19:00」
 * 依赖页面 CSS 变量 --brand/--border/--ink/--muted（均带兜底色，缺失也可用）。
 */
(function () {
  'use strict';

  var WK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  var TIMES = ['08:00', '09:00', '10:00', '11:00', '14:00', '16:00', '18:00', '19:00', '20:00'];
  var DAYS = 10; // 快捷日期覆盖今天起 10 天，其余走「其他」原生选择

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function sod(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function today() { return sod(new Date()); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function idxOf(d) { return Math.round((sod(d) - today()) / 86400000); }
  function labelOf(d) {
    var i = idxOf(d);
    return i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : WK[d.getDay()];
  }
  function keyOf(d) { return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }
  function dispOf(d) { var i = idxOf(d); return (i >= 0 && i <= 2) ? labelOf(d) : keyOf(d); }
  function fmt(d, t) { return dispOf(d) + ' ' + t; }

  // 尽力解析既有字符串 → {date, time}；失败回退今天/18:00
  function parse(val) {
    var t = '18:00', d = today();
    if (val) {
      var mt = String(val).match(/(\d{1,2}:\d{2})/);
      if (mt) t = mt[1].length === 4 ? '0' + mt[1] : mt[1];
      if (/今天/.test(val)) d = today();
      else if (/明天/.test(val)) d = new Date(today().getTime() + 86400000);
      else if (/后天/.test(val)) d = new Date(today().getTime() + 2 * 86400000);
      else {
        var md = String(val).match(/(\d{1,2})月(\d{1,2})日/);
        if (md) {
          var y = (new Date()).getFullYear();
          var cand = sod(new Date(y, +md[1] - 1, +md[2]));
          if (idxOf(cand) < 0) cand = sod(new Date(y + 1, +md[1] - 1, +md[2])); // 已过则算明年
          d = cand;
        }
      }
    }
    return { date: d, time: t };
  }

  var CSS =
    '.jz-datepick .dp-dates{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch;}' +
    '.jz-datepick .dp-dates::-webkit-scrollbar{display:none;}' +
    '.jz-datepick .dp-date{flex:0 0 auto;min-width:52px;display:flex;flex-direction:column;align-items:center;gap:2px;' +
      'padding:8px 10px;border:1px solid var(--border,#e2e8e6);border-radius:12px;background:#f8fbfa;' +
      'color:var(--ink,#0f172a);cursor:pointer;font:inherit;}' +
    '.jz-datepick .dp-date .dl{font-size:12px;font-weight:700;line-height:1.2;}' +
    '.jz-datepick .dp-date .dm{font-size:10px;color:var(--muted,#64748b);}' +
    '.jz-datepick .dp-date.on{border-color:var(--brand,#0f766e);background:#eef6f4;color:var(--brand,#0f766e);}' +
    '.jz-datepick .dp-date.on .dm{color:var(--brand,#0f766e);}' +
    '.jz-datepick .dp-more{position:relative;overflow:hidden;}' +
    '.jz-datepick .dp-more .dp-native{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer;font-size:16px;border:0;padding:0;}' +
    '.jz-datepick .dp-times{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:12px;}' +
    '.jz-datepick .dp-time{padding:9px 6px;text-align:center;font-size:12px;border:1px solid var(--border,#e2e8e6);' +
      'border-radius:10px;background:#f8fbfa;color:var(--ink,#0f172a);cursor:pointer;font:inherit;}' +
    '.jz-datepick .dp-time.on{border-color:var(--brand,#0f766e);background:#eef6f4;color:var(--brand,#0f766e);font-weight:700;}';

  function injectCSS() {
    if (document.getElementById('jz-datepick-css')) return;
    var s = document.createElement('style');
    s.id = 'jz-datepick-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function mount(box, opts) {
    if (!box) return null;
    opts = opts || {};
    injectCSS();
    var times = (opts.times && opts.times.length) ? opts.times : TIMES;
    var st = parse(opts.value);
    var pd = st.date, pt = st.time;
    if (times.indexOf(pt) < 0) pt = times[times.length > 6 ? 6 : 0]; // 初值不在预设内则取默认时段

    function render() {
      var base = today(), dates = '';
      for (var i = 0; i < DAYS; i++) {
        var d = new Date(base.getTime() + i * 86400000);
        var on = sod(d).getTime() === sod(pd).getTime();
        dates += '<button type="button" class="dp-date' + (on ? ' on' : '') + '" data-day="' + i + '">' +
          '<span class="dl">' + labelOf(d) + '</span><span class="dm">' + (d.getMonth() + 1) + '/' + d.getDate() + '</span></button>';
      }
      var custom = idxOf(pd) < 0 || idxOf(pd) >= DAYS; // 选了快捷范围外
      dates += '<label class="dp-date dp-more' + (custom ? ' on' : '') + '">' +
        '<span class="dl">其他</span><span class="dm">' + (custom ? ((pd.getMonth() + 1) + '/' + pd.getDate()) : '日期') + '</span>' +
        '<input type="date" class="dp-native" value="' + iso(pd) + '" min="' + iso(today()) + '"></label>';
      var timeHtml = times.map(function (t) {
        return '<button type="button" class="dp-time' + (t === pt ? ' on' : '') + '" data-time="' + t + '">' + t + '</button>';
      }).join('');
      box.innerHTML = '<div class="dp-dates">' + dates + '</div><div class="dp-times">' + timeHtml + '</div>';
    }

    function fire() { if (opts.onChange) opts.onChange(fmt(pd, pt), { date: pd, time: pt }); }

    box.className = 'jz-datepick';
    box.addEventListener('click', function (e) {
      var db = e.target.closest('[data-day]');
      if (db) { pd = new Date(today().getTime() + (+db.getAttribute('data-day')) * 86400000); render(); fire(); return; }
      var tb = e.target.closest('[data-time]');
      if (tb) { pt = tb.getAttribute('data-time'); render(); fire(); return; }
    });
    box.addEventListener('change', function (e) {
      var nat = e.target.closest('.dp-native');
      if (nat && nat.value) {
        var p = nat.value.split('-');
        pd = sod(new Date(+p[0], +p[1] - 1, +p[2]));
        render(); fire();
      }
    });

    render();
    fire(); // 初始即回填 selectedTime
    return { value: function () { return fmt(pd, pt); } };
  }

  window.JZ_DATEPICK = { mount: mount, TIMES: TIMES };
})();
