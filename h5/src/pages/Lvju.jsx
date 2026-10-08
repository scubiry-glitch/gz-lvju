import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { catalog } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity, writeStoredCity } from '../lib/city.js';
import { formatPrice, priceParts, priceUnitText } from '../lib/price.js';
import { featureEnabled } from '../lib/features.js';
import '../styles/channel.css';

const CAIBEI = featureEnabled('caibei');
const MIN_NIGHTS = 15;
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: '短住', label: '短住' },
  { id: '候鸟过冬', label: '候鸟过冬' },
  { id: '康养度假', label: '康养度假' },
  { id: '亲子研学', label: '亲子研学' },
  { id: '整栋包栋', label: '整栋包栋' },
];
const WK = ['日', '一', '二', '三', '四', '五', '六'];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function short(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function key(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function locOf(p, dmap) {
  const d = dmap[p.district_id];
  if (d && p.address && String(p.address).indexOf(d.name) === 0) return p.address;
  return [d ? d.name : '', p.address || ''].filter(Boolean).join(' · ');
}
function perNight(p) {
  const pd = priceParts(p);
  if (pd.unit === 'night' && pd.value != null) return pd.value;
  const v = p.price_from || 0;
  return v ? Math.max(1, Math.round(v / 30)) : 0;
}

export default function Lvju() {
  const navigate = useNavigate();
  const [city, setCity] = useState(() => resolveHomeCity());
  const [filter, setFilter] = useState('all');
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState('');
  const [ci, setCi] = useState(null);
  const [co, setCo] = useState(null);
  const [panel, setPanel] = useState(false);
  const [view, setView] = useState(() => {
    const t = startOfDay(new Date());
    return new Date(t.getFullYear(), t.getMonth(), 1);
  });
  const [hint, setHint] = useState('');
  const [draftCi, setDraftCi] = useState(null);
  const [draftCo, setDraftCo] = useState(null);

  const today = useMemo(() => startOfDay(new Date()), []);
  const minMo = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1), [today]);
  const maxMo = useMemo(() => new Date(today.getFullYear(), today.getMonth() + 11, 1), [today]);
  const maxDay = useMemo(() => new Date(today.getFullYear(), today.getMonth() + 12, 0), [today]);

  const load = useCallback((c) => {
    setErr('');
    setCat(null);
    Promise.all([catalog({ city: c, channel: 'rental' }), catalog({ city: c, channel: 'minsu' })])
      .then(([rental, minsu]) => {
        const merged = {
          ...rental,
          projects: [...(rental.projects || [])],
          units: [...(rental.units || [])],
          districts: [...(rental.districts || [])],
        };
        const seen = new Set(merged.projects.map((p) => p.id));
        (minsu.projects || []).forEach((p) => {
          if ((p.tags || []).includes('旅居') && !seen.has(p.id)) {
            merged.projects.push({ ...p, channel: 'minsu' });
            seen.add(p.id);
            (minsu.units || []).forEach((u) => {
              if (u.project_id === p.id) merged.units.push(u);
            });
          }
        });
        setCat(merged);
      })
      .catch(() => setErr('无法连接新居住数据库 · 请稍后再试'));
  }, []);

  useEffect(() => {
    load(city);
  }, [city, load]);

  const dmap = useMemo(() => {
    const m = {};
    (cat?.districts || []).forEach((d) => {
      m[d.id] = d;
    });
    return m;
  }, [cat]);

  const projects = useMemo(() => {
    const rows = (cat?.projects || []).filter(
      (p) =>
        (p.channel === 'rental' || p.channel === 'minsu') &&
        (p.tags || []).includes('旅居') &&
        (filter === 'all' || (p.tags || []).includes(filter)),
    );
    return rows;
  }, [cat, filter]);

  const nights = ci && co ? Math.round((co - ci) / 864e5) : 0;

  function openPanel() {
    setDraftCi(ci);
    setDraftCo(co);
    setHint('');
    setPanel(true);
  }
  function clearStay(e) {
    e?.stopPropagation?.();
    setCi(null);
    setCo(null);
  }
  function pickDay(d) {
    if (!draftCi || (draftCi && draftCo) || d <= draftCi) {
      setDraftCi(d);
      setDraftCo(null);
      setHint('');
      return;
    }
    const n = Math.round((d - draftCi) / 864e5);
    if (n < MIN_NIGHTS) {
      const min = new Date(draftCi.getTime() + MIN_NIGHTS * 864e5);
      setHint(`旅居房源须连续入住 ≥ ${MIN_NIGHTS} 晚，最早 ${short(min)} 离店（选 ${n} 晚不足）`);
      return;
    }
    setDraftCo(d);
    setHint('');
  }
  function confirmStay() {
    const n = draftCi && draftCo ? Math.round((draftCo - draftCi) / 864e5) : 0;
    if (n < MIN_NIGHTS) return;
    setCi(draftCi);
    setCo(draftCo);
    setPanel(false);
  }

  function goGuiyang() {
    writeStoredCity('贵阳');
    setCity('贵阳');
    navigate('/lvju?city=贵阳', { replace: true });
  }

  const draftN = draftCi && draftCo ? Math.round((draftCo - draftCi) / 864e5) : 0;
  const minCo = draftCi && !draftCo ? new Date(draftCi.getTime() + MIN_NIGHTS * 864e5) : null;
  const calCells = useMemo(() => {
    if (!panel) return [];
    const lead = new Date(view.getFullYear(), view.getMonth(), 1).getDay();
    const dim = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push({ blank: true, key: 'b' + i });
    for (let dd = 1; dd <= dim; dd++) {
      const d = new Date(view.getFullYear(), view.getMonth(), dd);
      const k = key(d);
      const past = d < today;
      const tooFar = d > maxDay;
      const dis = past || tooFar || (draftCi && !draftCo && minCo && d < minCo && k !== key(draftCi));
      let cls = 'cell';
      if (past) cls += ' past';
      else if (dis) cls += ' dis';
      if (draftCi && draftCo && k >= key(draftCi) && k <= key(draftCo)) cls += k === key(draftCi) || k === key(draftCo) ? ' end' : ' range';
      else if (draftCi && k === key(draftCi)) cls += ' end';
      cells.push({ d, dd, cls, dis: past || dis, key: k });
    }
    return cells;
  }, [panel, view, today, maxDay, draftCi, draftCo, minCo]);

  return (
    <div className="chan-page">
      <div className="appbar ghost">
        <Link
          className="bk"
          to="/"
          onClick={(e) => {
            if (history.length > 1) {
              e.preventDefault();
              history.back();
            }
          }}
        >
          ‹
        </Link>
        <div className="ttl">
          旅居<small>短住 · 候鸟 · 康养</small>
        </div>
      </div>

      <div className="hero-sm lvju">
        <div className="bg" />
        <div className="in">
          <div className="ek">Travel Living</div>
          <h1>
            把日子
            <br />
            过成一场旅行
          </h1>
          <p>精选旅居房源，短住、候鸟过冬、康养度假，配旅居管家服务</p>
          <div className="stat">
            <div>
              <b>2,400+</b>
              <span>在营旅居</span>
            </div>
            <div>
              <b>9</b>
              <span>市州覆盖</span>
            </div>
            <div>
              <b>★4.8</b>
              <span>均评分</span>
            </div>
          </div>
          <div className="hero-pill">🌙 连住 15 晚起 · 候鸟康养节奏</div>
        </div>
      </div>

      <div className="filt">
        {FILTERS.map((f) => (
          <a
            key={f.id}
            href={'#f-' + f.id}
            className={filter === f.id ? 'on' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setFilter(f.id);
            }}
          >
            {f.label}
          </a>
        ))}
      </div>

      <div className="staybar" onClick={openPanel} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openPanel()}>
        <span className="ic">
          <img src="/assets/lvju/icons/stay-cal.png" alt="" />
        </span>
        <span className={`tx${nights >= MIN_NIGHTS ? ' on' : ''}`}>
          {nights >= MIN_NIGHTS ? (
            <>
              {short(ci)} 入住 → {short(co)} 离店 · {nights} 晚
              <small>已按连住估算 · 点此修改</small>
            </>
          ) : (
            <>
              选择入住时间段
              <small>旅居房源须连续入住 · 连住 15 晚起</small>
            </>
          )}
        </span>
        {nights >= MIN_NIGHTS ? (
          <button type="button" className="clr" onClick={clearStay}>
            清除
          </button>
        ) : null}
        <span className="arr">⌄</span>
      </div>

      {panel ? (
        <div
          className="staypanel"
          onClick={(e) => {
            if (e.target === e.currentTarget) setPanel(false);
          }}
        >
          <div className="sheet">
            <div className="sh">
              <b>选择入住时间段</b>
              <span className="min">连住 15 晚起</span>
              <button type="button" className="x" onClick={() => setPanel(false)}>
                ✕
              </button>
            </div>
            <div className="calnav">
              <button type="button" disabled={view <= minMo} onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}>
                ‹
              </button>
              <div className="mo">
                {view.getFullYear()} 年 {view.getMonth() + 1} 月
              </div>
              <button type="button" disabled={view >= maxMo} onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}>
                ›
              </button>
            </div>
            <div className="calgrid">
              {WK.map((w) => (
                <div key={w} className="wk">
                  {w}
                </div>
              ))}
              {calCells.map((c) =>
                c.blank ? (
                  <div key={c.key} className="cell blank" />
                ) : (
                  <button
                    key={c.key}
                    type="button"
                    className={c.cls}
                    disabled={c.dis}
                    onClick={() => !c.dis && pickDay(c.d)}
                  >
                    <div className="dn">{c.dd}</div>
                    {!c.dis ? (
                      <div className="cp">{draftCi && key(c.d) === key(draftCi) ? '入住' : '可选'}</div>
                    ) : null}
                  </button>
                ),
              )}
            </div>
            <div className={`stayhint${hint ? ' bad' : ''}`}>{hint}</div>
            <div className="staysum">
              <span>
                {!draftCi
                  ? `先选入住日，再选离店日（连住 ${MIN_NIGHTS} 晚起）`
                  : !draftCo
                    ? `${short(draftCi)} 入住 · 请选离店日（≥ ${MIN_NIGHTS} 晚）`
                    : `${short(draftCi)} → ${short(draftCo)} · ${draftN} 晚`}
              </span>
              <button type="button" className={`go${draftN >= MIN_NIGHTS ? '' : ' off'}`} onClick={confirmStay}>
                确定
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="sec-h">
        <span className="bar" />
        <h2>精选旅居</h2>
        <span className="more">{cat ? `共 ${projects.length} 套在营` : '综合排序'}</span>
      </div>

      <div className="wrap">
        {err ? (
          <div className="empty" style={{ color: '#b45309' }}>
            {err}
          </div>
        ) : cat === null ? (
          <div className="empty">加载中…</div>
        ) : !projects.length ? (
          <div className="empty">
            {city !== '贵阳' && city !== 'guiyang' ? (
              <>
                当前城市「{city}」暂无旅居房源 · 旅居房源目前集中在贵阳
                <br />
                <button type="button" className="go-city" onClick={goGuiyang}>
                  去贵阳看旅居房源
                </button>
              </>
            ) : (
              '该频道暂无在架房源 · 运营商在后台录入并通过评级后自动上架'
            )}
          </div>
        ) : (
          projects.map((p) => {
            const pd = priceParts(p);
            const pn = perNight(p);
            const r = p.rating || {};
            const tags = (p.tags || []).filter((t) => t !== '保租房').slice(0, 3);
            const qs =
              nights >= MIN_NIGHTS
                ? `?checkin=${iso(ci)}${co ? `&checkout=${iso(co)}` : ''}`
                : '';
            const cover = p.cover_image
              ? { backgroundImage: `url(${assetUrl(p.cover_image)})` }
              : { backgroundImage: 'url(/assets/lvju/xijiang-night.jpg)' };
            return (
              <Link key={p.id} className="mcard" to={`/detail/${p.id}${qs}`}>
                <div className="img" style={cover}>
                  {CAIBEI && p.rating_status === 'passed' && r.stars ? (
                    <span className="star">
                      ★ {r.stars}.{r.score ? String(r.score).slice(-1) : '0'} 旅居
                    </span>
                  ) : null}
                  <div className="cap">
                    <div className="nm">{p.name}</div>
                    <div className="lo">{locOf(p, dmap)}</div>
                  </div>
                </div>
                <div className="ci">
                  <div className="tags">
                    {tags.length ? tags.map((t) => <span key={t}>{t}</span>) : <span>在架</span>}
                    {(p.insurance_types || []).map((t) => (
                      <span key={t.key || t.label}>
                        {t.icon || '🛡'} {t.short || t.label}
                      </span>
                    ))}
                  </div>
                  <div className="pr">
                    <b>
                      {nights >= MIN_NIGHTS && pn ? (
                        <>
                          ¥{formatPrice(pn * nights)}
                          <small>/ {nights} 晚</small>
                        </>
                      ) : pd.value != null ? (
                        <>
                          ¥{formatPrice(pd.value)}
                          <small>{priceUnitText(p)}</small>
                        </>
                      ) : (
                        pd.note
                      )}
                    </b>
                    {p.bookable ? <span className="bk">预订</span> : <span className="bk tel">📞 咨询</span>}
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </div>

      {CAIBEI ? (
        <a className="banner" href="/lvju-rating-standard.html">
          <span className="bi">★</span>
          <div className="bt">
            <b>什么是旅居星级旅居？</b>
            <p>5 维评定 + 公安/住建/保险验真，扫码可查</p>
          </div>
          <span className="go">看标准 ›</span>
        </a>
      ) : null}
    </div>
  );
}
