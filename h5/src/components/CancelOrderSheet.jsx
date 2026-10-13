import { useState } from 'react';
import { createPortal } from 'react-dom';
import { cancelBooking } from '../lib/api.js';
import { formatPrice } from '../lib/price.js';
import '../styles/cancel-order.css';

function overlayHost() {
  return document.querySelector('.app-shell') || document.getElementById('root') || document.body;
}

/**
 * 取消订单确认底栏 — 订单列表 / 订单详情共用。
 * order 为空不渲染；成功后调 onSuccess，关闭调 onClose。
 */
export default function CancelOrderSheet({ order, onClose, onSuccess }) {
  const [busy, setBusy] = useState(false);

  if (!order) return null;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      const phone = order.contact_phone_raw || '';
      if (!order.order_no || !phone) {
        throw new Error('缺少订单号或手机号，无法取消');
      }
      await cancelBooking({
        order_no: order.order_no,
        contact_phone: phone,
      });
      // 等列表/详情刷新完再收尾，避免只关弹窗不拉接口
      await onSuccess?.(order);
    } catch (e) {
      alert(e.message || '取消失败');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      className="cx-mask"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose?.();
      }}
      role="presentation"
    >
      <div className="cx-card" role="dialog" aria-modal="true">
        <div className="cx-handle" aria-hidden />
        <h3>确认取消订单？</h3>
        <p className="cx-sub">取消后不可恢复，房态将立刻释放</p>
        <div className="cx-info">
          <div className="nm">{order.project_name || `项目#${order.project_id}`}</div>
          <div className="meta">
            {order.checkin} → {order.checkout} · {order.nights || '—'} 晚
            {order.order_no ? ` · ${order.order_no}` : ''}
          </div>
          <div className="amt">
            合计 <b>¥{formatPrice(order.price_total)}</b>
          </div>
        </div>
        {order.cancel_policy_text ? <div className="cx-tip">{order.cancel_policy_text}</div> : null}
        <div className="cx-acts">
          <button type="button" className="no" onClick={() => onClose?.()} disabled={busy}>
            再想想
          </button>
          <button type="button" className="yes" onClick={confirm} disabled={busy}>
            {busy ? '取消中…' : '确认取消'}
          </button>
        </div>
      </div>
    </div>,
    overlayHost(),
  );
}
