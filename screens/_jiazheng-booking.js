(function () {
  'use strict';
  var JZ = window.BZF_JZ, query = new URLSearchParams(location.search), slug = query.get('sku');
  var product, busy = false, chosenTime = query.get('time') || '', request = null;
  var button = document.getElementById('submitBtn');
  function money(value) { return '¥' + Number(value).toFixed(2); }
  function requestSignature(payload) {
    if (!window.crypto || !crypto.subtle || typeof TextEncoder === 'undefined') return Promise.resolve(JSON.stringify(payload));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(payload))).then(function (bytes) {
      return Array.from(new Uint8Array(bytes)).map(function (value) { return value.toString(16).padStart(2, '0'); }).join('');
    });
  }
  function summaryError(message) {
    document.getElementById('productSummary').textContent = message;
    button.setAttribute('aria-disabled', 'true'); button.textContent = '请返回商品页';
  }
  document.getElementById('houseInput').value = '';
  document.getElementById('phoneInput').value = '';
  document.getElementById('timeVal').textContent = chosenTime || '请选择服务时间';
  document.getElementById('timeMode').style.display = 'block';
  document.getElementById('timeMode').textContent = '提交后保留 15 分钟付款时间；派单前取消全额退款，派单后请联系售后。';
  if (window.JZ_DATEPICK) JZ_DATEPICK.mount(document.getElementById('timeSlots'), { value: chosenTime, onChange: function (value) {
    chosenTime = value; document.getElementById('timeVal').textContent = value;
  } });
  if (!slug) { summaryError('下单入口已升级，请返回生活服务详情重新选择商品。'); return; }
  JZ.sku(slug, query.get('vendor')).then(function (data) {
    var products = data.products || (data.product ? [data.product] : []);
    var productId = query.get('product'), vendorId = query.get('vendor');
    var candidates = products.filter(function (entry) { return (!productId || String(entry.id) === productId)
      && (!vendorId || String(entry.vendor_id) === vendorId); });
    if (candidates.length !== 1) throw new Error(candidates.length ? '此服务有多个可选商品，请返回详情页选择商家与商品' : '未找到所选商品，请返回详情页重新选择');
    product = candidates[0];
    if (!product || product.payment_mode !== 'pay_center') throw new Error('该商品不支持本站付款，请返回详情页');
    if (!(Number(product.price) > 0)) throw new Error('此项为咨询或估价服务，无需付款');
    document.getElementById('productSummary').innerHTML = '<b>' + JZ.esc(product.title) + '</b><p>' + JZ.esc(product.vendor_name) + '</p>';
    document.getElementById('priceBox').innerHTML = '<div class="row total"><span>应付金额</span><b>' + money(product.price) + '</b></div>';
    document.getElementById('backBtn').href = JZ.chainCity('juzhu-jiazheng-detail.html?sku=' + encodeURIComponent(slug));
    button.addEventListener('click', function (event) {
      event.preventDefault();
      if (busy) return;
      if (!document.getElementById('agree').checked) return alert('请先同意服务协议与取消规则');
      var payload = { product_id: product.id, house: document.getElementById('houseInput').value.trim(),
        phone: document.getElementById('phoneInput').value.trim(), expectTime: chosenTime,
        desc: document.getElementById('descInput').value.trim(), slot_id: query.get('slot') || null,
        price_minor: Math.round(Number(product.price) * 100) };
      if (!payload.house || !/^1\d{10}$/.test(payload.phone) || !payload.expectTime) return alert('请填写地址、手机号并选择时间');
      busy = true; button.textContent = '提交中…';
      requestSignature(payload).then(function (signature) {
        if (!request || request.signature !== signature) request = { signature: signature, key: JZ.requestKey('checkout:' + product.id + ':' + signature) };
        payload.idempotency_key = request.key;
        return JZ.create(payload);
      }).then(function (order) {
        if (['cancelled', 'done', 'rated'].indexOf(order.status) >= 0
          || ['closed', 'expired', 'refunded'].indexOf(order.pay_status) >= 0) {
          request.key = JZ.requestKey('checkout:' + product.id + ':' + request.signature, true);
          payload.idempotency_key = request.key;
          return JZ.create(payload);
        }
        return order;
      }).then(function (order) {
        location.href = 'lvju-app-pay.html?channel=jiazheng&order=' + encodeURIComponent(order.id);
      }).catch(function (error) { busy = false; button.textContent = '确认下单'; alert(error.message || '提交失败，请重试'); });
    });
  }).catch(function (error) { summaryError(error.message); });
}());
