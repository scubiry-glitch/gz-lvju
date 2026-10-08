import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { catalog } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity } from '../lib/city.js';
import { formatPrice, priceParts, priceUnitText } from '../lib/price.js';
import '../styles/channel.css';

const CN = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五' };
const HI_WORDS = ['精装', '拎包', '近地铁', '南北通透', '家电', '电梯', '独卫', '阳台', '新装', '温馨'];
const FILT = ['全部', '整租', '合租', '月付', '拎包入住', '近地铁'];

function cnRoom(lb) {
  const m = String(lb || '').match(/^(\d)\s*居/);
  return m ? CN[m[1]] + '居' : lb || '';
}

function pickHighlight(tags) {
  for (const t of tags) {
    for (const w of HI_WORDS) {
      if (String(t).includes(w)) return t;
    }
  }
  return tags[0] || '';
}

export default function Changzu() {
  const [city] = useState(() => resolveHomeCity());
  const [filt, setFilt] = useState('全部');
  const [cat, setCat] = useState(null);
  const [err, setErr] = useState('');

  const load = useCallback((c) => {
    setErr('');
    setCat(null);
    catalog({ city: c, channel: 'rental' })
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

  const pmap = useMemo(() => {
    const m = {};
    (cat?.projects || []).forEach((p) => {
      m[p.id] = p;
    });
    return m;
  }, [cat]);

  const units = useMemo(() => {
    const rows = (cat?.units || []).filter((u) => {
      const p = pmap[u.project_id];
      return p && p.channel === 'rental' && !(p.tags || []).includes('旅居');
    });
    if (filt === '全部') return rows;
    return rows.filter((u) => {
      const p = pmap[u.project_id] || {};
      const hay = [(u.tags || []).join(' '), (p.tags || []).join(' '), u.layout_label || '', u.name || ''].join(' ');
      return hay.includes(filt);
    });
  }, [cat, pmap, filt]);

  return (
    <div className="chan-page">
      <div className="hero-sm changzu">
        <div className="bg" />
        <div className="in">
          <div className="ek">Long-term</div>
          <h1>
            长住贵州
            <br />
            慢享山居
          </h1>
          <p>整租、合租、月付，线上签约 + 资金存管，省心长住</p>
          <div className="stat">
            <div>
              <b>6,200+</b>
              <span>长租房源</span>
            </div>
            <div>
              <b>月付起</b>
              <span>灵活租期</span>
            </div>
            <div>
              <b>存管</b>
              <span>签约保障</span>
            </div>
          </div>
        </div>
      </div>

      <div className="filt">
        {FILT.map((f) => (
          <a
            key={f}
            href={'#f-' + f}
            className={filt === f ? 'on' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setFilt(f);
            }}
          >
            {f}
          </a>
        ))}
      </div>

      <div className="sec-h">
        <span className="bar" />
        <h2>在租房源</h2>
        <span className="more">{cat ? `共 ${units.length} 套在租` : '租金排序'}</span>
      </div>

      <div className="wrap">
        {err ? (
          <div className="empty" style={{ color: '#b45309' }}>
            {err}
          </div>
        ) : cat === null ? (
          <div className="empty">加载中…</div>
        ) : !units.length ? (
          <div className="empty">该频道暂无在租户型 · 运营商在后台录入后自动上架</div>
        ) : (
          units.map((u) => {
            const p = pmap[u.project_id] || {};
            const d = dmap[p.district_id];
            const tags = (u.tags || []).slice(0, 3);
            const hi = pickHighlight(tags);
            const room = cnRoom(u.layout_label);
            const title = p.name + (hi ? ' · ' + hi : '') + (room || '');
            const meta = [city, d ? d.name : '', u.area_sqm ? formatPrice(u.area_sqm) + '㎡' : '', u.layout_label || '']
              .filter(Boolean)
              .join(' · ');
            const pd = priceParts(p);
            const price = u.rent_monthly ? (
              <>
                ¥{formatPrice(u.rent_monthly)}
                <small> /月</small>
              </>
            ) : pd.value != null ? (
              <>
                ¥{formatPrice(pd.value)}
                <small>{priceUnitText(p)}</small>
              </>
            ) : (
              pd.note
            );
            const cover = u.cover_image
              ? { backgroundImage: `url(${assetUrl(u.cover_image)})` }
              : p.cover_image
                ? { backgroundImage: `url(${assetUrl(p.cover_image)})` }
                : { backgroundImage: 'url(/assets/lvju/guiyang-city.jpg)' };
            return (
              <Link key={u.id} className="lrow" to={`/detail/${p.id}`}>
                <div className="th" style={cover}>
                  <span className="star">{u.layout_label || '在租'}</span>
                </div>
                <div className="info">
                  <div className="nm">{title}</div>
                  <div className="meta">{meta}</div>
                  <div className="tags">
                    {tags.length ? tags.map((t) => <span key={t}>{t}</span>) : <span>在租</span>}
                  </div>
                  <div className="pr">
                    <b>{price}</b>
                    {p.bookable ? <span className="bk">预订</span> : <span className="bk tel">📞 咨询</span>}
                    <span className="unit">门店 · {p.name}</span>
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </div>

      <Link className="banner" to="/guide">
        <span className="bi">
          <img src="/assets/lvju/icons/changzu-guide-bi.png" alt="" />
        </span>
        <div className="bt">
          <b>想长住，也想置业？</b>
          <p>置业导购：看房团 · 贷款测算 · 1对1顾问</p>
        </div>
        <span className="go">去导购 ›</span>
      </Link>
    </div>
  );
}
