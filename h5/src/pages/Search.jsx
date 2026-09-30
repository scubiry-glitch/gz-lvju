import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { catalog, topics as fetchTopics } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity, writeStoredCity, provinceOf } from '../lib/city.js';
import { priceParts, priceUnitText, formatPrice } from '../lib/price.js';
import CitySheet from '../components/CitySheet.jsx';
import '../styles/search.css';

const SEGS = [
  { id: 'all', label: '推荐', kind: 'mixed' },
  { id: 'lvju', label: '旅居', kind: 'stay' },
  { id: 'minsu', label: '民宿', kind: 'stay' },
  { id: 'changzu', label: '长租', kind: 'stay' },
  { id: 'newhouse', label: '新房', kind: 'newhouse' },
  { id: 'resale', label: '二手', kind: 'resale' },
];
const SEG_BY = Object.fromEntries(SEGS.map((s) => [s.id, s]));
const CHANNEL_LABEL = { rental: '长租', minsu: '民宿', newhouse: '新房', resale: '二手' };
const PRICE_OPTS = [
  { id: 0, label: '不限' },
  { id: 1, label: '¥1,000 以内', min: 0, max: 1000 },
  { id: 2, label: '¥1,000 - 2,000', min: 1000, max: 2000 },
  { id: 3, label: '¥2,000 以上', min: 2000, max: Infinity },
];
const STAR_OPTS = [
  { id: 0, label: '不限' },
  { id: 45, label: '4.5 分以上', min: 4.5 },
  { id: 40, label: '4.0 分以上', min: 4.0 },
];
const SORT_OPTS = [
  { id: 'def', label: '综合排序' },
  { id: 'price', label: '价格优先' },
  { id: 'star', label: '星级优先' },
];
const TOPIC_DESC = {
  houniao: '温暖过冬 · 候鸟南飞',
  kangyang: '森林温泉 · 慢节奏疗愈',
  bzf: '国企持有 · 统一监管',
  qinzi: '田园山林 · 自然课堂',
  zhengdong: '家庭聚会 · 包栋院落',
};
const HIST_KEY = 'bzf_search_hist';

function hasLvjuTag(p) {
  return (p.tags || []).includes('旅居');
}
function channelChip(p) {
  if (p.channel === 'rental') return hasLvjuTag(p) ? '旅居' : '长租';
  if (p.channel === 'minsu') return hasLvjuTag(p) ? '旅居' : '民宿';
  return CHANNEL_LABEL[p.channel] || p.channel;
}
function histGet() {
  try {
    return JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
  } catch {
    return [];
  }
}
function histPush(w) {
  if (!w) return;
  const h = histGet().filter((x) => x !== w);
  h.unshift(w);
  try {
    localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(0, 8)));
  } catch {
    /* ignore */
  }
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [city, setCity] = useState(() => params.get('city') || resolveHomeCity());
  const [seg, setSeg] = useState(() => (SEG_BY[params.get('seg')] ? params.get('seg') : 'all'));
  const [kw, setKw] = useState(() => (params.get('kw') || '').trim());
  const [F, setF] = useState({ dist: 0, price: 0, star: 0, sort: 'def' });
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState('');
  const [topicList, setTopicList] = useState([]);
  const [sheetCity, setSheetCity] = useState(false);
  const [suggOpen, setSuggOpen] = useState(false);
  const [fs, setFs] = useState(null);
  const [hist, setHist] = useState(() => histGet());
  const kwTimer = useRef(null);
  const kwRef = useRef(null);

  const dmap = useMemo(() => {
    const m = {};
    (cat?.districts || []).forEach((d) => {
      m[d.id] = d;
    });
    return m;
  }, [cat]);
  const umap = useMemo(() => {
    const m = {};
    (cat?.units || []).forEach((u) => {
      (m[u.project_id] = m[u.project_id] || []).push(u);
    });
    return m;
  }, [cat]);

  const syncUrl = useCallback(
    (c, s, k) => {
      const p = new URLSearchParams();
      p.set('city', c);
      if (s !== 'all') p.set('seg', s);
      if (k) p.set('kw', k);
      setParams(p, { replace: true });
    },
    [setParams],
  );

  const load = useCallback(
    (c) => {
      setErr('');
      setCat(null);
      catalog({ city: c })
        .then((data) => setCat(data))
        .catch(() => setErr('无法连接新居住数据库 · 请稍后再试'));
    },
    [],
  );

  useEffect(() => {
    load(city);
  }, [city, load]);

  useEffect(() => {
    fetchTopics()
      .then((c) => setTopicList(c.topics || []))
      .catch(() => {});
  }, []);

  function segProjects(sid) {
    const ps = cat?.projects || [];
    if (sid === 'lvju') return ps.filter((p) => (p.channel === 'rental' || p.channel === 'minsu') && hasLvjuTag(p));
    if (sid === 'minsu') return ps.filter((p) => p.channel === 'minsu' && !hasLvjuTag(p));
    if (sid === 'changzu') return ps.filter((p) => p.channel === 'rental' && !hasLvjuTag(p));
    if (sid === 'newhouse') return ps.filter((p) => p.channel === 'newhouse');
    if (sid === 'resale') return ps.filter((p) => p.channel === 'resale');
    return ps
      .filter((p) => CHANNEL_LABEL[p.channel])
      .sort((a, b) => (b.is_featured || 0) - (a.is_featured || 0) || (a.featured_rank || 999) - (b.featured_rank || 999));
  }

  function kwMatch(p) {
    if (!kw) return true;
    const d = dmap[p.district_id];
    const hay = [p.name, p.address, d ? d.name : '', (p.tags || []).join(' '), CHANNEL_LABEL[p.channel] || '']
      .concat((umap[p.id] || []).map((u) => [u.name, u.layout_label, (u.tags || []).join(' ')].join(' ')))
      .join(' ')
      .toLowerCase();
    return kw
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((w) => hay.includes(w));
  }

  function priceOf(p) {
    if (p.channel === 'newhouse') return p.price_total != null ? p.price_total : p.price_from != null ? p.price_from : null;
    if (p.channel === 'resale') {
      const t = (umap[p.id] || []).map((u) => u.price_total).filter((v) => v > 0);
      if (t.length) return Math.min(...t);
      return p.price_total != null ? p.price_total : p.price_from != null ? p.price_from : null;
    }
    if (p.price_from != null) return p.price_from;
    const r = (umap[p.id] || []).map((u) => u.rent_monthly).filter((v) => v > 0);
    return r.length ? Math.min(...r) : null;
  }

  function starsOf(p) {
    return p.rating_status === 'passed' && p.rating && p.rating.stars ? Number(p.rating.stars) : null;
  }

  function applyFilters(ps) {
    const priceOpt = PRICE_OPTS.find((o) => o.id === F.price);
    const starOpt = STAR_OPTS.find((o) => o.id === F.star);
    return ps.filter((p) => {
      if (F.dist && p.district_id !== F.dist) return false;
      if (priceOpt && priceOpt.min != null) {
        const v = priceOf(p);
        if (v == null || v < priceOpt.min || v >= priceOpt.max) return false;
      }
      if (starOpt && starOpt.min != null) {
        const s = starsOf(p);
        if (s == null || s < starOpt.min) return false;
      }
      return true;
    });
  }

  function sortProjects(ps) {
    if (F.sort === 'price') {
      const famOf = (p) => (p.channel === 'newhouse' ? 1 : p.channel === 'resale' ? 2 : 0);
      return ps.slice().sort((a, b) => {
        const fa = famOf(a),
          fb = famOf(b);
        if (fa !== fb) return fa - fb;
        const pa = priceOf(a),
          pb = priceOf(b);
        if (pa == null && pb == null) return 0;
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pa - pb;
      });
    }
    if (F.sort === 'star') {
      return ps.slice().sort((a, b) => {
        const sa = starsOf(a),
          sb = starsOf(b);
        if (sa == null && sb == null) return 0;
        if (sa == null) return 1;
        if (sb == null) return -1;
        return sb - sa;
      });
    }
    return ps;
  }

  const famKind = SEG_BY[seg].kind;
  const rows = useMemo(() => {
    if (!cat) return null;
    return sortProjects(applyFilters(segProjects(seg).filter(kwMatch)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, seg, kw, F, dmap, umap]);

  const hot = useMemo(() => {
    const freq = {};
    (cat?.projects || []).forEach((p) => {
      (p.tags || []).forEach((t) => {
        if (t === '保租房' || t === '演示' || t === '精选') return;
        freq[t] = (freq[t] || 0) + 1;
      });
    });
    return Object.keys(freq)
      .sort((a, b) => freq[b] - freq[a])
      .slice(0, 8);
  }, [cat]);

  function pickCity(next) {
    setCity(next);
    writeStoredCity(next);
    syncUrl(next, seg, kw);
    setSheetCity(false);
    setF((f) => ({ ...f, dist: 0 }));
  }

  function commitKw(w) {
    const next = (w || '').trim();
    setKw(next);
    syncUrl(city, seg, next);
    if (next) {
      histPush(next);
      setHist(histGet());
    }
    setSuggOpen(false);
  }

  function topicMatches(t, p) {
    if (t.channel && p.channel !== t.channel) return false;
    const pt = p.tags || [];
    return (t.tags || []).every((tag) => pt.includes(tag));
  }

  const showTopics = seg === 'all' && !kw && topicList.length && cat;
  const topicCards = showTopics
    ? topicList
        .map((t) => {
          const ps = (cat.projects || []).filter((p) => topicMatches(t, p));
          if (!ps.length) return null;
          let bg = assetUrl(t.cover_image) || '';
          if (!bg) {
            for (const p of ps) {
              if (p.cover_image) {
                bg = assetUrl(p.cover_image);
                break;
              }
            }
          }
          return { t, ps, bg };
        })
        .filter(Boolean)
    : [];

  function distOpts() {
    const seen = {};
    segProjects(seg)
      .filter(kwMatch)
      .forEach((p) => {
        if (p.district_id) seen[p.district_id] = dmap[p.district_id];
      });
    const opts = [{ id: 0, label: '不限区域' }];
    Object.keys(seen)
      .sort((a, b) => (seen[a]?.sort_order || 0) - (seen[b]?.sort_order || 0) || a - b)
      .forEach((id) => opts.push({ id: Number(id), label: seen[id]?.name || id }));
    return opts;
  }

  function openFilter(f) {
    if ((f === 'price' || f === 'star') && famKind !== 'stay') return;
    setFs(f);
  }

  const fsOpts =
    fs === 'dist' ? distOpts() : fs === 'price' ? PRICE_OPTS : fs === 'star' ? STAR_OPTS : fs === 'sort' ? SORT_OPTS : [];
  const fsTitle = { dist: '区域', price: '价格', star: '评分', sort: '排序' }[fs] || '筛选';

  function cellLabel(f) {
    const dis = famKind !== 'stay';
    if (f === 'dist') return F.dist ? dmap[F.dist]?.name || '区域' : '区域';
    if (f === 'price') return dis || !F.price ? '价格' : PRICE_OPTS.find((x) => x.id === F.price)?.label.replace(/ /g, '') || '价格';
    if (f === 'star')
      return dis || !F.star
        ? '评分'
        : (STAR_OPTS.find((x) => x.id === F.star)?.label || '').replace(' 分以上', '分+') || '评分';
    return SORT_OPTS.find((x) => x.id === F.sort)?.label || '综合排序';
  }

  function cellActive(f) {
    const dis = famKind !== 'stay';
    return (
      (f === 'dist' && F.dist) ||
      (f === 'price' && !dis && F.price) ||
      (f === 'star' && !dis && F.star) ||
      (f === 'sort' && F.sort !== 'def')
    );
  }

  function cardHref(p, fam) {
    if (fam === 'stay') return `/detail/${p.id}`;
    if (fam === 'newhouse') return `/lvju-app-newhouse-detail.html?id=${p.id}`;
    const us = (umap[p.id] || []).slice().sort((a, b) => (a.price_total || 9e9) - (b.price_total || 9e9));
    const u0 = us[0];
    return `/lvju-app-resale-detail.html?id=${p.id}${u0 ? '&unit=' + u0.id : ''}`;
  }

  function renderCard(p) {
    const d = dmap[p.district_id];
    const loc =
      d && p.address && String(p.address).indexOf(d.name) === 0
        ? p.address
        : [d ? d.name : '', p.address || ''].filter(Boolean).join(' · ');
    const fam =
      SEG_BY[seg].kind === 'mixed'
        ? p.channel === 'newhouse'
          ? 'newhouse'
          : p.channel === 'resale'
            ? 'resale'
            : 'stay'
        : SEG_BY[seg].kind;
    const cover = p.cover_image
      ? { backgroundImage: `url(${assetUrl(p.cover_image)})` }
      : {
          backgroundImage: `url(/assets/lvju/xijiang-night.jpg)`,
        };
    const tags = (p.tags || []).filter((t) => t !== '保租房' && t !== '演示' && t !== '精选').slice(0, 3);
    let priceNode;
    let cta;
    if (fam === 'stay') {
      const pd = priceParts(p);
      priceNode =
        pd.value != null ? (
          <>
            <i>¥</i>
            <b>{formatPrice(pd.value)}</b>
            <small>{priceUnitText(p)}</small>
          </>
        ) : (
          <span style={{ fontSize: 13 }}>{pd.note}</span>
        );
      cta = p.bookable !== false ? <span className="go">预订</span> : <span className="go tel">📞 咨询</span>;
    } else if (fam === 'newhouse') {
      priceNode =
        p.price_total != null ? (
          <>
            <i>¥</i>
            <b>{formatPrice(p.price_total)}</b>
            <small>万起</small>
          </>
        ) : p.price_from != null ? (
          <>
            <i>¥</i>
            <b>{formatPrice(p.price_from)}</b>
            <small>/㎡起</small>
          </>
        ) : (
          <span style={{ fontSize: 13 }}>价格面议</span>
        );
      cta = <span className="go">查看</span>;
    } else {
      const us = (umap[p.id] || []).slice().sort((a, b) => (a.price_total || 9e9) - (b.price_total || 9e9));
      const total = us[0]?.price_total != null ? us[0].price_total : p.price_total;
      priceNode =
        total != null ? (
          <>
            <i>¥</i>
            <b>{formatPrice(total)}</b>
            <small>万起</small>
          </>
        ) : p.price_from != null ? (
          <>
            <i>¥</i>
            <b>{formatPrice(p.price_from)}</b>
            <small>万起</small>
          </>
        ) : (
          <span style={{ fontSize: 13 }}>价格面议</span>
        );
      cta = <span className="go">查看</span>;
    }
    const href = cardHref(p, fam);
    const Comp = fam === 'stay' ? Link : 'a';
    const linkProps = fam === 'stay' ? { to: href } : { href };
    const r = p.rating || {};
    return (
      <Comp key={p.id} className="lcard" {...linkProps}>
        <div className="im" style={cover}>
          {fam === 'stay' && p.is_featured ? <span className="bdg feat">精选</span> : null}
          {fam !== 'stay' ? <span className="bdg onsale">在售</span> : null}
        </div>
        <div className="in">
          <div className="t">
            <span className="nm">{p.name}</span>
            <span className="ch">{channelChip(p)}</span>
          </div>
          <div className="meta">
            {fam === 'stay' && p.rating_status === 'passed' && r.stars ? (
              <>
                <span className="sc">★{r.stars}</span>
                <i style={{ fontStyle: 'normal', opacity: 0.55 }}>{channelChip(p)}</i>
                <span>{loc}</span>
              </>
            ) : (
              <span>{loc}</span>
            )}
          </div>
          {tags.length ? (
            <div className="tags">
              {tags.map((t) => (
                <span key={t}>{t}</span>
              ))}
            </div>
          ) : null}
          <div className="bt">
            <span className="pr">{priceNode}</span>
            {cta}
          </div>
        </div>
      </Comp>
    );
  }

  const cityName = cat?.city?.name || city;
  const guiyangHint = famKind === 'stay' && provinceOf(cityName) === '贵州' && cityName !== '贵阳';

  return (
    <div className="search-page" style={{ position: 'relative', minHeight: '100%' }}>
      <div className="appbar">
        <Link className="bk" to="/" onClick={(e) => { if (history.length > 1) { e.preventDefault(); navigate(-1); } }}>
          ‹
        </Link>
        <div className="searchin">
          <span className="ic">
            <img src="/assets/lvju/icons/search-ic.svg" alt="" />
          </span>
          <input
            ref={kwRef}
            value={kw}
            placeholder="搜目的地 / 楼盘 / 民宿 / 景区"
            autoComplete="off"
            onFocus={() => setSuggOpen(true)}
            onChange={(e) => {
              const v = e.target.value;
              setKw(v);
              clearTimeout(kwTimer.current);
              kwTimer.current = setTimeout(() => syncUrl(city, seg, v.trim()), 140);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commitKw(kw);
                kwRef.current?.blur();
              }
            }}
          />
          {kw ? (
            <button type="button" className="clr" onClick={() => commitKw('')}>
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {suggOpen ? (
        <>
          <div className="smask" onClick={() => setSuggOpen(false)} role="presentation" />
          <div className="sugg">
            {hist.length ? (
              <div className="sg-sec">
                <div className="sg-h">
                  搜索历史
                  <button
                    type="button"
                    className="op"
                    onClick={() => {
                      try {
                        localStorage.removeItem(HIST_KEY);
                      } catch {
                        /* ignore */
                      }
                      setHist([]);
                    }}
                  >
                    清空
                  </button>
                </div>
                <div className="sg-chips">
                  {hist.map((w) => (
                    <button key={w} type="button" onClick={() => commitKw(w)}>
                      {w}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="sg-sec">
              <div className="sg-h">热门搜索</div>
              <div className="sg-chips">
                {hot.map((w, i) => (
                  <button key={w} type="button" className={'hotw' + (i < 3 ? ' top' : '')} onClick={() => commitKw(w)}>
                    <i>{i + 1}</i>
                    {w}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </>
      ) : null}

      <div className="chanbar">
        {SEGS.map((s) => {
          const n = cat ? segProjects(s.id).filter(kwMatch).length : 0;
          return (
            <a
              key={s.id}
              href={'#seg-' + s.id}
              className={s.id === seg ? 'on' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setSeg(s.id);
                setF((f) => ({ ...f, dist: 0 }));
                syncUrl(city, s.id, kw);
                setSuggOpen(false);
              }}
            >
              {s.label}
              <span className="n">{n}</span>
            </a>
          );
        })}
      </div>

      <div className="fbar">
        {['dist', 'price', 'star', 'sort'].map((f) => {
          const dis = f !== 'dist' && f !== 'sort' && famKind !== 'stay';
          return (
            <button
              key={f}
              type="button"
              className={'cell' + (dis ? ' dis' : '') + (cellActive(f) ? ' on' : '')}
              onClick={() => openFilter(f)}
            >
              <span className="v">{cellLabel(f)}</span>
              <span className="arr">▼</span>
            </button>
          );
        })}
      </div>

      <div className="countline">
        <button type="button" className="city-chip" onClick={() => setSheetCity(true)}>
          {cityName} ▾
        </button>
        <span>
          {err ? (
            err
          ) : !cat ? (
            '加载中…'
          ) : (
            <>
              为你找到 <b>{rows?.length || 0}</b> 个「{SEG_BY[seg].label}
              {kw ? ` · ${kw}` : ''}」结果
            </>
          )}
        </span>
      </div>

      {topicCards.length ? (
        <div className="topics">
          {topicCards.map(({ t, ps, bg }) => (
            <a
              key={t.slug}
              className="tp"
              href={`/lvju-app-topic.html?topic=${encodeURIComponent(t.slug)}&city=${encodeURIComponent(city)}`}
            >
              <div className="bg" style={bg ? { backgroundImage: `url(${bg})` } : undefined} />
              <span className="rn">{ps.length} 套在架</span>
              <div className="in">
                <b>{t.label}</b>
                <small>{t.desc || TOPIC_DESC[t.slug] || '编辑精选专题'}</small>
              </div>
            </a>
          ))}
        </div>
      ) : null}

      <div className="hlist">
        {err ? (
          <div className="search-empty" style={{ color: '#b45309' }}>
            {err}
          </div>
        ) : !cat ? (
          <div className="search-empty">加载中…</div>
        ) : !rows?.length ? (
          <div className="search-empty">
            <div style={{ fontSize: 30, marginBottom: 6, opacity: 0.6 }}>🔍</div>
            当前城市「{cityName}」暂无符合条件的{SEG_BY[seg].label}房源
            {kw ? ' · 换个关键词或筛选试试' : ''}
            {guiyangHint ? ' · 旅居房源目前集中在贵阳' : ''}
            <br />
            {guiyangHint ? (
              <button type="button" className="go-btn" onClick={() => pickCity('贵阳')}>
                去贵阳看{SEG_BY[seg].label}
              </button>
            ) : (
              <button type="button" className="go-btn" onClick={() => setSheetCity(true)}>
                切换城市
              </button>
            )}
          </div>
        ) : (
          rows.map(renderCard)
        )}
      </div>

      {fs ? (
        <div className="fsheet" onClick={(e) => e.target === e.currentTarget && setFs(null)} role="presentation">
          <div className="panel">
            <div className="sh">
              <b>{fsTitle}</b>
              <button type="button" className="x" onClick={() => setFs(null)}>
                ✕
              </button>
            </div>
            <div className="opts">
              {fsOpts.map((o) => (
                <a
                  key={String(o.id)}
                  href="#opt"
                  className={String(F[fs]) === String(o.id) ? 'on' : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    setF((prev) => ({
                      ...prev,
                      [fs]: fs === 'dist' ? Number(o.id) : fs === 'sort' ? o.id : Number(o.id),
                    }));
                    setFs(null);
                  }}
                >
                  <span className="ck">✓</span>
                  {o.label}
                </a>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <CitySheet open={sheetCity} city={city} onClose={() => setSheetCity(false)} onPick={pickCity} allowProvince={false} />
    </div>
  );
}
