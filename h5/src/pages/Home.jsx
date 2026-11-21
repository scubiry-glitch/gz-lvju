import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { catalog, pickFeaturedProjects, spots } from '../lib/api.js';
import { HOME_CHANNELS, channelHref, channelShown, hiddenHomeTabSet } from '../lib/homeChannels.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity, syncCityToUrl, writeStoredCity } from '../lib/city.js';
import { priceLabel } from '../lib/price.js';
import { featureEnabled } from '../lib/features.js';
import CitySheet from '../components/CitySheet.jsx';
import PrivacyGate from '../components/PrivacyGate.jsx';
import '../styles/home.css';

function locOf(p, dmap) {
  const d = dmap[p.district_id];
  if (d && p.address && String(p.address).indexOf(d.name) === 0) return p.address;
  return Array.from(new Set([d ? d.name : '', p.address || ''].filter(Boolean))).join(' · ');
}

function starOf(p) {
  const r = p.rating || {};
  if (featureEnabled('caibei') && p.rating_status === 'passed' && r.stars) return `★ ${r.stars} 五彩贝旅居`;
  return '精选好房';
}

export default function Home() {
  const [city, setCity] = useState(() => resolveHomeCity());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [posts, setPosts] = useState(null);
  const [postsHide, setPostsHide] = useState(false);
  const [featured, setFeatured] = useState(null);
  const [dmap, setDmap] = useState({});
  const [featErr, setFeatErr] = useState('');
  /** null = catalog 未回，频道区先不渲染，避免 hidden_home_tabs 闪一下全量再裁剪 */
  const [hiddenTabs, setHiddenTabs] = useState(null);

  const load = useCallback((c) => {
    setPosts(null);
    setPostsHide(false);
    setFeatured(null);
    setFeatErr('');
    setHiddenTabs(null);

    spots({ city: c })
      .then((data) => {
        const list = (data.spots || []).slice(0, 3);
        if (!list.length) {
          setPostsHide(true);
          setPosts([]);
        } else {
          setPosts(list);
        }
      })
      .catch(() => {
        setPostsHide(true);
        setPosts([]);
      });

    catalog({ city: c })
      .then((cat) => {
        const { projects, dmap: dm } = pickFeaturedProjects(cat || {});
        setHiddenTabs(hiddenHomeTabSet(cat));
        setDmap(dm);
        setFeatured(projects);
      })
      .catch(() => {
        setFeatErr('无法连接新居住数据库');
        setFeatured([]);
        /* 失败也落盘配置（仅 FORCE_HIDDEN），避免频道区一直空白 */
        setHiddenTabs(hiddenHomeTabSet(null));
      });
  }, []);

  useEffect(() => {
    load(city);
  }, [city, load]);

  function pickCity(next) {
    setCity(next);
    writeStoredCity(next);
    syncCityToUrl(next);
    setSheetOpen(false);
  }

  return (
    <div className="home-root">
      <div className="hero">
        <div className="bgimg" />
        <div className="hero-in">
          <div className="hero-top">
            <div
              className="city-sw"
              role="button"
              tabIndex={0}
              onClick={() => setSheetOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setSheetOpen(true);
                }
              }}
            >
              <div className="cn">
                <svg className="pin" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path
                    d="M8 1.5c-2.6 0-4.7 2.1-4.7 4.7 0 3.5 4.7 8.3 4.7 8.3s4.7-4.8 4.7-8.3C12.7 3.6 10.6 1.5 8 1.5zm0 6.4a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4z"
                    fill="#fff"
                  />
                </svg>
                <span>{city}</span>
              </div>
              <div className="sub">贵州·旅居目的地</div>
            </div>
          </div>
          <div className="editorial">
            <div className="ek">Travel to Guizhou, Live More</div>
            <h2>
              旅居到贵州，
              <br />
              生活更精彩
            </h2>
            <p>旅居·置业·民宿·长租一处入口，精彩无限</p>
          </div>
        </div>
        <Link className="searchbar" to="/search">
          <span className="ic">
            <img src="/assets/lvju/icons/search-ic.svg?v=1" alt="" />
          </span>
          <span className="ph">搜目的地 / 楼盘 / 民宿 / 景区</span>
          <span className="go">搜索</span>
        </Link>
      </div>

      <div className="sheet">
        <div className="seg-h">
          <span className="bar" />
          <h3>找房·全频道</h3>
        </div>
        {hiddenTabs == null ? (
          <div className="home-empty" style={{ padding: '28px 0 8px' }}>
            加载中…
          </div>
        ) : (
          <div className="chan">
            {HOME_CHANNELS.filter((ch) => channelShown(ch.id, hiddenTabs)).map((ch) => (
              <Link key={ch.id} className="chan feat" to={channelHref(ch, city)}>
                {ch.badge ? <span className="nb">{ch.badge}</span> : null}
                <div className="ic">
                  {ch.icon ? <img src={ch.icon} alt="" /> : <span style={{ fontSize: 22, lineHeight: 1 }}>{ch.emoji}</span>}
                </div>
                <b>{ch.label}</b>
                <small>{ch.hint}</small>
              </Link>
            ))}
          </div>
        )}

        <Link className="feature" to={`/routes?city=${encodeURIComponent(city)}`}>
          <div className="fbg" />
          <div className="fin">
            <div className="fk">Editor&apos;s Pick · 旅居周刊</div>
            <h4>
              黔东南秘境
              <br />
              住进千户苗寨的云端
            </h4>
            <p>编辑实地探访 12 处特色旅居 · 含双早 + 苗寨向导</p>
          </div>
        </Link>

        {!postsHide ? (
          <div>
            <div className="seg-h" style={{ marginTop: 24 }}>
              <span className="bar" />
              <h3>精选笔记 · 在地发现</h3>
            </div>
            <div className="poststrip">
              {posts === null ? (
                <div className="home-empty" style={{ padding: '22px 0' }}>
                  加载中…
                </div>
              ) : (
                posts.map((s) => (
                  <Link key={s.id} className="postcard" to={`/spot/${s.id}`}>
                    <div
                      className="pic"
                      style={{
                        backgroundImage: `url(${assetUrl(s.cover_image) || '/assets/lvju/countryside.jpg'})`,
                      }}
                    >
                      <span className="type">{s.type_label || '在地笔记'}</span>
                    </div>
                    <div className="pcopy">
                      <b>{s.name}</b>
                      <p>{s.summary || ''}</p>
                    </div>
                  </Link>
                ))
              )}
            </div>
          </div>
        ) : null}

        <div className="seg-h" style={{ marginTop: 24 }}>
          <span className="bar" />
          <h3>精选好房 · 特色旅居</h3>
        </div>
        <div className="list">
          {featErr ? (
            <div className="home-empty warn">{featErr}</div>
          ) : featured === null ? (
            <div className="home-empty">加载中…</div>
          ) : featured.length === 0 ? (
            <div className="home-empty" style={{ padding: '60px 0 0' }}>
              {city}暂无在架精选房源 · 可切换城市查看
            </div>
          ) : (
            featured.map((p, i) => {
              const pl = priceLabel(p);
              const tags = (p.tags || []).filter((t) => t !== '保租房').slice(0, 3);
              const coverStyle = p.cover_image
                ? { background: `url(${assetUrl(p.cover_image)}) center/cover, #0c4d44` }
                : undefined;
              return (
                <div className="mcard" key={p.id}>
                  <div className={'img' + (p.cover_image ? '' : i % 2 ? ' b' : ' a')} style={coverStyle}>
                    <span className="star">{starOf(p)}</span>
                    <div className="cap">
                      <div className="nm">{p.name}</div>
                      <div className="lo">{locOf(p, dmap)}</div>
                    </div>
                  </div>
                  <div className="ci">
                    <div className="tags">
                      {tags.length ? tags.map((t) => <span key={t}>{t}</span>) : <span>精选</span>}
                    </div>
                    <div className="pr">
                      <b>
                        {pl.kind === 'value' ? (
                          <>
                            {pl.text}
                            <small>{pl.unit}</small>
                          </>
                        ) : (
                          pl.text
                        )}
                      </b>
                      <Link className="bk" to={`/detail/${p.id}`}>
                        预订
                      </Link>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <CitySheet open={sheetOpen} city={city} onClose={() => setSheetOpen(false)} onPick={pickCity} />
      <PrivacyGate />
    </div>
  );
}
