import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import CancelOrderSheet from '../components/CancelOrderSheet.jsx';
import { myBookings } from '../lib/api.js';
import { useAuthUser } from '../lib/auth-context.jsx';
import { assetUrl } from '../lib/asset.js';
import { formatMoney, formatPrice } from '../lib/price.js';
import '../styles/order-detail.css';

const REFUND_PS = { refunding: 1, refunded: 1, refund_failed: 1, manual_review: 1 };
const UNPAID_PS = { unpaid: 1, creating: 1, paying: 1, create_unknown: 1 };

function stOf(o) {
  if (REFUND_PS[o.pay_status] || REFUND_PS[o.refund_status]) {
    if (o.pay_status === 'refunding' || o.refund_status === 'refunding') {
      return ['退款处理中', '退款处理中，请留意到账通知'];
    }
    if (
      o.pay_status === 'refund_failed' ||
      o.pay_status === 'manual_review' ||
      o.refund_status === 'refund_failed' ||
      o.refund_status === 'manual_review'
    ) {
      return ['退款异常', '请联系客服处理'];
    }
    if (o.status === 'cancelled') return ['已取消 · 已退款', '退款已完成'];
    return ['已退款', '退款已完成'];
  }
  if (o.status === 'pending') {
    if (o.pay_status === 'unpaid') return ['待支付', '请尽快完成支付，超时将自动取消并释放房态'];
    if (UNPAID_PS[o.pay_status]) return ['支付确认中', '正在确认支付结果，请稍候'];
    if (o.pay_status === 'paid') return ['已支付 · 待商家确认', '支付成功，等待商家确认'];
    if (o.pay_status === 'coupon_funded') return ['已用券 · 待商家确认', '卡券已抵扣，等待商家确认'];
    return ['待商家确认', '退改口径见下方提示'];
  }
  if (o.status === 'confirmed') return ['已确认 · 待入住', '商家已确认，按入住日期到店'];
  if (o.status === 'cancelled') return ['已取消', '订单已取消'];
  return [o.status || '—', ''];
}

function fmtNightAvg(o) {
  const nights = Math.max(Number(o.nights) || 1, 1);
  const total = Number(o.price_total) || 0;
  return formatPrice(Math.round(total / nights));
}

export default function OrderDetail() {
  const { orderNo: orderNoParam } = useParams();
  const orderNo = decodeURIComponent(orderNoParam || '').trim();
  const { clearSession, goLogin } = useAuthUser();
  const [order, setOrder] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);
  const [cxOpen, setCxOpen] = useState(false);

  const load = useCallback((opts = {}) => {
    const silent = !!opts.silent;
    if (!orderNo) {
      setErr('缺少订单号');
      setLoading(false);
      return Promise.resolve();
    }
    if (!silent) {
      setLoading(true);
      setErr('');
    }
    return myBookings()
      .then((j) => {
        const o = (j.items || []).find((x) => x.order_no === orderNo);
        if (!o) {
          setErr('未找到该订单');
          setOrder(null);
          return;
        }
        setOrder(o);
      })
      .catch((e) => {
        if (e.status === 401) {
          clearSession();
          goLogin('/order/' + encodeURIComponent(orderNo));
          return;
        }
        if (!silent) setErr(e.message || '加载失败');
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, [orderNo, clearSession, goLogin]);

  useEffect(() => {
    load();
  }, [load]);

  const sheet = (
    <CancelOrderSheet
      order={cxOpen ? order : null}
      onClose={() => setCxOpen(false)}
      onSuccess={async (o) => {
        if (o) setOrder({ ...o, status: 'cancelled', can_cancel: false });
        setCxOpen(false);
        await load({ silent: true });
      }}
    />
  );

  if (loading) {
    return (
      <>
        <div className="od-page">
          <div className="od-empty">加载中…</div>
        </div>
        {sheet}
      </>
    );
  }

  if (err || !order) {
    return (
      <>
        <div className="od-page">
          <div className="od-err">{err || '未找到该订单'}</div>
          <div className="od-cta">
            <Link className="ghost" to="/orders">
              返回订单
            </Link>
          </div>
        </div>
        {sheet}
      </>
    );
  }

  const st = stOf(order);
  const needPay = order.status === 'pending' && !!UNPAID_PS[order.pay_status];
  const canCancel = order.status === 'pending' && order.can_cancel !== false;
  const cover = order.project_cover
    ? { backgroundImage: `url(${assetUrl(order.project_cover)})` }
    : { backgroundImage: 'url(/assets/lvju/xijiang-night.jpg)' };
  const sub = order.cancel_policy_text ? (
    <>
      {order.checkin} 入住 ·{' '}
      <img className="ic-timer" src="/assets/lvju/icons/booking-timer.png" alt="" width="12" height="12" />
      {order.cancel_policy_text}
      {order.can_cancel === false && order.status === 'pending' ? ' · 已不可取消' : ''}
    </>
  ) : (
    <>
      {order.checkin} 入住 · {st[1]}
    </>
  );

  const payHref =
    '/booking?order_no=' +
    encodeURIComponent(order.order_no) +
    (order.contact_phone_raw ? '&phone=' + encodeURIComponent(order.contact_phone_raw) : '');

  return (
    <>
      <div className="od-page">
        <div className="od-status">
          <div className="s1">{st[0]}</div>
          <div className="s2">{sub}</div>
        </div>

        <div className="od-house">
          <div className="th" style={cover} />
          <div className="mi">
            <div className="nm">{order.project_name || `项目#${order.project_id}`}</div>
            <div className="meta">{order.channel === 'minsu' ? '民宿 · 整栋/庭院' : '租赁住宿'}</div>
            <div className="st">{order.unit_label || '整栋预订'}</div>
          </div>
        </div>

        <div className="od-seg">入住信息</div>
        <div className="od-panel">
          <div className="od-kv">
            <span className="k">入住 / 离店</span>
            <span className="v">
              {order.checkin} — {order.checkout} · {order.nights} 晚
            </span>
          </div>
          <div className="od-kv">
            <span className="k">房型</span>
            <span className="v">{order.unit_label || '整栋预订'}</span>
          </div>
          <div className="od-kv">
            <span className="k">入住人</span>
            <span className="v">{order.contact_name || '—'}</span>
          </div>
          <div className="od-kv">
            <span className="k">手机</span>
            <span className="v">{order.contact_phone_masked || order.contact_phone || '—'}</span>
          </div>
        </div>

        <div className="od-seg">价格明细</div>
        <div className="od-panel">
          <div className="od-kv">
            <span className="k">
              房费 ¥{fmtNightAvg(order)} × {order.nights} 晚
            </span>
            <span className="v">¥{formatPrice(order.price_total)}</span>
          </div>
          {Number(order.coupon_minor) > 0 ? (
            <>
              <div className="od-kv">
                <span className="k">券抵</span>
                <span className="v">−¥{formatMoney(Number(order.coupon_minor) / 100)}</span>
              </div>
              <div className="od-kv big">
                <span className="k">现金应付</span>
                <span className="v">¥{formatMoney(Number(order.cash_due_minor) / 100)}</span>
              </div>
            </>
          ) : (
            <div className="od-kv big">
              <span className="k">合计</span>
              <span className="v">¥{formatPrice(order.price_total)}</span>
            </div>
          )}
        </div>

        <div className="od-seg">订单信息</div>
        <div className="od-panel">
          <div className="od-kv">
            <span className="k">订单号</span>
            <span className="v">{order.order_no}</span>
          </div>
          <div className="od-kv">
            <span className="k">下单时间</span>
            <span className="v">{(order.created_at || '').replace('T', ' ').slice(0, 16) || '—'}</span>
          </div>
          <div className="od-kv">
            <span className="k">支付方式</span>
            <span className="v">
              {order.pay_status === 'coupon_funded'
                ? '权益券抵扣'
                : order.transaction_mode === 'payment' || order.pay_status === 'paid' || needPay
                  ? '在线支付'
                  : '在线预订 · 到店付'}
            </span>
          </div>
          <div className="od-kv">
            <span className="k">订单状态</span>
            <span className="v">{st[0]}</span>
          </div>
          <div className="od-kv">
            <span className="k">房源详情</span>
            <span className="v">
              {order.project_id && order.project_status === 'online' ? (
                <Link className="house-link" to={`/detail/${order.project_id}`}>
                  查看房源 →
                </Link>
              ) : (
                <span className="muted">{order.project_id ? '房源已下架' : '暂无房源'}</span>
              )}
            </span>
          </div>
        </div>

        <div className="od-cta">
          <Link className="ghost" to="/orders">
            返回订单
          </Link>
          {needPay ? (
            <Link className="btn" to={payHref}>
              去支付
            </Link>
          ) : null}
          {canCancel ? (
            <button type="button" className="danger" onClick={() => setCxOpen(true)}>
              取消订单
            </button>
          ) : null}
        </div>
      </div>
      {sheet}
    </>
  );
}
