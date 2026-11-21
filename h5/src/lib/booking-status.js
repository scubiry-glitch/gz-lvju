/** 预订订单状态文案 / 可否取消 — 列表与详情共用 */

export const REFUND_PS = { refunding: 1, refunded: 1, refund_failed: 1, manual_review: 1 };
export const UNPAID_PS = { unpaid: 1, creating: 1, paying: 1, create_unknown: 1 };

/** 客户侧是否还能点「取消订单」 */
export function canCancelBooking(o) {
  if (!o || o.status !== 'pending') return false;
  if (o.can_cancel === false) return false;
  // 支付关闭 / 退款中：取消已受理，勿再展示取消按钮
  if (o.pay_status === 'closing' || o.pay_status === 'refunding') return false;
  if (o.refund_status === 'refunding') return false;
  return true;
}

/**
 * @returns {[label: string, kind: 'wait'|'stay'|'done', hint?: string]}
 */
export function bookingStatusOf(o) {
  if (!o) return ['—', 'stay', ''];

  if (o.status === 'cancelled') {
    if (o.pay_status === 'refunding' || o.refund_status === 'refunding') {
      return ['退款处理中', 'wait', '退款处理中，请留意到账通知'];
    }
    if (
      o.pay_status === 'refund_failed' ||
      o.pay_status === 'manual_review' ||
      o.refund_status === 'refund_failed' ||
      o.refund_status === 'manual_review'
    ) {
      return ['退款异常', 'wait', '请联系客服处理'];
    }
    if (REFUND_PS[o.pay_status] || REFUND_PS[o.refund_status]) {
      return ['已取消 · 已退款', 'done', '退款已完成'];
    }
    return ['已取消', 'done', '订单已取消'];
  }

  if (o.pay_status === 'closing') {
    return ['取消处理中', 'wait', '正在关闭支付单，完成后订单将变为已取消'];
  }

  if (REFUND_PS[o.pay_status] || REFUND_PS[o.refund_status]) {
    if (o.pay_status === 'refunding' || o.refund_status === 'refunding') {
      return ['退款处理中', 'wait', '退款处理中，请留意到账通知'];
    }
    if (
      o.pay_status === 'refund_failed' ||
      o.pay_status === 'manual_review' ||
      o.refund_status === 'refund_failed' ||
      o.refund_status === 'manual_review'
    ) {
      return ['退款异常', 'wait', '请联系客服处理'];
    }
    return ['已退款', 'done', '退款已完成'];
  }

  if (o.status === 'pending') {
    if (o.pay_status === 'unpaid') return ['待支付', 'wait', '请尽快完成支付，超时将自动取消并释放房态'];
    if (UNPAID_PS[o.pay_status]) return ['支付确认中', 'wait', '正在确认支付结果，请稍候'];
    if (o.pay_status === 'paid') return ['已支付 · 待商家确认', 'stay', '支付成功，等待商家确认'];
    if (o.pay_status === 'coupon_funded') return ['已用券 · 待商家确认', 'stay', '卡券已抵扣，等待商家确认'];
    return ['待商家确认', 'wait', '退改口径见下方提示'];
  }

  if (o.status === 'confirmed') return ['已确认 · 待入住', 'stay', '商家已确认，按入住日期到店'];

  // 已结单：分账成功回调置位（booking.cjs 分账回调），终态，不再「待入住」
  if (o.status === 'finished') return ['已结单', 'done', '订单已结单'];

  return [o.status || '—', 'stay', ''];
}

/** 按取消接口回包合并本地行，避免仍显示「待商家确认」 */
export function applyCancelResult(row, res) {
  if (!row) return row;
  const next = { ...row, can_cancel: false };
  if (res && res.status) next.status = res.status;
  else next.status = 'cancelled';
  if (res && Object.prototype.hasOwnProperty.call(res, 'pay_status')) {
    next.pay_status = res.pay_status;
  }
  if (res && res.pay_status === 'refunding') next.refund_status = 'refunding';
  return next;
}
