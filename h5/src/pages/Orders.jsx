import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import CancelOrderSheet from '../components/CancelOrderSheet.jsx';
import { myBookings } from '../lib/api.js';
import { useAuthUser } from '../lib/auth-context.jsx';
import { assetUrl } from '../lib/asset.js';
import { formatPrice, formatMoney } from '../lib/price.js';
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
    if (o.pay_status === 'coupon_funded') return ['已用券 · 待商家确认', 'stay'];
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
    if (o.status === 'pending' && (ps === 'paid' || ps === 'coupon_funded')) return true;
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
  const { clearSession, goLogin } = useAuthUser();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'all';
  const [items, setItems] = useState([]);
  const [loadErr, setLoadErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [cx, setCx] = useState(null);

  const loadMine = useCallback((opts = {}) => {
    const silent = !!opts.silent;
    if (!silent) {
      setLoading(true);
      setLoadErr('');
    }
    return myBookings()
      .then((j) => setItems(j.items || []))
      .catch((e) => {
        if (e.status === 401) {
          clearSession();
          goLogin('/orders');
          return;
        }
        if (!silent) setLoadErr('加载失败');
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, [clearSession, goLogin]);

  useEffect(() => {
    loadMine();
  }, [loadMine]);

  function setTab(id) {
    const p = new URLSearchParams(params);
    if (id === 'all') p.delete('tab');
    else p.set('tab', id);
    setParams(p, { replace: true });
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
                      {Number(o.coupon_minor) > 0 ? <>结算 ¥{formatMoney(o.price_total)} · 券抵 ¥{formatMoney(Number(o.coupon_minor) / 100)} · 现金应付 <b>¥{formatMoney(Number(o.cash_due_minor) / 100)}</b></> : <>合计 <b>¥{formatPrice(o.price_total)}</b></>} · 订单号 {o.order_no || '—'}
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
                    <Link
                      to={
                        '/booking?order_no=' +
                        encodeURIComponent(o.order_no) +
                        (o.contact_phone_raw ? '&phone=' + encodeURIComponent(o.contact_phone_raw) : '')
                      }
                    >
                      去支付
                    </Link>
                  ) : null}
                  {o.project_id && o.project_status === 'online' ? (
                    <Link to={`/detail/${o.project_id}`}>房源详情</Link>
                  ) : (
                    <span className="muted" style={{ fontSize: 12, color: 'var(--muted)', padding: '7px 0' }}>
                      {o.project_id ? '房源已下架' : '暂无房源'}
                    </span>
                  )}
                  <Link className="primary" to={`/order/${encodeURIComponent(o.order_no)}`}>
                    订单详情
                  </Link>
                </div>
              </div>
            );
          })
        )}
      </div>

      <CancelOrderSheet
        order={cx}
        onClose={() => setCx(null)}
        onSuccess={async (o) => {
          const no = o && o.order_no;
          if (no) {
            setItems((prev) =>
              prev.map((it) =>
                it.order_no === no ? { ...it, status: 'cancelled', can_cancel: false } : it,
              ),
            );
          }
          setCx(null);
          await loadMine({ silent: true });
        }}
      />
    </div>
  );
}

export default function Orders() {
  return <OrdersBody />;
}
