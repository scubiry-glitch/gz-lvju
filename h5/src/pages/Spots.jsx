import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { spots as fetchSpots } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { resolveHomeCity } from '../lib/city.js';
import '../styles/spots.css';

const FB = [
  '/assets/lvju/xiaoqikong.jpg',
  '/assets/lvju/xijiang-night.jpg',
  '/assets/lvju/fanjingshan.jpg',
  '/assets/lvju/huangguoshu.jpg',
  '/assets/lvju/wanfenglin.jpg',
  '/assets/lvju/qingyan.jpg',
];

export default function Spots() {
  const city = useMemo(() => resolveHomeCity(), []);
  const [type, setType] = useState(() => {
    try {
      return new URLSearchParams(location.search).get('type') || '';
    } catch {
      return '';
    }
  });
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    setErr('');
    setRows(null);
    fetchSpots({ city })
      .then((c) => setRows(c.spots || []))
      .catch(() => setErr('无法连接内容数据 · 请稍后再试'));
  }, [city]);

  const types = useMemo(() => {
    const out = [];
    (rows || []).forEach((s) => {
      if (s.type && !out.find((t) => t.key === s.type)) out.push({ key: s.type, label: s.type_label || s.type });
    });
    return out;
  }, [rows]);

  const list = type ? (rows || []).filter((s) => s.type === type) : rows || [];

  return (
    <div className="spots-page">
      <div className="hero-sm">
        <div className="bg" />
        <div className="in">
          <div className="ek">Destinations</div>
          <h1>
            山水与人间
            <br />
            都值得一去
          </h1>
          <p>景点、市集、美食与咖啡，看完玩法顺手订旁边的旅居</p>
        </div>
      </div>

      {types.length ? (
        <div className="filt">
          <a
            href="#all"
            className={!type ? 'on' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setType('');
            }}
          >
            全部
          </a>
          {types.map((t) => (
            <a
              key={t.key}
              href={'#t-' + t.key}
              className={type === t.key ? 'on' : undefined}
              onClick={(e) => {
                e.preventDefault();
                setType(t.key);
              }}
            >
              {t.label}
            </a>
          ))}
        </div>
      ) : null}

      <div className="wrap">
        {err ? (
          <div className="empty" style={{ color: '#b45309' }}>
            {err}
          </div>
        ) : rows === null ? (
          <div className="empty">加载中…</div>
        ) : !list.length ? (
          <div className="empty">
            当前城市「{city}」暂无{type ? '该类' : ''}玩法内容
            <br />
            可到找房枢纽切换城市
            <br />
            <Link to={`/search?city=${encodeURIComponent(city)}`}>去找房枢纽</Link>
          </div>
        ) : (
          list.map((s, i) => {
            const bg = assetUrl(s.cover_image) || FB[i % FB.length];
            const lv = s.tags?.length ? s.tags.slice(0, 1).join('') : s.type_label || '';
            const meta = [s.address, s.ticket, s.duration].filter(Boolean);
            return (
              <Link key={s.id} className="spot" to={`/spot/${s.id}`}>
                <div className="bg" style={{ backgroundImage: `url(${bg})` }} />
                {lv ? <span className="lv">{lv}</span> : null}
                <div className="in">
                  <div className="nm">{s.name}</div>
                  <div className="meta">
                    {meta.length
                      ? meta.map((m) => <span key={m}>{m}</span>)
                      : s.summary
                        ? <span>{s.summary}</span>
                        : null}
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </div>

      <div className="banner">
        <span className="bi">住</span>
        <div className="bt">
          <b>看上了这片山水？</b>
          <p>找房枢纽按城市 / 价格 / 评分帮你挑好房</p>
        </div>
        <Link className="go" to={`/search?city=${encodeURIComponent(city)}`}>
          订旅居 ›
        </Link>
      </div>
    </div>
  );
}
