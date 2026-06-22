/* ============================================================
   _region.js — 系统初始化层 · 地域/部门/业务词/机构 单一数据源
   ------------------------------------------------------------
   目标：同一套页面，不止用于江苏，也可复制到广西/贵州等省份；
        主管厅不止住建厅，也可换商务厅；业务词随之而变。

   用法：每个页面在 _nav.js / _navmobile.js 之前引入：
     <script src="_region.js"></script>        （screens 下）
     <script src="screens/_region.js"></script>（仓库根目录页面）

   切换预设（三选一，优先级从高到低）：
     1) URL 查询参数  ?region=gx
     2) localStorage  bzf_region
     3) 默认 'js'（江苏·住建厅，= 现有字面量基准）

   机制：
     · window.BZF_REGION  当前激活预设（_nav/_navmobile 直接读它生成品牌）
     · relabel()          运行时把"江苏基准字面量"按词典替换为激活预设值
                          ⇒ 70 个页面正文零改动，只需引入本脚本
   修改任何主体名词都改这里 ── 页面与导航不得再硬编码。
   ============================================================ */
(function () {
  'use strict';

  // ============ 省份预设注册表（单一数据源） ============
  // 结构字段供 _nav/_navmobile 读取；relabel 词典由本文件按 'js' 基准自动派生。
  const PRESETS = {
    // —— 江苏 · 住建厅（默认基准，= 现有页面字面量，切到它时 relabel 为空操作） ——
    js: {
      label: '江苏 · 住建厅',
      prov: { full: '江苏省', short: '江苏', capital: '南京',
              cities: ['南京','苏州','无锡','常州','镇江','扬州','泰州',
                       '南通','盐城','徐州','淮安','宿迁','连云港'] },
      dept: { short: '住建厅', orgFull: '住房和城乡建设', stem: '住建', division: '监管处' },
      biz:  { term: '保租房', termFull: '保障性租赁住房' },
      bank: { name: '江苏银行', div: '普惠金融部' },
      soe:  { full: '南京安居保障房集团', mid: '安居保障房集团', short: '安居集团' },
      roster: { brands: ['自如','龙湖','冠寓','华润','招商','省心租'],
                vendor: '优家装饰', supplier: '北新建材', training: '家协培训' },
      operator: '贝壳',
    },

    // —— 广西 · 住建厅（仍是保租房域，仅换省/市/银行/国企） ——
    gx: {
      label: '广西 · 住建厅',
      prov: { full: '广西壮族自治区', short: '广西', capital: '南宁',
              cities: ['南宁','柳州','桂林','梧州','北海','防城港','钦州',
                       '贵港','玉林','百色','贺州','河池','来宾','崇左'] },
      dept: { short: '住建厅', orgFull: '住房和城乡建设', stem: '住建', division: '监管处' },
      biz:  { term: '保租房', termFull: '保障性租赁住房' },
      bank: { name: '广西北部湾银行', div: '普惠金融部' },
      soe:  { full: '南宁安居保障房集团', mid: '安居保障房集团', short: '安居集团' },
      // 保租房域：长租公寓品牌为全国性运营商，跨省不变
      roster: { brands: ['自如','龙湖','冠寓','华润','招商','省心租'],
                vendor: '优家装饰', supplier: '北新建材', training: '家协培训' },
      operator: '贝壳',
    },

    // —— 贵州 · 住建厅（演示"换厅 + 换业务词 + 换运营机构域"） ——
    gz_zj: {
      label: '贵州 · 住建厅',
      prov: { full: '贵州省', short: '贵州', capital: '贵阳',
              // 贵州 9 个地级行政区（6 市 + 3 自治州，自治州用全称）；供城市切换器
              cities: ['贵阳','遵义','六盘水','安顺','毕节','铜仁',
                       '黔东南苗族侗族自治州','黔南布依族苗族自治州','黔西南布依族苗族自治州'],
              // 仅供 relabel 吸收江苏第 10-13 市（贵州无对应地级市，用县级市兜底，防江苏市名残留）
              extraCities: ['仁怀','清镇','赤水','盘州'] },
      dept: { short: '住建厅', orgFull: '住房和城乡建设', stem: '住建', division: '监管处' },
      biz:  { term: '旅居住宿', termFull: '旅居住宿与民宿' },
      bank: { name: '贵州银行', div: '普惠金融部' },
      soe:  { full: '贵阳旅居集团', mid: '旅居集团', short: '旅居集团' },
      // 旅居域：运营机构从长租公寓换为酒店/民宿品牌（与 brands 顺序一一对应）
      roster: { brands: ['华住','锦江','都城','首旅','亚朵','省心住'],
                vendor: '洁净家保洁', supplier: '布草供应链', training: '旅居服务培训' },
      operator: '贝壳',
    },
  };

  // ============ 选定激活预设 ============
  function pickKey() {
    try {
      const q = new URLSearchParams(location.search).get('region');
      if (q && PRESETS[q]) { try { localStorage.setItem('bzf_region', q); } catch (e) {} return q; }
      const s = localStorage.getItem('bzf_region');
      if (s && PRESETS[s]) return s;
    } catch (e) {}
    return 'js';
  }

  const KEY = pickKey();
  const R = PRESETS[KEY];

  // 便捷派生字段（供 _nav / _navmobile 直接拼装品牌文案）
  R.key      = KEY;
  R.channel  = R.prov.short + R.biz.term;                       // 江苏保租房 / 贵州旅居住宿
  R.deptName = R.dept.short;                                    // 住建厅
  R.bureau   = function (m) { return m + '市' + R.dept.stem + '局'; };  // 南京市住建局
  R.govOrg   = R.bureau(R.prov.capital) + ' · ' + R.dept.division;     // 南京市住建局 · 监管处

  window.BZF_PRESETS = PRESETS;
  window.BZF_REGION  = R;

  // ============ relabel：江苏基准字面量 → 激活预设值 ============
  function buildDict() {
    const J = PRESETS.js;          // 源始终是江苏基准（页面正文以它为字面量）
    const pairs = [];
    const push = (a, b) => { if (a && b && a !== b) pairs.push([a, b]); };

    // —— 部门（先全称后词根，避免子串误伤） ——
    push(J.dept.orgFull, R.dept.orgFull);   // 住房和城乡建设 → 文化和旅游
    push(J.dept.stem,    R.dept.stem);      // 住建 → 旅居（带出 住建厅/住建局/住建委/省住建）

    // —— 金融机构 ——
    push(J.bank.name, R.bank.name);         // 江苏银行 → 广西北部湾银行 / 贵州银行

    // —— 国企持有方 ——
    push(J.soe.mid,   R.soe.mid);           // 安居保障房集团 → 旅居集团
    push(J.soe.short, R.soe.short);         // 安居集团 → 旅居集团

    // —— 业务词（先全称后简称） ——
    push(J.biz.termFull, R.biz.termFull);   // 保障性租赁住房 → 旅居住宿与民宿
    push(J.biz.term,     R.biz.term);       // 保租房 → 旅居住宿
    // 注：不替换裸 "保障房"——它是 "安居保障房集团" 的子串，会误伤国企名（详见规则 7）

    // —— 生态机构示例名单（按下标一一对应替换） ——
    J.roster.brands.forEach((b, i) => push(b, R.roster.brands[i]));
    push(J.roster.vendor,   R.roster.vendor);
    push(J.roster.supplier, R.roster.supplier);
    push(J.roster.training, R.roster.training);
    push(J.operator,        R.operator);

    // —— 设区市（下标对应；省会在 index 0；超出目标省地级市数的，用 extraCities 兜底防残留） ——
    const ex = R.prov.extraCities || [];
    J.prov.cities.forEach((c, i) => push(c, R.prov.cities[i] || ex[i - R.prov.cities.length]));

    // —— 省份（先全称后简称，放最后，长度最短） ——
    push(J.prov.full,  R.prov.full);        // 江苏省 → 广西壮族自治区
    push(J.prov.short, R.prov.short);       // 江苏 → 广西

    // 长串优先，杜绝子串误替换
    return pairs.sort((a, b) => b[0].length - a[0].length);
  }

  function relabel() {
    if (KEY === 'js') return;               // 默认基准：零操作
    const dict = buildDict();
    if (!dict.length) return;
    const walker = document.createTreeWalker(
      document.documentElement, NodeFilter.SHOW_TEXT,
      { acceptNode: function (n) {
          const p = n.parentNode;
          if (!p) return NodeFilter.FILTER_REJECT;
          const tag = p.nodeName;
          if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
          if (p.closest && p.closest('[data-noregion]')) return NodeFilter.FILTER_REJECT;
          return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        } }
    );
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    nodes.forEach(function (n) {
      let v = n.nodeValue, changed = false;
      for (let i = 0; i < dict.length; i++) {
        if (v.indexOf(dict[i][0]) !== -1) { v = v.split(dict[i][0]).join(dict[i][1]); changed = true; }
      }
      if (changed) n.nodeValue = v;
    });
    // 标题单独处理
    if (document.title) {
      let t = document.title;
      dict.forEach(function (d) { if (t.indexOf(d[0]) !== -1) t = t.split(d[0]).join(d[1]); });
      document.title = t;
    }
  }

  // relabel 在 nav 之后跑也安全：nav 用 R 直接生成激活值（不含江苏基准串），不会被二次替换。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', relabel);
  } else {
    relabel();
  }

  window.BZF_REGION.relabel = relabel;
})();
