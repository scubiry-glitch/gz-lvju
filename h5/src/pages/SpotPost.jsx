import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, spot as fetchSpot } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import '../styles/spot-post.css';

const STAR_KEY = 'bzf_spot_star';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mdInline(x) {
  return esc(x)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m0, t, u) =>
      /^(https?:\/\/|\/|assets\/)/i.test(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : m0,
    );
}

function mdBody(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      if (!lines.length) return '';
      if (lines.length === 1 && /^#{1,6}\s+/.test(lines[0])) return `<h3>${mdInline(lines[0].replace(/^#{1,6}\s+/, ''))}</h3>`;
      if (lines.every((l) => /^[-*]\s+/.test(l)))
        return `<ul>${lines.map((l) => `<li>${mdInline(l.replace(/^([-*]\s+)+/, ''))}</li>`).join('')}</ul>`;
      if (lines.every((l) => /^\d+[.、]\s+/.test(l)))
        return `<ol>${lines.map((l) => `<li>${mdInline(l.replace(/^\d+[.、]\s+/, ''))}</li>`).join('')}</ol>`;
      if (lines.every((l) => /^>\s?/.test(l)))
        return `<blockquote>${mdInline(lines.map((l) => l.replace(/^>\s?/, '')).join(' '))}</blockquote>`;
      return `<p>${lines.map(mdInline).join('<br>')}</p>`;
    })
    .join('');
}

function readStars() {
  try {
    return JSON.parse(localStorage.getItem(STAR_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

export default function SpotPost() {
  const { id } = useParams();
  const navigate = useNavigate();
  const sid = parseInt(id || '', 10);
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [idx, setIdx] = useState(0);
  const [starred, setStarred] = useState(() => !!readStars()[sid]);
  const [foll, setFoll] = useState(false);
  const [shareHint, setShareHint] = useState('');
  const [matchedTickets, setMatchedTickets] = useState([]);
  const stripRef = useRef(null);

  useEffect(() => {
    if (!sid) {
      setErr('缺少笔记 id · 从房源详情页「周边玩法」点进来即可');
      return;
    }
    setErr('');
    setData(null);
    fetchSpot(sid)
      .then((d) => setData(d))
      .catch(() => setErr('笔记不存在或已下架'));
  }, [sid]);

  useEffect(() => {
    setStarred(!!readStars()[sid]);
  }, [sid]);

  const s = data?.spot || {};
  const related = data?.related || [];
  useEffect(() => {
    setMatchedTickets([]);
    if (s.type !== 'scenic' || !s.id) return;
    let active = true;
    api('/api/commerce/v1/catalog').then((response) => {
      if (!active) return;
      const products = Array.isArray(response?.data) ? response.data : [];
      setMatchedTickets(products.filter((p) => p.kind === 'skus' && p.category_id === 'scenic_ticket' && (s.city_id == null || Number(p.city_id) === Number(s.city_id)) && (p.spot_ids || []).some((id) => Number(id) === Number(s.id))));
    }).catch(() => { if (active) setMatchedTickets([]); });
    return () => { active = false; };
  }, [s.id, s.type]);
  const imgs = useMemo(() => {
    const out = [];
    if (s.cover_image) out.push(s.cover_image);
    (Array.isArray(s.photos) ? s.photos : []).forEach((u) => {
      if (u && !out.includes(u)) out.push(u);
    });
    if (!out.length) out.push('/assets/lvju/countryside.jpg');
    return out.map((u) => assetUrl(u) || u);
  }, [s]);

  const bodyHtml = useMemo(() => {
    const text = (s.body || '').trim() || s.summary || '';
    return mdBody(text);
  }, [s.body, s.summary]);

  const guideRows = useMemo(
    () =>
      [
        ['📍 地址', s.address],
        ['⏱ 建议停留', s.duration],
        ['🎫 门票', s.ticket],
      ].filter((r) => r[1]),
    [s.address, s.duration, s.ticket],
  );

  function onScroll() {
    const el = stripRef.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    setIdx(Math.max(0, Math.min(imgs.length - 1, i)));
  }

  function toggleStar() {
    const store = readStars();
    if (store[sid]) delete store[sid];
    else store[sid] = true;
    try {
      localStorage.setItem(STAR_KEY, JSON.stringify(store));
    } catch {
      /* ignore */
    }
    setStarred(!!store[sid]);
  }

  function share() {
    const url = location.href;
    if (navigator.share) {
      navigator.share({ title: s.name || '周边笔记', url }).catch(() => {});
      return;
    }
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => {
        setShareHint('✓ 链接已复制');
        setTimeout(() => setShareHint(''), 1600);
      });
    }
  }

  function goBack(e) {
    e.preventDefault();
    if (history.length > 1) navigate(-1);
    else navigate('/spots');
  }

  if (err) {
    return (
      <div className="spot-post">
        <div className="miss">
          {err}
          <br />
          <Link to="/spots">去「周边玩法」看看 ›</Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="spot-post">
        <div className="miss">加载中…</div>
      </div>
    );
  }

  return (
    <div className="spot-post">
      <div className="gal">
        <div className="strip" ref={stripRef} onScroll={onScroll}>
          {imgs.map((u, i) => (
            <div key={i} className="cell" style={{ backgroundImage: `url(${u})` }} />
          ))}
        </div>
        <a className="bk" href="/spots" onClick={goBack}>
          ‹
        </a>
        {imgs.length > 1 ? <span className="cnt">{idx + 1}/{imgs.length}</span> : null}
        {imgs.length > 1 ? (
          <div className="dots">
            {imgs.map((_, i) => (
              <i key={i} className={i === idx ? 'on' : undefined} />
            ))}
          </div>
        ) : null}
      </div>

      <div className="hd">
        <div className="editor">
          <div className="av">{s.icon || '🧭'}</div>
          <div>
            <div className="nm">旅居在地笔记</div>
            <div className="sub">山舍编辑部 · 实地探访整理</div>
          </div>
          <button type="button" className={`foll${foll ? ' on' : ''}`} onClick={() => setFoll((v) => !v)}>
            {foll ? '已关注' : '＋ 关注'}
          </button>
        </div>
        <div className="pt">{s.name || ''}</div>
        <div className="pmeta">
          <span className="ty">{s.type_label || '周边'}</span>
          <span>{s.city_id == null ? '全省 · 跨市目的地' : '本地 · 值得专程去'}</span>
        </div>
      </div>

      <div className="body" dangerouslySetInnerHTML={{ __html: bodyHtml }} />

      {(s.tags || []).length ? (
        <div className="tagsrow">
          {(s.tags || []).map((t) => (
            <Link key={t} to="/spots">
              #{t}
            </Link>
          ))}
        </div>
      ) : null}

      {guideRows.length || s.type === 'scenic' ? (
        <div className="guide">
          <div className="gt">去之前 · 攻略信息</div>
          {guideRows.map(([k, v]) => (
            <div key={k} className="row">
              <span className="k">{k}</span>
              <span>{v}</span>
            </div>
          ))}
          {s.type === 'scenic' ? (
            <>
              {matchedTickets.length ? (
                <div className="matched-tickets">
                  <b>适用此景点的门票券</b>
                  {matchedTickets.map((ticket) => (
                    <a key={ticket.id} href={`/juzhu-voucher.html?kind=skus&id=${encodeURIComponent(ticket.id)}&city=${encodeURIComponent(ticket.city_id)}`}>
                      <span>{ticket.name}</span>
                      <small>{ticket.in_stock ? `¥${(Number(ticket.price_minor || 0) / 100).toFixed(2)} · 查看权益` : '暂时缺货 · 查看详情'}</small>
                    </a>
                  ))}
                </div>
              ) : null}
            <a
              className="ticket-link"
              href={`/juzhu-vouchers.html?${s.city_id == null ? '' : `city=${encodeURIComponent(s.city_id)}&`}kind=skus&category=scenic_ticket`}
            >
              {s.city_id == null ? '浏览平台门票券' : '浏览该城市门票券'} <span aria-hidden="true">›</span>
              <small>适用景点与城市以券详情为准</small>
            </a>
            </>
          ) : null}
        </div>
      ) : null}

      {related.length ? (
        <div className="rel">
          <div className="rt">
            <span className="bar" />
            相关笔记 · RELATED
          </div>
          <div className="strip">
            {related.map((r) => (
              <Link key={r.id} className="rc" to={`/spot/${r.id}`}>
                <div className="im" style={{ backgroundImage: `url(${assetUrl(r.cover_image) || ''})` }}>
                  <span className="ty">{r.type_label || ''}</span>
                </div>
                <div className="nm">{r.name}</div>
                <div className="sm">{r.summary || ''}</div>
              </Link>
            ))}
          </div>
        </div>
      ) : null}

      <div className="obar">
        <button type="button" className={`star${starred ? ' on' : ''}`} onClick={toggleStar}>
          {starred ? '★ 已收藏' : '♡ 收藏'}
        </button>
        <button type="button" onClick={share}>
          {shareHint || '↗ 分享'}
        </button>
      </div>
    </div>
  );
}
