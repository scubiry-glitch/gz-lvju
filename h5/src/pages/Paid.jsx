import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { bookingLookup, bookingPaymentQuery } from '../lib/api.js';
import { formatPrice } from '../lib/price.js';
import '../styles/booking.css';

/** 支付回跳确认页：?channel=booking&order_no=&phone=&app_order_id= */
export default function Paid() {
  const [sp] = useSearchParams();
  const orderNo = (sp.get('order_no') || '').trim();
  const phone = (sp.get('phone') || '').trim();
  const [order, setOrder] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orderNo) {
      setErr('缺少订单号');
      setLoading(false);
      return;
    }
    let alive = true;
    let tries = 0;
    let timer;
    let inFlight = false;
    const poll = async () => {
      if (inFlight || !alive) return;
      inFlight = true;
      clearTimeout(timer);
      try {
        // Old deployments return a raw gateway envelope, and their query can
        // fail while the business lookup remains available. Keep that fallback.
        const payment = await bookingPaymentQuery({ order_no: orderNo, contact_phone: phone }).catch(() => null);
        const lookup = await bookingLookup({ order_no: orderNo, contact_phone: phone });
        if (!alive) return;
        const original = lookup.order || lookup;
        const state = window.BZF_CASHIER.orderStatus(payment, original);
        const o = { ...original, pay_status: state };
        setOrder(o);
        setErr('');
        setLoading(false);
        if (!['paid', 'closed', 'expired', 'refunded', 'partially_refunded'].includes(state) && tries++ < 6) {
          timer = setTimeout(poll, 1500);
        }
      } catch (e) {
        if (!alive) return;
        setErr(e.message || '查单失败');
        setLoading(false);
      } finally { inFlight = false; }
    };
    poll();
    const resume = () => { if (document.visibilityState === 'visible') { tries = 0; clearTimeout(timer); poll(); } };
    document.addEventListener('visibilitychange', resume);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [orderNo, phone]);

  const paid = order && order.pay_status === 'paid';

  return (
    <div className="booking-page">
      <div className="steps">
        <span className="st">
          <span className="n">1</span>预定下单
        </span>
        <span className="sep">›</span>
        <span className="st">
          <span className="n">2</span>在线支付
        </span>
        <span className="sep">›</span>
        <span className={'st' + (paid ? ' on' : '')}>
          <span className="n">3</span>完成
        </span>
      </div>

      {loading ? (
        <div className="bk-pad muted">正在确认支付结果…</div>
      ) : err ? (
        <div className="berr">{err}</div>
      ) : (
        <div className="okbox" style={paid ? undefined : { background: '#fffbeb', borderColor: '#f59e0b' }}>
          <div className="ok-ic" style={paid ? undefined : { background: '#b45309' }}>
            {paid ? '✓' : '!'}
          </div>
          <div className="ok-t">{paid ? '支付成功' : ['closed', 'expired'].includes(order.pay_status) ? '订单已关闭' : order.pay_status === 'refunded' ? '退款已完成' : order.pay_status === 'partially_refunded' ? '已部分退款' : order.pay_status === 'refunding' ? '退款处理中' : '支付处理中'}</div>
          <div className="ok-s">
            {(order.project_name || '旅居预订') +
              (order.checkin ? ' · ' + order.checkin + ' → ' + (order.checkout || '') : '') +
              (order.nights ? ' · ' + order.nights + ' 晚' : '')}
          </div>
          <div className="ok-no">{order.order_no || orderNo}</div>
          {order.price_total != null ? (
            <div className="ok-hint">订单金额 ¥{formatPrice(order.price_total)}</div>
          ) : null}
          <div className="ok-hint">
            {paid ? '商家确认后订单生效 · 可在订单页查看进度' : ['refunding', 'refunded', 'partially_refunded'].includes(order.pay_status) ? '退款进度以订单页为准' : ['closed', 'expired'].includes(order.pay_status) ? '该预订已结束，可在订单页查看详情' : '若已完成支付，请稍后在订单页刷新状态'}
          </div>
          <Link className="btn" to="/orders">
            查看我的订单 →
          </Link>
          {order.project_id ? (
            <Link className="btn ghost" to={`/detail/${order.project_id}`}>
              返回房源
            </Link>
          ) : (
            <Link className="btn ghost" to="/">
              回首页
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
