import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { catalog, topics as fetchTopics } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity } from '../lib/city.js';
import { featureEnabled } from '../lib/features.js';
import { formatPrice, priceParts, priceUnitText } from '../lib/price.js';
import '../styles/search.css';

const CAIBEI = featureEnabled('caibei');
const FALLBACK = {
  houniao: { label: '候鸟过冬', desc: '温暖过冬 · 候鸟式南飞旅居，连住 15 晚起' },
  kangyang: { label: '康养度假', desc: '森林 / 温泉 / 湿地 · 慢节奏康养目的地' },
  qinzi: { label: '亲子研学', desc: '田园 / 山林 · 带娃研学与自然课堂' },
  zhengdong: { label: '整栋包栋', desc: '整栋院落 · 家庭聚会与团建包栋' },
  bzf: { label: '保租房专区', desc: '国企持有方房源 · 白名单运营商运营 · 统一监管' },
};

function hasLvjuTag(p) {
  return (p.tags || []).includes('旅居');
}
function channelChip(p) {
  if (p.channel === 'rental') return hasLvjuTag(p) ? '旅居' : '长租';
  if (p.channel === 'minsu') return hasLvjuTag(p) ? '旅居' : '民宿';
  return ({ rental: '长租', minsu: '民宿', newhouse: '新房', resale: '二手' })[p.channel] || p.channel;
}

export default function Topic() {
  const { slug } = useParams();
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const city = sp.get('city') || resolveHomeCity();
  const [meta, setMeta] = useState(FALLBACK[slug] || { label: slug || '专题', desc: '' });
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!slug) {
      setErr('未指定专题');
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setErr('');
    Promise.all([
      catalog({ city, topic: slug }).catch((e) => {
        if (e.status === 404) throw new Error('专题不存在或已下架');
        throw e;
      }),
      fetchTopics().catch(() => ({ topics: [] })),
    ])
      .then(([c, tj]) => {
        if (!alive) return;
        setCat(c);
        const t = (tj.topics || []).find((x) => x.slug === slug);
        if (t) setMeta({ label: t.label || slug, desc: t.desc || FALLBACK[slug]?.desc || '' });
        else if (FALLBACK[slug]) setMeta(FALLBACK[slug]);
        document.title = (t?.label || FALLBACK[slug]?.label || slug) + ' · 找房专题';
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e.message || '加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [slug, city]);

  const dmap = {};
  (cat?.districts || []).forEach((d) => {
    dmap[d.id] = d;
  });
  const projects = cat?.projects || [];

  return (
    <div className="search-page">
      <div className="appbar">
        <Link
          className="bk"
          to="/search"
          onClick={(e) => {
            if (history.length > 1) {
              e.preventDefault();
              navigate(-1);
            }
          }}
        >
          ‹
        </Link>
        <div className="searchin" style={{ justifyContent: 'center', border: 0, background: 'transparent' }}>
          <b style={{ fontSize: 15 }}>{meta.label}</b>
        </div>
      </div>

      <div style={{ padding: '18px 16px 8px' }}>
        <div style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: 0.04, marginBottom: 6 }}>Live Topic · 找房专题</div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>{meta.label}</h1>
        {meta.desc ? <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{meta.desc}</p> : null}
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--muted)' }}>
          {city} · {loading ? '加载中…' : `${projects.length} 套房源在架`}
        </div>
      </div>

      <div className="hlist">
        {loading ? (
          <div className="search-empty">加载中…</div>
        ) : err ? (
          <div className="search-empty" style={{ color: '#b45309' }}>
            {err}
            <br />
            <Link to={`/search?city=${encodeURIComponent(city)}`} style={{ color: 'var(--brand)', fontWeight: 600 }}>
              去找房枢纽
            </Link>
          </div>
        ) : !projects.length ? (
          <div className="search-empty">
            该专题暂无在架房源
            <br />
            <Link to={`/search?city=${encodeURIComponent(city)}`} style={{ color: 'var(--brand)', fontWeight: 600 }}>
              去找房枢纽
            </Link>
          </div>
        ) : (
          projects.map((p) => {
            const d = dmap[p.district_id];
            const loc =
              d && p.address && String(p.address).indexOf(d.name) === 0
                ? p.address
                : [d ? d.name : '', p.address || ''].filter(Boolean).join(' · ');
            const cover = p.cover_image
              ? { backgroundImage: `url(${assetUrl(p.cover_image)})` }
              : { backgroundImage: 'url(/assets/lvju/xijiang-night.jpg)' };
            const pd = priceParts(p);
            const r = p.rating || {};
            return (
              <Link key={p.id} className="lcard" to={`/detail/${p.id}`}>
                <div className="im" style={cover}>
                  {p.is_featured ? <span className="bdg feat">精选</span> : null}
                </div>
                <div className="in">
                  <div className="t">
                    <span className="nm">{p.name}</span>
                    <span className="ch">{channelChip(p)}</span>
                  </div>
                  <div className="meta">
                    {CAIBEI && p.rating_status === 'passed' && r.stars ? (
                      <>
                        <span className="sc">★{r.stars}</span>
                        <span>{loc}</span>
                      </>
                    ) : (
                      <span>{loc}</span>
                    )}
                  </div>
                  <div className="bt">
                    <span className="pr">
                      {pd.value != null ? (
                        <>
                          <i>¥</i>
                          <b>{formatPrice(pd.value)}</b>
                          <small>{priceUnitText(p)}</small>
                        </>
                      ) : (
                        <span style={{ fontSize: 13 }}>{pd.note}</span>
                      )}
                    </span>
                    <span className="go">{p.bookable !== false ? '预订' : '查看'}</span>
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </div>

      <div style={{ padding: '8px 14px 28px' }}>
        <Link
          to={`/search?city=${encodeURIComponent(city)}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 14,
            background: 'linear-gradient(90deg, #fef3c7, #fffbeb)',
            border: '1px solid #fde68a',
            color: 'inherit',
            textDecoration: 'none',
          }}
        >
          <span style={{ fontSize: 22 }}>🔎</span>
          <span style={{ flex: 1 }}>
            <b style={{ display: 'block', fontSize: 14 }}>没找到想要的？</b>
            <small style={{ color: 'var(--muted)' }}>找房枢纽支持区域 / 价格筛选</small>
          </span>
          <span style={{ fontWeight: 700, color: 'var(--brand-deep)', fontSize: 13 }}>去筛选 ›</span>
        </Link>
      </div>
    </div>
  );
}
