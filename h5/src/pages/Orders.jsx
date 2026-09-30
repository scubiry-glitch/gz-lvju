import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { cancelBooking, myBookings } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { formatPrice } from '../lib/price.js';
import '../styles/orders.css';

const TABS = [
  { id: 'all', label: '全部' },
  { id: 'unpaid', label: '待支付' },
  { id: 'stay', label: '待入住' },
  { id: 'refund', label: '退款售后' },
];
const REFUND_PS = { refunding: 1, refunded: 1, refund_failed: 1, manual_review: 1 };
const UNPAID_PS = { unpaid: 1, creating: 1, paying: 1, create_unknown: 1 };

function stOf(o) {
  if (REFUND_PS[o.pay_status] || REFUND_PS[o.refund_status]) {
    if (o.pay_status === 'refunding' || o.refund_status === 'refunding') return ['退款处理中', 'wait'];
    if (
      o.pay_status === 'refund_failed' ||
      o.pay_status === 'manual_review' ||
      o.refund_status === 'refund_failed' ||
      o.refund_status === 'manual_review'
    )
      return ['退款异常', 'wait'];
    if (o.status === 'cancelled') return ['已取消 · 已退款', 'done'];
    return ['已退款', 'done'];
  }
  if (o.status === 'pending') {
    if (o.pay_status === 'unpaid') return ['待支付', 'wait'];
    if (UNPAID_PS[o.pay_status]) return ['支付确认中', 'wait'];
    if (o.pay_status === 'paid') return ['已支付 · 待商家确认', 'stay'];
    return ['待商家确认', 'wait'];
  }
  if (o.status === 'confirmed') return ['已确认 · 待入住', 'stay'];
  if (o.status === 'cancelled') return ['已取消', 'done'];
  return [o.status || '—', 'stay'];
}

function matchTab(o, tab) {
  const ps = o.pay_status || '';
  const rs = o.refund_status || '';
  const isRefund = !!(REFUND_PS[ps] || REFUND_PS[rs]);
  if (tab === 'unpaid') return !!UNPAID_PS[ps] && o.status !== 'cancelled';
  if (tab === 'stay') {
    if (isRefund || o.status === 'cancelled') return false;
    if (o.status === 'confirmed') return true;
    if (o.status === 'pending' && ps === 'paid') return true;
    return false;
  }
  if (tab === 'refund') return isRefund;
  return true;
}

function emptyHint(tab) {
  if (tab === 'unpaid') return '暂无待支付订单';
  if (tab === 'stay') return '暂无待入住订单';
  if (tab === 'refund') return '暂无退款售后订单';
  return '还没有预订 · 去「找房」挑一间';
}

function OrdersBody() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'all';
  const [items, setItems] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [cx, setCx] = useState(null);
  const [cxBusy, setCxBusy] = useState(false);

  const loadMine = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    myBookings()
      .then((j) => setItems(j.items || []))
      .catch((e) => {
        if (e.status === 401) {
          try {
            localStorage.removeItem('BJZ_TOKEN');
            localStorage.removeItem('BZF_SESSION_TOKEN');
          } catch {
            /* ignore */
          }
          location.reload();
          return;
        }
        setLoadErr('加载失败');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  function setTab(id) {
    const p = new URLSearchParams(params);
    if (id === 'all') p.delete('tab');
    else p.set('tab', id);
    setParams(p, { replace: true });
  }

  async function confirmCancel() {
    if (!cx || cxBusy) return;
    setCxBusy(true);
    try {
      await cancelBooking({ order_no: cx.order_no, contact_phone: cx.contact_phone_raw || '' });
      setCx(null);
      loadMine();
    } catch (e) {
      alert(e.message || '取消失败');
    } finally {
      setCxBusy(false);
    }
  }

  const shown = items.filter((o) => matchTab(o, tab));

  return (
    <div className="orders-page">
      <div className="otabs">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={'#tab-' + t.id}
            className={tab === t.id ? 'on' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setTab(t.id);
            }}
          >
            {t.label}
          </a>
        ))}
      </div>
      <div className="olist">
        {loading ? (
          <div className="empty">加载中…</div>
        ) : loadErr ? (
          <div className="empty" style={{ color: '#991b1b' }}>
            {loadErr}
          </div>
        ) : !shown.length ? (
          <div className="empty">
            {emptyHint(tab)}
            {tab === 'all' ? (
              <>
                <br />
                <Link to="/search" style={{ color: 'var(--brand)', fontWeight: 600 }}>
                  去找房
                </Link>
              </>
            ) : null}
          </div>
        ) : (
          shown.map((o) => {
            const st = stOf(o);
            const cover = o.project_cover
              ? { backgroundImage: `url(${assetUrl(o.project_cover)})` }
              : { backgroundImage: 'url(/assets/lvju/xijiang-night.jpg)' };
            return (
              <div className="ordcard" key={o.id || o.order_no}>
                <div className="oh">
                  <span className="shop">贝壳旅居 · {o.channel === 'minsu' ? '民宿' : '租赁住宿'}</span>
                  <span className={'stt ' + st[1]}>{st[0]}</span>
                </div>
                <div className="ob">
                  <div className="th" style={cover} />
                  <div className="oi">
                    <div className="nm">{o.project_name || `项目#${o.project_id}`}</div>
                    <div className="meta">
                      {o.checkin} → {o.checkout} · {o.nights} 晚
                    </div>
                    {o.cancel_policy_text ? <div className="meta">{o.cancel_policy_text}</div> : null}
                    <div className="amt">
                      合计 <b>¥{formatPrice(o.price_total)}</b> · 订单号 …{(o.order_no || '').slice(-4)}
                    </div>
                  </div>
                </div>
                <div className="of">
                  {o.status === 'pending' && o.can_cancel !== false ? (
                    <button type="button" className="cancel" onClick={() => setCx(o)}>
                      取消订单
                    </button>
                  ) : null}
                  {o.status === 'pending' && UNPAID_PS[o.pay_status] ? (
                    <a href={`/lvju-app-booking.html?order_no=${encodeURIComponent(o.order_no)}`}>去支付</a>
                  ) : null}
                  <Link to={`/detail/${o.project_id}`}>房源详情</Link>
                  <a className="primary" href={`/lvju-app-order-detail.html?order_no=${encodeURIComponent(o.order_no)}`}>
                    订单详情
                  </a>
                </div>
              </div>
            );
          })
        )}
      </div>

      {cx ? (
        <div
          className="cx-mask"
          onClick={(e) => {
            if (e.target === e.currentTarget) setCx(null);
          }}
          role="presentation"
        >
          <div className="cx-card" role="dialog" aria-modal="true">
            <div className="cx-handle" aria-hidden />
            <h3>确认取消订单？</h3>
            <p className="cx-sub">取消后不可恢复，房态将立刻释放</p>
            <div className="cx-info">
              <div className="nm">{cx.project_name || `项目#${cx.project_id}`}</div>
              <div className="meta">
                {cx.checkin} → {cx.checkout} · {cx.nights || '—'} 晚
                {cx.order_no ? ` · ${cx.order_no}` : ''}
              </div>
              <div className="amt">
                合计 <b>¥{formatPrice(cx.price_total)}</b>
              </div>
            </div>
            {cx.cancel_policy_text ? <div className="cx-tip">{cx.cancel_policy_text}</div> : null}
            <div className="cx-acts">
              <button type="button" className="no" onClick={() => setCx(null)} disabled={cxBusy}>
                再想想
              </button>
              <button type="button" className="yes" onClick={confirmCancel} disabled={cxBusy}>
                {cxBusy ? '取消中…' : '确认取消'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function Orders() {
  return <OrdersBody />;
}
