/** 新居住频道 · 共享数据层（读 juzhu/data.json 或 /api/juzhu/*） */
window.JUZHU = (function () {
  var cache = null;

  function load() {
    if (cache) return Promise.resolve(cache);
    var url = 'juzhu/data.json';
    if (location.pathname.indexOf('/juzhu/') !== -1) url = 'data.json';
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error('data load failed');
      return r.json();
    }).then(function (d) {
      function normTags(list) {
        (list || []).forEach(function (r) {
          var t = r.tags;
          if (t == null) r.tags = [];
          else if (typeof t === 'string') {
            try { r.tags = JSON.parse(t); } catch (e) { r.tags = t ? [t] : []; }
          } else if (!Array.isArray(t)) r.tags = [];
        });
      }
      normTags(d.districts);
      normTags(d.projects);
      normTags(d.units);
      cache = d;
      return d;
    });
  }

  function sortDistricts(list) {
    return (list || []).slice().sort(function (a, b) {
      var ah = a.has_projects ? 1 : 0;
      var bh = b.has_projects ? 1 : 0;
      if (ah !== bh) return bh - ah;
      return (a.sort_order || 0) - (b.sort_order || 0) || (a.id || 0) - (b.id || 0);
    });
  }

  function districts() {
    return sortDistricts(cache.districts);
  }

  function districtBySlug(slug) {
    return districts().find(function (d) { return d.slug === slug || d.name === slug; });
  }

  function projects(filter) {
    var list = cache.projects || [];
    if (filter && filter.channel) list = list.filter(function (p) { return p.channel === filter.channel; });
    if (filter && filter.district_id != null) list = list.filter(function (p) { return p.district_id === filter.district_id; });
    return list.slice().sort(function (a, b) { return a.sort_order - b.sort_order; });
  }

  function projectBySlug(slug) {
    return (cache.projects || []).find(function (p) { return p.slug === slug; });
  }

  function units(projectId) {
    return (cache.units || []).filter(function (u) { return u.project_id === projectId; })
      .sort(function (a, b) { return a.sort_order - b.sort_order; });
  }

  function unitBySlug(projectId, slug) {
    return units(projectId).find(function (u) { return u.slug === slug; });
  }

  function tradeListings() {
    return projects({ channel: 'trade' });
  }

  function fmtRent(n) {
    if (n == null) return '—';
    return '¥' + Number(n).toLocaleString();
  }

  function fmtPriceWan(n) {
    if (n == null) return '—';
    return n + '<small> 万起</small>';
  }

  function imgBg(path, fallbackClass) {
    if (path) return 'background-image:url(' + path + ');background-size:cover;background-position:center;';
    return '';
  }

  function photos(entityType, entityId) {
    return (cache.photos || []).filter(function (p) {
      return p.entity_type === entityType && p.entity_id === entityId;
    }).sort(function (a, b) { return a.sort_order - b.sort_order; });
  }

  function asTags(tags) {
    if (tags == null) return [];
    if (Array.isArray(tags)) return tags;
    if (typeof tags === 'string') {
      try { var p = JSON.parse(tags); return Array.isArray(p) ? p : [tags]; } catch (e) { return tags ? [tags] : []; }
    }
    return [];
  }

  function parseAreaFromName(name) {
    if (!name) return null;
    var m = String(name).trim().match(/^(\d+(?:\.\d+)?)\s*(?:平|㎡|m²|平米)?$/);
    return m ? parseFloat(m[1]) : null;
  }

  function areasMatch(a, b) {
    if (a == null || b == null) return false;
    return Math.abs(Number(a) - Number(b)) < 0.05;
  }

  /** 名称是否仅为面积数字（70 / 70平 / 70㎡） */
  function nameIsAreaOnly(name, areaSqm) {
    var parsed = parseAreaFromName(name);
    if (parsed == null) return false;
    if (areaSqm != null) return areasMatch(parsed, areaSqm);
    return true;
  }

  function fmtArea(area) {
    if (area == null) return '';
    var n = Number(area);
    var s = n % 1 === 0 ? String(Math.round(n)) : String(n);
    return s + '㎡';
  }

  /** 展示用名称：去掉素材文件夹遗留的「_副本」「副本」后缀 */
  function cleanDisplayName(name) {
    if (!name) return '';
    var s = String(name).trim();
    while (/_?副本$/.test(s)) s = s.replace(/_?副本$/, '');
    return s.trim();
  }

  /** 列表/详情主标题：名称与面积重复时只展示面积 */
  function unitTitle(u) {
    if (!u) return '—';
    var name = cleanDisplayName(u.name);
    if (nameIsAreaOnly(name, u.area_sqm) && u.area_sqm != null) return fmtArea(u.area_sqm);
    return name || '—';
  }

  /** 副标题：不重复面积，可补户型标签 */
  function unitMeta(u) {
    if (!u) return '';
    var name = cleanDisplayName(u.name);
    var parts = [];
    if (!nameIsAreaOnly(name, u.area_sqm) && u.area_sqm != null) parts.push(fmtArea(u.area_sqm));
    if (u.layout_label) parts.push(u.layout_label);
    return parts.join(' · ');
  }

  var HOUSE_DIMS = [
    { key: 'comfort', label: '舒适', icon: '🛋', color: '#f59e0b' },
    { key: 'green', label: '绿色', icon: '🌿', color: '#10b981' },
    { key: 'tech', label: '科技', icon: '📡', color: '#3b82f6' },
    { key: 'safety', label: '安全', icon: '🛡', color: '#ef4444' }
  ];

  var STAR_LABELS = ['', '基础型', '达标型', '优质型', '精品型', '示范型'];

  function hashSeed(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
    return Math.abs(h);
  }

  function starsHtml(n) {
    var out = '';
    for (var i = 1; i <= 5; i++) {
      out += i <= n ? '★' : '<span class="dim">★</span>';
    }
    return out;
  }

  function mockHouseRating(project) {
    var seed = hashSeed((project.slug || '') + String(project.id));
    function dim(off) {
      return Math.round((3.1 + ((seed + off * 7) % 18) / 10) * 10) / 10;
    }
    var dims = { comfort: dim(0), green: dim(1), tech: dim(2), safety: dim(3) };
    var avg = (dims.comfort + dims.green + dims.tech + dims.safety) / 4;
    var stars = Math.min(5, Math.max(1, Math.round(avg)));
    return {
      stars: stars,
      star_label: STAR_LABELS[stars] || '优质型',
      score: Math.round(avg / 5 * 100),
      dims: dims,
      code: 'SY-BZF-' + String(project.id).padStart(5, '0'),
      checked: 42 + (seed % 11),
      total: 55
    };
  }

  /** 好房子四维度评级（项目级；已通过复核用库内数据，否则 mock） */
  function houseRating(project) {
    if (!project) return null;
    var r = project.rating;
    if (typeof r === 'string') {
      try { r = JSON.parse(r); } catch (e) { r = null; }
    }
    if (project.rating_status === 'passed' && r && typeof r === 'object') {
      return {
        stars: r.stars || 4,
        star_label: r.star_label || STAR_LABELS[r.stars] || '优质型',
        score: r.score || 80,
        dims: r.dims || r.dimensions || {},
        code: r.code || ('SY-BZF-' + String(project.id).padStart(5, '0')),
        checked: r.checked || 47,
        total: r.total || 55
      };
    }
    if (project.rating_status === 'pending' && r && typeof r === 'object') {
      return {
        stars: r.stars || 4,
        star_label: (r.star_label || '复核中') + ' · 待中台确认',
        score: r.score || 80,
        dims: r.dims || {},
        code: r.code || ('SY-BZF-' + String(project.id).padStart(5, '0')),
        checked: r.checked || 47,
        total: r.total || 55,
        pending: true
      };
    }
    return mockHouseRating(project);
  }

  function houseRatingHtml(project) {
    var r = houseRating(project);
    if (!r) return '';
    var dimRows = HOUSE_DIMS.map(function(d) {
      var v = r.dims[d.key];
      if (v == null) v = 4.0;
      var pct = Math.round(v / 5 * 100);
      return '<div class="hdim"><span class="k">' + d.icon + ' ' + d.label + '</span>' +
        '<span class="bar"><i style="width:' + pct + '%;background:' + d.color + '"></i></span>' +
        '<span class="v" style="color:' + d.color + '">' + v.toFixed(1) + '</span></div>';
    }).join('');

    return '<div class="block rating-block">' +
      '<div class="bt">好房子评级 · 四维度</div>' +
      '<div class="bs">江苏保租房标准 · 运营商自评 + 中台复核</div>' +
      '<div class="rating-sum">' +
        '<div class="stars-side"><div class="ek">综合星级</div>' +
        '<div class="stars">' + starsHtml(r.stars) + '</div>' +
        '<div class="lbl">' + r.star_label + '</div>' +
        '<div class="sc"><b>' + r.score + '</b> / 100 分</div></div>' +
        '<div class="dims">' + dimRows + '</div>' +
      '</div>' +
      '<div class="verify">' +
        '<a class="qrlink" href="screens/c-house-rating.html" title="扫码了解好房子标准">' +
          '<img class="qrimg" alt="好房子标准二维码"></a>' +
        '<div><div class="no">' + r.code + '</div>' +
        '<div class="vb"><b>✓</b> 四维度达标 · <b>✓</b> ' + r.checked + '/' + r.total + ' 项自查 · <b>✓</b> 住建备案</div>' +
        '<div class="vb"><a href="screens/c-house-rating.html">什么是好房子？ ↗</a></div></div>' +
      '</div></div>';
  }

  function enabledChannels() {
    var list = (cache && cache.channels) ? cache.channels.slice() : [];
    if (!list.length) {
      return [
        { id: 'bzf', label: '保租房', sort_order: 1, enabled: 1 },
        { id: 'trade', label: '卖旧买新', sort_order: 2, enabled: 1 }
      ];
    }
    return list.filter(function(c) { return c.enabled !== 0; })
      .sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  }

  function channelLabel(id) {
    var c = (cache && cache.channels || []).find(function(x) { return x.id === id; });
    if (c) return c.label;
    return id === 'trade' ? '卖旧买新' : '保租房';
  }

  function managedUnits(project) {
    if (!project) return 0;
    if (project.managed_unit_count != null && project.managed_unit_count !== '') {
      return Number(project.managed_unit_count) || 0;
    }
    return Number(project.unit_count) || 0;
  }

  function districtManagedUnits(district) {
    if (!district) return 0;
    if (district.managed_unit_count != null && district.managed_unit_count !== '') {
      return Number(district.managed_unit_count) || 0;
    }
    return projects({ channel: 'bzf', district_id: district.id })
      .reduce(function(sum, p) { return sum + managedUnits(p); }, 0);
  }

  function bookingPhone() {
    return cache && cache.city && cache.city.booking_phone ? String(cache.city.booking_phone).trim() : '';
  }

  function telHref(phone) {
    if (!phone) return '';
    var digits = phone.replace(/[^\d+]/g, '');
    return digits ? 'tel:' + digits : '';
  }

  return {
    load: load,
    get data() { return cache; },
    districts: districts,
    districtBySlug: districtBySlug,
    projects: projects,
    projectBySlug: projectBySlug,
    units: units,
    unitBySlug: unitBySlug,
    tradeListings: tradeListings,
    photos: photos,
    fmtRent: fmtRent,
    fmtPriceWan: fmtPriceWan,
    imgBg: imgBg,
    asTags: asTags,
    unitTitle: unitTitle,
    unitMeta: unitMeta,
    fmtArea: fmtArea,
    nameIsAreaOnly: nameIsAreaOnly,
    cleanDisplayName: cleanDisplayName,
    houseRating: houseRating,
    houseRatingHtml: houseRatingHtml,
    starsHtml: starsHtml,
    enabledChannels: enabledChannels,
    channelLabel: channelLabel,
    managedUnits: managedUnits,
    districtManagedUnits: districtManagedUnits,
    bookingPhone: bookingPhone,
    telHref: telHref
  };
})();
