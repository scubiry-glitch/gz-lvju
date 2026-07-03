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

  function districts() {
    return (cache.districts || []).slice().sort(function (a, b) { return a.sort_order - b.sort_order; });
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
    asTags: asTags
  };
})();
