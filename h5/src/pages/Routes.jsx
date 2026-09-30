import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { routes as fetchRoutes } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity } from '../lib/city.js';
import '../styles/channel.css';

const FB = [
  '/assets/lvju/xijiang-night.jpg',
  '/assets/lvju/stilt-miao.jpg',
  '/assets/lvju/wanfenglin.jpg',
  '/assets/lvju/huangguoshu.jpg',
  '/assets/lvju/xiaoqikong.jpg',
  '/assets/lvju/fanjingshan.jpg',
  '/assets/lvju/qingyan.jpg',
  '/assets/lvju/countryside.jpg',
];

export default function Routes() {
  const city = useMemo(() => resolveHomeCity(), []);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [dayFilt, setDayFilt] = useState(0);

  useEffect(() => {
    setErr('');
    setRows(null);
    fetchRoutes({ city })
      .then((c) => setRows(c.routes || []))
      .catch(() => setErr('无法连接内容数据 · 请稍后再试'));
  }, [city]);

  const days = useMemo(() => {
    const d = [];
    (rows || []).forEach((r) => {
      if (r.days && !d.includes(r.days)) d.push(r.days);
    });
    return d.sort((a, b) => a - b);
  }, [rows]);

  const list = dayFilt ? (rows || []).filter((r) => r.days === dayFilt) : rows || [];

  return (
    <div className="chan-page">
      <div className="hero-sm routes">
        <div className="bg" />
        <div className="in">
          <div className="ek">Itineraries</div>
          <h1>
            跟着路线走
            <br />
            少走弯路
          </h1>
          <p>编辑精选行程，每站直达玩法笔记，住哪帮你选好</p>
        </div>
      </div>

      {days.length ? (
        <div className="filt">
          <a
            href="#all"
            className={!dayFilt ? 'on' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setDayFilt(0);
            }}
          >
            全部
          </a>
          {days.map((d) => (
            <a
              key={d}
              href={'#d-' + d}
              className={dayFilt === d ? 'on' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setDayFilt(d);
              }}
            >
              {d} 日
            </a>
          ))}
        </div>
      ) : null}

      <div>
        {err ? (
          <div className="empty" style={{ color: '#b45309' }}>
            {err}
          </div>
        ) : rows === null ? (
          <div className="empty">加载中…</div>
        ) : !list.length ? (
          <div className="empty">
            当前城市「{city}」暂无在架路线 · 可到找房枢纽切换城市
            <br />
            <Link className="go-city" to={`/search?city=${encodeURIComponent(city)}`}>
              去找房枢纽
            </Link>
          </div>
        ) : (
          list.map((r, idx) => {
            const stops = (r.stops || []).filter((s) => s.spot);
            let bg = assetUrl(r.cover_image);
            if (!bg) {
              for (const s of stops) {
                if (s.spot?.cover_image) {
                  bg = assetUrl(s.spot.cover_image);
                  break;
                }
              }
            }
            const lead = stops.length
              ? stops.length > 1
                ? `${stops[0].spot.name} → ${stops[stops.length - 1].spot.name}`
                : stops[0].spot.name
              : r.summary || '';
            return (
              <div key={r.id || r.name} className="rcard">
                <div className="rcard-hd" style={bg ? { backgroundImage: `url(${bg})` } : undefined}>
                  <div className="rcard-cap">
                    <b>{r.name}</b>
                    <small>
                      {lead} · {r.days} 日
                    </small>
                  </div>
                </div>
                <div className="rcard-bd">
                  <div className="tlday">
                    <div className="d">
                      <span className="n">1</span>
                      {r.days} 日行程 · {stops.length} 站
                    </div>
                    {stops.map((s, i) => {
                      const sp = s.spot;
                      const thumb = assetUrl(sp.cover_image) || FB[(idx + i) % FB.length];
                      return (
                        <div key={sp.id || i} className="tlstep">
                          <Link className="t" to={`/spot/${sp.id}`}>
                            {s.note || sp.name} <span className="badge">{sp.type_label || ''}</span>
                          </Link>
                          <div className="s">
                            {sp.summary || ''}
                            {sp.duration ? ` · ⏱ ${sp.duration}` : ''}
                          </div>
                          <div className="rthumb" style={{ backgroundImage: `url(${thumb})` }} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <Link className="banner" to={`/search?city=${encodeURIComponent(city)}`}>
        <span className="bi">
          <img src="/assets/lvju/icons/routes-bi.png" alt="" />
        </span>
        <div className="bt">
          <b>这条线路的住宿</b>
          <p>找房枢纽按城市 / 价格 / 评分帮你挑好房</p>
        </div>
        <span className="go">看住宿 ›</span>
      </Link>
    </div>
  );
}
