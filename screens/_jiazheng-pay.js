(function () {
  'use strict';
  var JZ = window.BZF_JZ, cashier = window.BZF_CASHIER;
  var query = new URLSearchParams(location.search);
  var id = query.get('order') || query.get('oid'), busy = false, order = null;
  var button = document.getElementById('payBtn'), hint = document.getElementById('paySub');
  var resultUrl = 'lvju-app-paid.html?channel=jiazheng&order=' + encodeURIComponent(id || '');
  function result() { location.href = resultUrl; }
  function statusText(state) {
    return ({ creating: '正在准备收银台…', paying: '请在收银台完成付款，返回本页后确认结果', create_unknown: '支付结果确认中，请勿重复下单',
      closing: '订单关闭处理中', close_unknown: '订单关闭结果确认中', closed: '订单已关闭', refunded: '已退款', partially_refunded: '部分退款已完成', refunding: '退款处理中' })[state] || '确认金额后继续付款';
  }
  function stateOf(payment) { return cashier.orderStatus ? cashier.orderStatus(payment, order) : payment.order_pay_status || payment.pay_status; }
  function paint(payment) {
    if (cashier.normalize) payment = cashier.normalize(payment);
    var state = stateOf(payment);
    if (state === 'paid' || state === 'coupon_funded') { result(); return payment; }
    if (payment.next_action === 'new_attempt') { button.hidden = false; hint.textContent = '上次收银台已关闭，可重新付款'; return payment; }
    hint.textContent = statusText(state);
    button.hidden = ['closed', 'refunding', 'refunded', 'partially_refunded', 'closing', 'close_unknown'].includes(state);
    return payment;
  }
  function refresh() { if (id) return JZ.paymentStatus(id).then(paint).catch(function (error) { hint.textContent = error.message; }); }
  if (!id) { hint.textContent = '缺少订单，请从生活服务订单页进入'; button.hidden = true; return; }
  document.getElementById('myOrder').href = 'juzhu-jiazheng-order-detail.html?order_ref=' + encodeURIComponent(id);
  JZ.get(id).then(function (value) {
    order = value;
    var amount = order.amount_minor != null ? Number(order.amount_minor) / 100 : Number(order.fee) / (order.payment_mode === 'pay_center' ? 100 : 1);
    document.getElementById('payAmt').textContent = '¥' + amount.toFixed(2);
    document.getElementById('serviceName').textContent = order.product_name || order.category;
    document.getElementById('payCd').textContent = order.expires_at ? '付款截止：' + String(order.expires_at).replace('T', ' ').slice(0, 19) + ' UTC' : '';
    refresh();
  }).catch(function (error) { hint.textContent = error.message; button.hidden = true; });
  button.addEventListener('click', function (event) {
    event.preventDefault(); if (busy) return;
    busy = true; button.textContent = '正在准备收银台…';
    JZ.payIntent(id).then(function (payment) {
      if (payment.cashier_url || payment.order_pay_status === 'paid') return payment;
      return cashier.waitForCashier(function () { return JZ.paymentStatus(id); }, { onStatus: paint });
    }).then(async function (payment) {
      paint(payment);
      if (stateOf(payment) === 'paid') return;
      if (String(payment.cashier_type || cashier.cashierType()) === '1' && cashier.ensureAppBridge) await cashier.ensureAppBridge();
      if (!cashier.open(payment, { onResult: function () { JZ.paymentStatus(id).then(paint).catch(function (error) { hint.textContent = error.message; }); }, onCancel: refresh })) {
        hint.textContent = statusText(stateOf(payment)) + '，可稍后返回订单查看';
      }
    }).catch(function (error) { hint.textContent = error.message; }).finally(function () { busy = false; button.textContent = '前往收银台'; });
  });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') refresh(); });
  window.addEventListener('pageshow', function (event) { if (event.persisted) refresh(); });
}());
