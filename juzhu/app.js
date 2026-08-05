/** 新居住频道 · 共享数据层（读 juzhu/data.json 或 /api/juzhu/*） */
window.JUZHU = (function () {
  var cache = null;
  var _settings = null;

  function loadSettings() {
    if (_settings) return Promise.resolve(_settings);
    return fetch('/api/juzhu/settings').then(function(r) { return r.json(); }).then(function(s) {
      _settings = s;
      return s;
    }).catch(function() {
      _settings = { show_city_switcher: true, show_life_service: true };
      return _settings;
    });
  }

  // 按 URL ?city=（城市名）解析对应城市的数据文件；无城市或解析失败 → 默认 data.json
  function dataUrlForCity() {
    var city = urlCityName();
    if (!city) return Promise.resolve('');
    var base = location.pathname.indexOf('/juzhu/') !== -1 ? '' : 'juzhu/';
    return fetch(base + 'cities.json?t=' + Math.floor(Date.now() / 60000)).then(function (r) {
      if (!r.ok) return '';
      return r.json();
    }).then(function (list) {
      if (!Array.isArray(list)) return '';
      for (var i = 0; i < list.length; i++) {
        if ((list[i].slug === city || list[i].name === city) && list[i].slug) return 'data-' + list[i].slug + '.json';
      }
      return '';
    }).catch(function () { return ''; });
  }

  function load() {
    if (cache) return Promise.resolve(cache);
    var base = location.pathname.indexOf('/juzhu/') !== -1 ? '' : 'juzhu/';
    var url = base + 'data.json';
    return dataUrlForCity().then(function (cityFile) {
      return fetch((cityFile ? base + cityFile : url) + '?t=' + Math.floor(Date.now() / 60000)).then(function (r) {
        if (r.ok) return r;
        throw new Error('city data missing');
      });
    }).catch(function () {
      return fetch(url + '?t=' + Math.floor(Date.now() / 60000));
    }).then(function (r) {
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
      (d.units || []).forEach(function(u) {
        if (u.amenities == null) u.amenities = [];
        else if (typeof u.amenities === 'string') {
          try { u.amenities = JSON.parse(u.amenities); } catch (e) { u.amenities = []; }
        }
        if (u.keeper && typeof u.keeper === 'string') {
          try { u.keeper = JSON.parse(u.keeper); } catch (e) { u.keeper = null; }
        }
        if (u.rent_detail && typeof u.rent_detail === 'string') {
          try { u.rent_detail = JSON.parse(u.rent_detail); } catch (e) { u.rent_detail = null; }
        }
      });
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
      return Math.round((2.3 + ((seed + off * 13) % 23) / 10) * 10) / 10;
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
      '<div class="bs">好房子评价标准=AI打分+人工复核</div>' +
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
        { id: 'bzf', label: '保租房专区', sort_order: 1, enabled: 1 },
        { id: 'trade', label: '卖旧买新专区', sort_order: 2, enabled: 1 },
        { id: 'jiazheng', label: '生活服务专区', sort_order: 3, enabled: 1 }
      ];
    }
    // 后端配置：show_life_service 关闭时过滤掉生活服务专区
    if (_settings && !_settings.show_life_service) {
      list = list.filter(function(c) { return c.id !== 'jiazheng'; });
    }
    return list.filter(function(c) { return c.enabled !== 0; })
      .sort(function(a, b) { return (a.sort_order || 0) - (b.sort_order || 0); });
  }

  /** Convert an image path to its thumbnail counterpart.
   *  e.g. assets/juzhu/sy/districts/和平区.jpg → assets/juzhu/sy/thumbs/districts/和平区.webp
   *  Falls back to original if the path doesn't match the expected pattern.
   */
  function thumbUrl(src) {
    if (!src) return src;
    // Only thumbnail images under assets/juzhu/{city}/
    var m = src.match(/^(assets\/juzhu\/[^/]+\/)(.*)/);
    if (!m) return src;
    var base = m[1];               // e.g. assets/juzhu/sy/
    var rest = m[2];               // e.g. districts/和平区.jpg
    var webp = rest.replace(/\.(jpg|jpeg|png|JPG|JPEG|PNG)$/i, '.webp');
    return base + 'thumbs/' + webp;
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

  // 全链路城市/地域透传：把当前 URL 的 ?city= / ?region= 参数拼到站内链接上
  function chainQS() {
    var out = '';
    try {
      var sp = new URLSearchParams(location.search);
      var c = sp.get('city');
      if (c) out += '&city=' + encodeURIComponent(c);
      var r = sp.get('region');
      if (r) out += '&region=' + encodeURIComponent(r);
    } catch (e) {}
    return out;
  }

  // 当前 URL 里的城市名（用于按城市加载数据）
  function urlCityName() {
    try { return new URLSearchParams(location.search).get('city') || ''; } catch (e) { return ''; }
  }

  var AMENITY_CATALOG = [
    { id: 'ac', label: '空调', sym: '❄' },
    { id: 'washer', label: '洗衣机', sym: '◫' },
    { id: 'fridge', label: '冰箱', sym: '▣' },
    { id: 'heater', label: '热水器', sym: '♨' },
    { id: 'lock', label: '智能锁', sym: '⛊' },
    { id: 'wifi', label: '宽带', sym: '⌁' },
    { id: 'tv', label: '电视', sym: '▭' },
    { id: 'hood', label: '油烟机', sym: '◠' },
    { id: 'microwave', label: '微波炉', sym: '▢' },
    { id: 'induction', label: '电磁炉', sym: '◎' }
  ];

  function unitKeeperPhone(u) {
    var k = u && u.keeper;
    if (k && k.phone) return String(k.phone).trim();
    return bookingPhone();
  }

  function uniqTags(list) {
    var seen = {};
    var out = [];
    (list || []).forEach(function(t) {
      var s = String(t).trim();
      if (s && !seen[s]) { seen[s] = true; out.push(s); }
    });
    return out;
  }

  function inferBrandTag(project) {
    var n = (project && project.name) || '';
    var rules = [
      [/建融|CCB/i, '建融家园'], [/逸居/, '逸居'], [/人才/, '人才公寓'],
      [/龙湖/, '龙湖'], [/中海/, '中海'], [/华润/, '华润'], [/惠民/, '惠民保租'], [/地铁云杉/, '地铁上盖']
    ];
    for (var i = 0; i < rules.length; i++) {
      if (rules[i][0].test(n)) return rules[i][1];
    }
    return null;
  }

  function inferAutoUnitTags(u, project) {
    if (!project || project.channel === 'trade') {
      return ['卖旧买新', '以旧换新', '试点房源'];
    }
    var tags = ['政府保租房'];
    var brand = inferBrandTag(project);
    if (brand) tags.push(brand);
    asTags(project.tags).forEach(function(t) { tags.push(t); });

    var addr = ((project.address || '') + ' ' + (project.name || '')).trim();
    if (/地铁|青年大街|中街|奥体|北站|沈阳站|新市府|工业展览|怀远门|铁西广场/.test(addr)) {
      tags.push('近地铁');
    }
    if (u.layout_label) tags.push(u.layout_label);
    else if (u.area_sqm != null) {
      if (u.area_sqm <= 35) tags.push('精致小户型');
      else if (u.area_sqm >= 80) tags.push('宽敞大户型');
    }
    var am = unitAmenityIds(u);
    if (am.indexOf('washer') >= 0 && am.indexOf('fridge') >= 0) tags.push('拎包入住');
    tags.push('押一付一', '租金受控');
    var hr = houseRating(project);
    if (hr && hr.stars >= 4 && !hr.pending) tags.push('好房子' + hr.stars + '星');
    if (u.promo_price) tags.push('首月特惠');
    return tags;
  }

  function unitDisplayTags(u, project) {
    var explicit = asTags(u && u.tags);
    if (explicit.length >= 4) {
      if (u && u.promo_price && explicit.indexOf('首月特惠') < 0) explicit.push('首月特惠');
      return uniqTags(explicit).slice(0, 8);
    }
    return uniqTags(explicit.concat(inferAutoUnitTags(u, project))).slice(0, 8);
  }

  function unitTagClass(tag, index) {
    if (index === 0 || /政府|保租/.test(tag)) return 'tag primary';
    if (/好房子|特惠|星/.test(tag)) return 'tag gold';
    if (/近地铁|拎包|押一/.test(tag)) return 'tag accent';
    return 'tag';
  }

  function unitTagsHtml(tags) {
    return (tags || []).map(function(t, i) {
      return '<span class="' + unitTagClass(t, i) + '">' + t + '</span>';
    }).join('');
  }

  function unitSpecLine(u) {
    if (u && u.unit_spec) return u.unit_spec;
    return unitMeta(u);
  }

  function unitAmenityIds(u) {
    var ids = Array.isArray(u && u.amenities) ? u.amenities : [];
    if (!ids.length) {
      return AMENITY_CATALOG.map(function(a) { return a.id; });
    }
    return ids;
  }

  function amenityItems(u) {
    var ids = unitAmenityIds(u);
    return AMENITY_CATALOG.filter(function(a) { return ids.indexOf(a.id) >= 0; });
  }

  function rentPlanCard(label, range, plan) {
    if (!plan) return '';
    var rent = plan.rent != null ? fmtRent(plan.rent).replace('¥', '') + '元/月' : '—';
    var svc = plan.service_fee != null ? plan.service_fee + '元' + (plan.service_note ? '（' + plan.service_note + '）' : '') : '—';
    var dep = plan.deposit != null ? plan.deposit + '元' : '—';
    return '<div class="rent-plan">' +
      '<div class="rp-hd"><b>' + label + '</b><span>' + (range || '') + '</span></div>' +
      '<div class="rp-card">' +
        '<div class="rp-pay">' + (plan.pay || '—') + '</div>' +
        '<div class="rp-row"><span>租金</span><b>' + rent + '</b></div>' +
        '<div class="rp-row"><span>服务费</span><b>' + svc + '</b></div>' +
        '<div class="rp-row"><span>押金</span><b>' + dep + '</b></div>' +
      '</div></div>';
  }

  function effectiveRentDetail(u) {
    if (u && u.rent_detail) return u.rent_detail;
    if (!u || u.rent_monthly == null) return null;
    return {
      room_label: unitTitle(u) + (u.area_sqm ? ' ' + u.area_sqm + '㎡' : ''),
      long_term: {
        range: '可租4个月-1年',
        plan: { pay: '季付', rent: u.rent_monthly, service_fee: null, service_note: '一次收取', deposit: u.rent_monthly }
      },
      short_term: {
        range: '可租1个月-3个月',
        plan: { pay: '月付', rent: u.rent_monthly, service_fee: null, service_note: '一次收取', deposit: u.rent_monthly }
      },
      other_fees: []
    };
  }

  function rentDetailModalHtml(u) {
    var rd = effectiveRentDetail(u);
    if (!rd) return '';
    var room = rd.room_label || unitTitle(u);
    var longH = rentPlanCard('长租价', rd.long_term && rd.long_term.range, rd.long_term && rd.long_term.plan);
    var shortH = rentPlanCard('短租价', rd.short_term && rd.short_term.range, rd.short_term && rd.short_term.plan);
    var fees = (rd.other_fees || []).map(function(f) {
      return '<div class="fee-line"><span>' + f.name + '</span><b>' + (f.value || '—') + '</b></div>';
    }).join('');
    return '<div class="rent-modal" id="rentModal" hidden>' +
      '<div class="rent-backdrop" data-close="1"></div>' +
      '<div class="rent-sheet">' +
        '<div class="rent-hd"><button type="button" class="rent-back" data-close="1">‹</button><b>租金详情</b></div>' +
        '<div class="rent-tabs">' +
          '<button type="button" class="on" data-tab="room">房间费用</button>' +
          '<button type="button" data-tab="other">其他费用</button>' +
        '</div>' +
        '<div class="rent-body">' +
          '<div class="rent-pane on" data-pane="room">' +
            '<div class="room-label">' + room + '</div>' + longH + shortH +
          '</div>' +
          '<div class="rent-pane" data-pane="other">' + (fees || '<p class="muted">暂无其他费用配置</p>') +
            '<p class="fee-note">具体产生费用以公寓实际情况为准</p></div>' +
        '</div>' +
        '<button type="button" class="rent-cta" id="rentConsult">咨询租金优惠</button>' +
      '</div></div>';
  }

  return {
    load: load,
    loadSettings: loadSettings,
    getSettings: function() { return _settings; },
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
    thumbUrl: thumbUrl,
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
    telHref: telHref,
    chainQS: chainQS,
    urlCityName: urlCityName,
    AMENITY_CATALOG: AMENITY_CATALOG,
    unitKeeperPhone: unitKeeperPhone,
    unitDisplayTags: unitDisplayTags,
    unitTagsHtml: unitTagsHtml,
    unitSpecLine: unitSpecLine,
    amenityItems: amenityItems,
    effectiveRentDetail: effectiveRentDetail,
    rentDetailModalHtml: rentDetailModalHtml
  };
})();
