(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = { createCashier: factory };
  else root.BZF_CASHIER = factory(root);
}(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  var memoryKeys = Object.create(null);
  var callbackSequence = 0;
  var bridgeLoading;

  function normalize(payment) {
    var source = payment && typeof payment === 'object' ? payment : {};
    // The older query endpoint wraps its raw gateway response in result. Do
    // not promote gateway orderStatus into a business payment decision.
    if (source.result && !source.pay_status && !source.payStatus && !source.order_pay_status
      && !source.cashier_url && !source.cashierUrl) source = source.result;
    var result = Object.assign({}, source);
    var aliases = { payStatus: 'pay_status', cashierUrl: 'cashier_url', cashierType: 'cashier_type',
      appOrderId: 'app_order_id', orderPayStatus: 'order_pay_status', nextAction: 'next_action' };
    Object.keys(aliases).forEach(function (key) {
      if (result[aliases[key]] == null && result[key] != null) result[aliases[key]] = result[key];
    });
    return result;
  }

  function orderStatus(payment, order) {
    var p = normalize(payment), o = order || {}, overall = p.order_pay_status;
    if (['closed', 'closing', 'expired', 'refunded', 'partially_refunded'].indexOf(overall) >= 0) return overall;
    // A cancellation/refund projection may already have advanced after the
    // payment query. Never turn a cancelled reservation into a success screen.
    if (['refunding', 'refunded', 'partially_refunded'].indexOf(o.refund_status) >= 0) return o.refund_status;
    if (['refunding', 'refunded', 'partially_refunded'].indexOf(o.pay_status) >= 0) return o.pay_status;
    if (o.status === 'cancelled') return o.pay_status === 'expired' ? 'expired' : 'closed';
    if (overall === 'paid') return 'paid';
    if (overall) return p.pay_status && p.pay_status !== 'paid' ? p.pay_status : overall;
    return o.pay_status || p.pay_status || 'unpaid';
  }

  function requestKey(scope, renew) {
    var name = 'bzf.cashier.request.' + String(scope);
    var key = memoryKeys[name];
    try { key = root.sessionStorage.getItem(name) || key; } catch (_) {}
    if (!key || renew) {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') key = root.crypto.randomUUID();
      else if (root.crypto && typeof root.crypto.getRandomValues === 'function') {
        var values = new Uint8Array(16);
        root.crypto.getRandomValues(values);
        key = Array.from(values, function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
      } else key = 'pay-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      memoryKeys[name] = key;
      try { root.sessionStorage.setItem(name, key); } catch (_) {}
    }
    return key;
  }

  function cashierType() {
    // Loading jsbridgesdk.js alone also creates JsBridgeV3 in ordinary browsers.
    var nativeBridge = root.LJBridge || root.HybridBridgeLJ || root.BeiKeSdk || root.__beikeSdk;
    var ua = root.navigator && root.navigator.userAgent || '';
    return root.__BZF_IS_BEIKE_APP || nativeBridge || /beike|lianjia/i.test(ua) ? '1' : '2';
  }

  function ensureAppBridge() {
    function ready() { return root.JsBridgeV3 && typeof root.JsBridgeV3.getSchemeLink === 'function' && typeof root.JsBridgeV3.callAndBack === 'function'; }
    if (cashierType() !== '1' || ready()) return Promise.resolve();
    if (bridgeLoading) return bridgeLoading;
    bridgeLoading = new Promise(function (resolve, reject) {
      if (!root.document) return reject(new Error('当前环境无法加载 App 收银台'));
      var script = root.document.createElement('script');
      var timer = root.setTimeout(function () { done(new Error('App 收银台组件加载超时，请重试')); }, 8000);
      function done(error) {
        root.clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) { script.remove(); bridgeLoading = null; reject(error); }
        else resolve();
      }
      script.src = '/jsbridgesdk.js?v=1';
      script.onload = function () { done(ready() ? null : new Error('App 收银台组件未就绪，请重试')); };
      script.onerror = function () { done(new Error('App 收银台组件加载失败，请重试')); };
      root.document.head.appendChild(script);
    });
    return bridgeLoading;
  }

  function open(payment, options) {
    options = options || {};
    payment = normalize(payment);
    var state = payment.pay_status;
    var orderState = payment.order_pay_status;
    if (['closed', 'closing', 'refunded'].indexOf(orderState) >= 0) return false;
    if (orderState === 'paid' || orderState === 'partially_refunded' || (!orderState && state === 'paid')) {
      if (typeof options.onResult === 'function') options.onResult(payment);
      return true;
    }
    var url = payment.cashier_url || payment.cashierUrl;
    if (!url || ['closing', 'close_unknown', 'closed', 'expired', 'refunding', 'refunded'].indexOf(state) >= 0
      || ['poll', 'closed', 'none'].indexOf(payment.next_action) >= 0) return false;
    var type = String(payment.cashier_type || cashierType());
    if (type === '1') {
      if (!/^(https?:|walletsdk:)/i.test(url)) throw new Error('收银台地址无效');
      var bridge = root.JsBridgeV3;
      if (!bridge || typeof bridge.getSchemeLink !== 'function' || typeof bridge.callAndBack !== 'function') {
        throw new Error('当前环境无法打开 App 收银台，请回到原支付终端');
      }
      var prefix = bridge.getSchemeLink('bkjfwallet?url=');
      if (!prefix) throw new Error('未获取到 App 收银台入口');
      var callback = '__bzfCashierBack_' + Date.now() + '_' + (++callbackSequence);
      root[callback] = function (raw) {
        delete root[callback];
        var result = raw;
        try { if (typeof raw === 'string') result = JSON.parse(raw); } catch (_) { result = {}; }
        if (result && String(result.code) === '-1') {
          if (typeof options.onCancel === 'function') options.onCancel(result);
        } else if (typeof options.onResult === 'function') options.onResult(result || {});
      };
      try { bridge.callAndBack({ actionUrl: prefix + encodeURIComponent(url), functionName: callback }); }
      catch (error) { delete root[callback]; throw error; }
      return true;
    }
    if (!/^https?:\/\//i.test(url)) throw new Error('H5 收银台地址无效');
    if (typeof options.onResult === 'function' && typeof root.addEventListener === 'function') {
      // H5 cashiers may return with browser Back, restoring this document from
      // BFCache instead of mounting it again. The caller still queries the
      // server; a navigation return itself is never proof of payment.
      var leftPage = false;
      var leave = function () { leftPage = true; };
      var back = function () {
        if (!leftPage) return;
        root.removeEventListener('pagehide', leave);
        root.removeEventListener('pageshow', back);
        options.onResult(payment);
      };
      root.addEventListener('pagehide', leave, { once: true });
      root.addEventListener('pageshow', back);
    }
    root.location.href = url;
    return true;
  }

  async function waitForCashier(load, options) {
    options = options || {};
    var attempts = Math.max(1, Math.min(Number(options.attempts) || 8, 20));
    var delay = Math.max(0, Number(options.intervalMs) >= 0 ? Number(options.intervalMs) : 750);
    var payment;
    for (var index = 0; index < attempts; index++) {
      if (options.signal && options.signal.aborted) throw new Error('支付查询已取消');
      payment = normalize(await load());
      if (typeof options.onStatus === 'function') options.onStatus(payment);
      var state = payment && (payment.pay_status || payment.payStatus);
      if (payment && (payment.next_action === 'new_attempt' || payment.next_action === 'closed'
        || (payment.cashier_url && payment.next_action !== 'poll' && ['closing', 'close_unknown'].indexOf(state) < 0)
        || ['paid', 'partially_refunded', 'refunded', 'closed'].indexOf(payment.order_pay_status) >= 0
        || ['paid', 'closed', 'expired', 'pay_failed', 'refunding', 'refunded'].indexOf(state) >= 0)) return payment;
      if (index + 1 < attempts) await new Promise(function (resolve) { root.setTimeout(resolve, delay); });
    }
    return payment;
  }

  return { requestKey: requestKey, cashierType: cashierType, ensureAppBridge: ensureAppBridge,
    normalize: normalize, orderStatus: orderStatus, open: open, waitForCashier: waitForCashier };
}));
