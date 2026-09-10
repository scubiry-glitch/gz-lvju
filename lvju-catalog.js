/**
 * lvju-catalog.js —— C 端旅居系列页房源卡数据化加载器（替代页面硬编码房源卡）
 *
 * 数据源：GET /api/juzhu/catalog?city=&channel=&topic=
 *   - channel ∈ rental(租赁住宿=长租+旅居)/minsu/newhouse/resale，channel=all 全量
 *   - topic=bzf 读取 settings KV `topic_bzf`（channel=rental + tags 含「保租房」）
 *   - 只返回 status='online' 的项目；rating/owner_vendor_id/status 随 p.* 下发
 *
 * 用法：LVJU_CATALOG.mount({ list:'#houseList', style:'mcard'|'lrow', channel:'rental',
 *   requiredTag:'旅居', cityDefault:'guiyang', detail:'lvju-app-detail.html',
 *   priceKind:'month'|'total', chipMap:{...}, titleEl:'#segTitle' })
 * 验证钩子：渲染完成后 window.__LVJU_LAST__ = { city, total, shown }
 */
(function (global) {
  'use strict';
  var API = '/api/juzhu';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmt(n) { return (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString('zh-CN'); }
  function wan(y) {
    if (!y) return '';
    var v = Number(y) / 10000;
    return String(Math.round(v * 10) / 10).replace(/\.0$/, '');
  }
  function qs(o) {
    var a = [];
    for (var k in o) if (o[k]) a.push(encodeURIComponent(k) + '=' + encodeURIComponent(o[k]));
    return a.length ? '?' + a.join('&') : '';
  }
  function urlParam(name) {
    try { return new URLSearchParams(location.search).get(name) || ''; } catch (_) { return ''; }
  }
  function parseRating(p) {
    try { return typeof p.rating === 'string' ? JSON.parse(p.rating) : (p.rating || null); }
    catch (_) { return null; }
  }
  function coverStyle(p) {
    if (!p.cover_image) return '';
    return ' style="background-image:url(\'' + esc(p.cover_image) + '\'),linear-gradient(135deg,#0c4d44,#14665c)"';
  }
  function starChip(p, label) {
    var r = parseRating(p);
    if (p.rating_status === 'passed' && r && r.stars) {
      return '<span class="star">★ ' + r.stars + ' 星' + (label ? ' · ' + esc(label) : '') + '</span>';
    }
    return '';
  }
  function tagsHtml(p, max) {
    var html = (p.tags || []).slice(0, max || 4).map(function (t) { return '<span>' + esc(t) + '</span>'; }).join('');
    // 保险标识（projects.ext.insurance，服务端 INSURANCE_TYPES 单一数据源）
    var ins = p.insurance_types || [];
    html += ins.map(function (t) { return '<span>' + (t.icon || '🛡') + ' ' + esc(t.short || t.label) + '</span>'; }).join('');
    return html;
  }
  function priceHtml(p, units, kind) {
    var pf = p.price_from;
    if (kind === 'total') {
      var w = wan(pf);
      return '<b>' + (w ? '¥' + w : '价格待询') + '<small> 万起</small></b>';
    }
    var v = pf || (units && units[0] && units[0].rent_monthly) || null;
    return '<b>' + (v ? '¥' + fmt(v) : '价格待询') + '<small>/月起</small></b>';
  }

  function cardM(p, cityName, units, o, dmap) {
    var dName = dmap[p.district_id] || '';
    var loc = [cityName, dName].filter(Boolean).join(' · ');
    return '<a class="mcard" href="' + o.detail + '?id=' + p.id + '">' +
      '<div class="img"' + coverStyle(p) + '>' + starChip(p, o.starLabel) + '<span class="like">♡</span>' +
      '<div class="cap"><div class="nm">' + esc(p.name) + '</div><div class="lo">' + esc(loc) + '</div></div></div>' +
      '<div class="ci"><div class="tags">' + tagsHtml(p, 4) + '</div>' +
      '<div class="pr">' + priceHtml(p, units, o.priceKind || 'month') +
      '<span class="bk">' + esc(o.cta || '预订') + '</span></div></div></a>';
  }

  function cardL(p, cityName, units, o, dmap) {
    var dName = dmap[p.district_id] || '';
    var u0 = units && units[0] ? units[0] : {};
    var meta = [cityName, dName,
      u0.area_sqm ? (Number(u0.area_sqm) + '㎡') : '',
      (p.tags || []).join(' · ')].filter(Boolean).join(' · ');
    var badge = o.badge || (p.tags || [])[0] || '在售';
    var unitNote = o.unitNote;
    if (unitNote == null) {
      var uv = (o.priceKind === 'total') ? (u0.price_total ? '¥' + wan(u0.price_total) + '万' : '') : (u0.rent_monthly ? '¥' + fmt(u0.rent_monthly) + '/月' : '');
      unitNote = [u0.layout_label || '', uv].filter(Boolean).join(' ') || '详情咨询';
    }
    return '<a class="lrow" href="' + o.detail + '?id=' + p.id + '">' +
      '<div class="th"' + coverStyle(p) + '><span class="star">' + esc(badge) + '</span></div>' +
      '<div class="info"><div class="nm">' + esc(p.name) + '</div>' +
      '<div class="meta">' + esc(meta) + '</div>' +
      '<div class="tags">' + tagsHtml(p, 3) + '</div>' +
      '<div class="pr">' + priceHtml(p, units, o.priceKind || 'month') +
      '<span class="unit">' + esc(unitNote) + '</span></div></div></a>';
  }

  function mount(o) {
    var list = document.querySelector(o.list);
    if (!list) return;
    var state = { city: urlParam('city') || o.cityDefault || '', tag: '', cats: {} };

    // 城市切换条（多城市房源；?city= 可直达）
    var bar = document.createElement('div');
    bar.style.cssText = 'padding:0 16px 12px;display:flex;align-items:center;gap:8px;';
    bar.innerHTML = '<span style="font-size:11px;color:#9aa6a2;">城市</span>' +
      '<select id="lvjuCitySel" style="flex:1;max-width:180px;padding:7px 10px;border:1px solid #e2e8e0;' +
      'border-radius:8px;background:#fff;font-size:12.5px;color:#0f172a;"><option value="">加载城市…</option></select>';
    list.parentNode.insertBefore(bar, list);
    var sel = bar.querySelector('#lvjuCitySel');
    fetch(API + '/cities').then(function (r) { return r.json(); }).then(function (cs) {
      if (!Array.isArray(cs) || !cs.length) return;
      sel.innerHTML = cs.map(function (c) {
        return '<option value="' + esc(c.slug) + '"' + (c.slug === state.city ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('');
      if (!state.city && cs[0]) { state.city = cs[0].slug; render(); }
    }).catch(function () { /* 城市列表失败不阻塞主流程 */ });
    sel.onchange = function () { state.city = this.value; render(); };

    // 标签筛选 chips（按 chipMap 文本→tag 映射接线，无匹配 chip 保持原样）
    if (o.chipMap) {
      var chips = document.querySelectorAll('.filt a');
      Array.prototype.forEach.call(chips, function (a) {
        var label = (a.textContent || '').trim();
        if (!(label in o.chipMap)) return;
        a.setAttribute('data-tag', o.chipMap[label]);
        a.onclick = function () {
          Array.prototype.forEach.call(chips, function (x) { x.classList.remove('on'); });
          a.classList.add('on');
          state.tag = o.chipMap[label] || '';
          renderFromCache();
        };
      });
    }

    function emptyHtml(msg) {
      return '<div style="padding:34px 16px;text-align:center;color:#9aa6a2;font-size:13px;">' +
        esc(msg || '该城市暂无房源，试试切换城市') + '</div>';
    }

    function fetchCat(city) {
      return fetch(API + '/catalog' + qs({ city: city, channel: o.channel, topic: o.topic }))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }

    function projectRows(cat) {
      var projs = (cat.projects || []).filter(function (p) {
        if (o.requiredTag && (p.tags || []).indexOf(o.requiredTag) < 0) return false;
        if (state.tag && (p.tags || []).indexOf(state.tag) < 0) return false;
        return true;
      });
      return projs;
    }

    function renderFromCache() {
      if (state.cache) paint(state.cache);
    }

    function paint(cat) {
      var dmap = {};
      (cat.districts || []).forEach(function (d) { dmap[d.id] = d.name; });
      var umap = {};
      (cat.units || []).forEach(function (u) { (umap[u.project_id] = umap[u.project_id] || []).push(u); });
      var cityName = (cat.city && cat.city.name) || state.city;
      var projs = projectRows(cat);
      global.__LVJU_LAST__ = { city: state.city, total: (cat.projects || []).length, shown: projs.length };
      if (!projs.length) { list.innerHTML = emptyHtml(); return; }
      list.innerHTML = projs.map(function (p) {
        return (o.style === 'lrow' ? cardL : cardM)(p, cityName, umap[p.id] || [], o, dmap);
      }).join('');
      if (o.titleEl) {
        var t = document.querySelector(o.titleEl);
        var label = (cat.topic && cat.topic.label) || '';
        if (t && label) t.textContent = t.textContent.replace(/·.*$/, '· ' + label);
      }
    }

    function render() {
      list.innerHTML = emptyHtml('房源加载中…');
      fetchCat(state.city).then(function (cat) {
        state.cache = cat; paint(cat);
      }).catch(function () {
        global.__LVJU_LAST__ = { city: state.city, total: -1, shown: -1 };
        list.innerHTML = emptyHtml('无法连接新居住 API（/api/juzhu/catalog），请确认服务已部署');
      });
    }

    render();
  }

  global.LVJU_CATALOG = { mount: mount };
})(window);
