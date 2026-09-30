import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { catalog } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity, writeStoredCity } from '../lib/city.js';
import { formatPrice, priceParts, priceUnitText } from '../lib/price.js';
import { featureEnabled } from '../lib/features.js';
import '../styles/channel.css';

const CAIBEI = featureEnabled('caibei');

function locOf(p, dmap) {
  const d = dmap[p.district_id];
  if (d && p.address && String(p.address).indexOf(d.name) === 0) return p.address;
  return Array.from(new Set([d ? d.name : '', p.address || ''].filter(Boolean))).join(' · ');
}

export default function Minsu() {
  const navigate = useNavigate();
  const [city, setCity] = useState(() => resolveHomeCity());
  const [dist, setDist] = useState('');
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback((c) => {
    setErr('');
    setCat(null);
    catalog({ city: c, channel: 'minsu' })
      .then((data) => setCat(data))
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

  const projects = useMemo(
    () => (cat?.projects || []).filter((p) => p.channel === 'minsu'),
    [cat],
  );

  const dists = useMemo(() => {
    const used = [];
    projects.forEach((p) => {
      const n = dmap[p.district_id]?.name;
      if (n && !used.includes(n)) used.push(n);
    });
    return used;
  }, [projects, dmap]);

  const rows = useMemo(() => {
    if (!dist) return projects;
    return projects.filter((p) => {
      const d = dmap[p.district_id];
      return (d && d.name === dist) || String(p.address || '').includes(dist);
    });
  }, [projects, dist, dmap]);

  function goGuiyang() {
    writeStoredCity('贵阳');
    setCity('贵阳');
    setDist('');
    navigate('/minsu?city=贵阳', { replace: true });
  }

  return (
    <div className="chan-page">
      <div className="appbar ghost">
        <Link className="bk" to="/" onClick={(e) => {
          if (history.length > 1) {
            e.preventDefault();
            history.back();
          }
        }}>
          ‹
        </Link>
        <div className="ttl">
          民宿<small>整栋 · 庭院 · 管家</small>
        </div>
      </div>

      <div className="hero-sm minsu">
        <div className="bg" />
        <div className="in">
          <div className="ek">Boutique Stay</div>
          <h1>
            住进一间
            <br />
            有主人的房子
          </h1>
          <p>整栋包栋、精品民宿，每一间都有完整房型介绍</p>
          <div className="stat">
            <div>
              <b>1,800+</b>
              <span>认证民宿</span>
            </div>
            <div>
              <b>多样</b>
              <span>特色房型</span>
            </div>
            <div>
              <b>验真</b>
              <span>扫码可查</span>
            </div>
          </div>
        </div>
      </div>

      {dists.length ? (
        <div className="filt">
          <a
            href="#all"
            className={!dist ? 'on' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setDist('');
            }}
          >
            全部区域
          </a>
          {dists.map((n) => (
            <a
              key={n}
              href={'#d-' + n}
              className={dist === n ? 'on' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setDist(n);
              }}
            >
              {n}
            </a>
          ))}
        </div>
      ) : null}

      <div className="sec-h">
        <span className="bar" />
        <h2>民宿门店</h2>
        <span className="more">{cat ? `共 ${rows.length} 栋在营` : '综合排序'}</span>
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
                当前城市「{city}」暂无民宿 · 民宿房源目前集中在贵阳
                <br />
                <button type="button" className="go-city" onClick={goGuiyang}>
                  去贵阳看民宿
                </button>
              </>
            ) : (
              '该频道暂无在架民宿 · 托管商家录入并上架后自动展示'
            )}
          </div>
        ) : !rows.length ? (
          <div className="empty">该区域暂无在架民宿 · 切换区域或从「找房」进入</div>
        ) : (
          rows.map((p) => {
            const pd = priceParts(p);
            const r = p.rating || {};
            const tags = (p.tags || []).slice(0, 3);
            const cover = p.cover_image
              ? { backgroundImage: `url(${assetUrl(p.cover_image)})` }
              : { backgroundImage: 'url(/assets/lvju/xijiang-night.jpg)' };
            return (
              <Link key={p.id} className="mcard" to={`/detail/${p.id}`}>
                <div className="img" style={cover}>
                  {CAIBEI && p.rating_status === 'passed' && r.stars ? (
                    <span className="star">★ {r.stars} 星民宿</span>
                  ) : null}
                  <div className="cap">
                    <div className="nm">{p.name}</div>
                    <div className="lo">{locOf(p, dmap)}</div>
                  </div>
                </div>
                <div className="ci">
                  <div className="tags">
                    {tags.length ? tags.map((t) => <span key={t}>{t}</span>) : <span>在架</span>}
                  </div>
                  <div className="pr">
                    <b>
                      {pd.value != null ? (
                        <>
                          ¥{formatPrice(pd.value)}
                          <small>{priceUnitText(p)}</small>
                        </>
                      ) : (
                        <span style={{ fontSize: 12, color: '#9aa5a1' }}>{pd.note}</span>
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
        <div className="banner">
          <span className="bi">🛡</span>
          <div className="bt">
            <b>每间民宿一张验真卡</b>
            <p>公安实名 · 住建备案 · 安心险，扫码核验</p>
          </div>
          <a className="go" href="/lvju-rating-standard.html">
            了解 ›
          </a>
        </div>
      ) : null}
    </div>
  );
}
