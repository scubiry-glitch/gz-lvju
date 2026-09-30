import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { bookingLookup } from '../lib/api.js';
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
    const poll = () => {
      bookingLookup({ order_no: orderNo, contact_phone: phone })
        .then((j) => {
          if (!alive) return;
          const o = j.order || j;
          setOrder(o);
          setLoading(false);
          if (
            o.pay_status !== 'paid' &&
            (o.pay_status === 'paying' || o.pay_status === 'creating' || o.pay_status === 'create_unknown') &&
            tries < 6
          ) {
            tries += 1;
            setTimeout(poll, 1500);
          }
        })
        .catch((e) => {
          if (!alive) return;
          setErr(e.message || '查单失败');
          setLoading(false);
        });
    };
    poll();
    return () => {
      alive = false;
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
          <div className="ok-t">{paid ? '支付成功' : '支付处理中'}</div>
          <div className="ok-s">
            {(order.project_name || '旅居预订') +
              (order.checkin ? ' · ' + order.checkin + ' → ' + (order.checkout || '') : '') +
              (order.nights ? ' · ' + order.nights + ' 晚' : '')}
          </div>
          <div className="ok-no">{order.order_no || orderNo}</div>
          {order.price_total != null ? (
            <div className="ok-hint">实付 ¥{formatPrice(order.price_total)}</div>
          ) : null}
          <div className="ok-hint">
            {paid ? '商家确认后订单生效 · 可在订单页查看进度' : '若已完成支付，请稍后在订单页刷新状态'}
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
