/** 家政 · P 服务认证中台证书展示（服务者 / 商家共用） */
window.JZ_CERTS = (function(){
  var CERT_LABELS = {
    id_card: '身份核验', health: '健康证核验', skill: '技能考核认证',
    insurance: '责任险承保', backcheck: '平台背调', whitelist: '白名单审定'
  };
  var VENDOR_BADGE_CERTS = {
    whitelist: { name: '白名单商家认证', prefix: 'JZ-V-WL' },
    backcheck: { name: '平台背调认证', prefix: 'JZ-V-BC' },
    insurance: { name: '百万保障认证', prefix: 'JZ-V-IN' },
    commitment: { name: '服务承诺认证', prefix: 'JZ-V-CM' },
    top10: { name: '销量榜认证', prefix: 'JZ-V-T10' }
  };

  function verifyUrl(code){
    return 'screens/portal-verify.html?code=' + encodeURIComponent(code || '');
  }

  function enrichWorker(w){
    if (!w) return w;
    if (w.platform_certs && w.platform_certs.length) return w;
    var out = [];
    var id = w.id || 0;
    var level = w.level || 'L3';
    if (w.whitelist_id || w.is_whitelisted) {
      var wid = w.whitelist_id || ('S' + id);
      out.push({
        code: 'JZ-S-' + wid,
        name: level + ' 服务者持证',
        issuer: 'P 服务认证中台',
        valid_until: '2027-06-30',
        status: 'valid'
      });
    }
    (w.certs || []).forEach(function(c){
      if (c === 'whitelist') return;
      var prefix = { id_card:'JZ-ID', health:'JZ-HC', skill:'JZ-SK', insurance:'JZ-IN', backcheck:'JZ-BC' }[c] || ('JZ-' + c);
      out.push({
        code: prefix + '-' + id,
        name: CERT_LABELS[c] || c,
        issuer: 'P 服务认证中台',
        valid_until: c === 'insurance' ? '2027-06-30' : '2026-12-31',
        status: 'valid'
      });
    });
    w.platform_certs = out;
    return w;
  }

  function enrichVendor(v){
    if (!v) return v;
    if (v.platform_certs && v.platform_certs.length) return v;
    var out = [];
    var id = v.id || 0;
    var vno = v.vendor_no || ('V' + String(id).padStart(4, '0'));
    out.push({
      code: 'JZ-B-' + vno,
      name: '家政商家主体认证',
      issuer: 'P 服务认证中台',
      valid_until: '2027-12-31',
      status: 'valid'
    });
    (v.badges || []).forEach(function(b){
      var def = VENDOR_BADGE_CERTS[b];
      if (!def) return;
      out.push({
        code: def.prefix + '-' + id,
        name: def.name,
        issuer: 'P 服务认证中台',
        valid_until: '2027-06-30',
        status: 'valid'
      });
    });
    v.platform_certs = out;
    v.vendor_no = vno;
    return v;
  }

  function renderCertCards(certs, opts){
    opts = opts || {};
    if (!certs || !certs.length) {
      return opts.empty != null ? opts.empty : '<div class="jz-cert-empty">暂无中台认证记录</div>';
    }
    var compact = opts.compact;
    return certs.map(function(c){
      var ok = !c.status || c.status === 'valid';
      return '<a class="jz-cert' + (compact ? ' compact' : '') + (ok ? '' : ' expired') + '" href="' + verifyUrl(c.code) + '">' +
        '<span class="ck">' + (ok ? '✓' : '!') + '</span>' +
        '<span class="bd">' +
          '<b>' + c.name + '</b>' +
          '<span class="meta">' + (c.issuer || 'P 服务认证中台') + ' · ' + c.code + '</span>' +
          (c.valid_until ? '<span class="exp">有效期至 ' + c.valid_until + '</span>' : '') +
        '</span>' +
        '<span class="go">验真 ›</span>' +
      '</a>';
    }).join('');
  }

  function countLabel(n){
    return n ? (n + ' 项中台认证') : '';
  }

  return {
    verifyUrl: verifyUrl,
    enrichWorker: enrichWorker,
    enrichVendor: enrichVendor,
    renderCertCards: renderCertCards,
    countLabel: countLabel
  };
})();
