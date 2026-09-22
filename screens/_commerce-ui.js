(function () {
  'use strict';
  var api = window.COMMERCE, state, tab = 'shop', productId = new URLSearchParams(location.search).get('product'), quote, pendingOrder;
  var view = document.body.dataset.commerceView || 'consumer', previewResult, shareResult, tokenResult, selectedCoupon, meta;
  var status = document.getElementById('commerce-status'), content = document.getElementById('commerce-content');
  var query = new URLSearchParams(location.search), ref = query.get('ref') || '';
  var busy = false, tokenTimer;
  var labels = { UNPAID: '待测试支付', PAID: '测试支付已确认', PENDING: '待发放', RETRY_PENDING: '发放待重试', COMPLETED: '发放完成', ISSUED: '待使用', REDEEMED: '已核销', FROZEN: '售后冻结', REFUNDED: '已退回 / 售后完成', REQUESTED: '待复核', SUCCEEDED: '处理完成（测试）', CONFIRMED: '已确认 · 待账期', AVAILABLE_TEST: '已到测试账期', PROCESSING: '处理中', UNKNOWN: '查询中 · 结果未知', RESERVED: '已预约', FULFILLED: '已履约', CANCELLED: '已取消', RESCHEDULED: '已改期', PAID_TEST: '赔付完成（测试）', UNRECOVERED: '待追偿', RECOVERED_TEST: '已追回（测试）', ACTIVE: '有效', EXPIRED: '已到期' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function money(n) { return '¥' + ((n || 0) / 100).toFixed(2); }
  function date(n) { return new Date(n).toLocaleDateString('zh-CN'); }
  function badge(s) { return '<span class="commerce-badge">' + esc(labels[s] || s) + '</span>'; }
  function btn(action, title, id, primary, disabled) { return '<button class="btn' + (primary ? ' pri' : '') + '" data-action="' + action + '" data-id="' + esc(id || '') + '"' + (disabled ? ' disabled' : '') + '>' + title + '</button>'; }
  function card(title, html, extra) { return '<section class="commerce-card ' + (extra || '') + '">' + (title ? '<h3>' + title + '</h3>' : '') + html + '</section>'; }
  function empty(title, message) { return card(title, '<p>' + message + '</p>', 'commerce-empty wide'); }
  function row(k, v) { return '<div class="detail-row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; }
  function actions(html) { return '<div class="commerce-actions">' + html + '</div>'; }
  function kpis(items) { return '<div class="commerce-grid">' + items.map(function (v) { return '<div class="commerce-kpi"><span>' + v[0] + '</span><b>' + money(v[1]) + '</b></div>'; }).join('') + '</div>'; }
  function notify(message, error) { status.textContent = message; status.className = error ? 'error' : ''; }
  function tabs() {
    var nav = document.getElementById('commerce-tabs');
    if (view !== 'consumer') { nav.innerHTML = '<a href="/juzhu-commerce.html">用户端</a><a href="/juzhu-promoter.html">推广端</a><a href="/screens/commerce-merchant.html">商户端</a><a href="/screens/commerce-admin.html">管理端</a>'; return; }
    nav.innerHTML = [['shop', '权益专区'], ['coupons', '我的卡券'], ['member', '会员'], ['orders', '订单 / 售后']].map(function (x) { return '<button data-tab="' + x[0] + '" class="' + (tab === x[0] ? 'on' : '') + '">' + x[1] + '</button>'; }).join('');
  }
  function productCard(p) {
    return card('', badge(p.type === 'membership' ? '年度会员 · 赠券包' : '跨商户券包 · 可直接购买') + '<h2>' + esc(p.name) + '</h2><p>' + esc(p.tagline) + '</p><div class="money">' + money(p.price) + '</div><p>五家测试供应商 · 沈阳适用 · 权益有效期30天</p>' + actions(btn('product', '查看权益与规则', p.id, true)));
  }
  function shop() {
    if (productId) return detail();
    return '<section class="commerce-card commerce-hero"><div class="eyebrow">新居住 · 生活权益</div><h2>好生活，从安心居住开始</h2><p>保洁、维修、搬家、旅居与城市漫游<br>一份券包，照顾新生活的不同需要</p></section>' +
      '<label class="field">适用城市<select id="city"><option>沈阳</option><option' + (query.get('city') === '其他城市' ? ' selected' : '') + '>其他城市</option></select></label>' +
      (state.products.length ? state.products.map(productCard).join('') : empty('当前城市暂无可售权益', '你已经购买的权益仍可在「我的卡券」查看及申请售后。'));
  }
  function detail() {
    var p = state.products.find(function (p) { return p.id === productId; });
    if (!p) return empty('商品暂不可售', '请返回权益专区选择商品；已购权益不受停售影响。') + actions(btn('back-shop', '返回权益专区'));
    return card('', badge(p.type === 'membership' ? '年度会员方案' : '独立券包') + '<h2>' + esc(p.name) + '</h2><p>' + esc(p.tagline) + '</p><div class="money">' + money(p.price) + '</div>' + row('适用城市', '沈阳') + row('会员期限', p.type === 'membership' ? '365天；续费顺延，不自动扣费' : '无需会员，可直接购买') + row('券有效期', '测试支付发券后30天')) +
      card('五重生活权益', '<ul class="commerce-list">' + p.items.map(function (i) { return '<li><b>' + esc(i.name) + '</b><small>' + esc(i.spec) + ' · 测试供应商 ' + i.merchant + ' · 测试门店 ' + i.merchant + '</small><small>可预约：' + esc((i.availability || []).filter(function(a){return a.usable && a.remaining > 0;}).map(function(a){return a.date + '余' + a.remaining;}).slice(0,3).join(' / ') || '近期已满，请联系客服') + '</small><small>指定标准服务，每张使用一次；额外服务另行确认，不自动抵扣尾款。</small></li>'; }).join('') + '</ul>') +
      card('预约与购买须知', '<p>请至少提前一天预约，核销前需有有效预约。测试门店默认日产能10，实际余量在卡券详情选择日期时查询；满额可改期。赠券期限与会员期限独立。</p><p>销售/组织主体：新居住权益测试平台；实际履约方：包内逐券测试供应商。收款与清分由隔离测试机构模拟。平台角色按自有频道居间服务口径展示。</p><p>未使用券到期自动原路退回对应分摊金额。退款到账时限及手续费为待审批项，本联调仅展示无扣费测试结果。订单可发起售后或开票受理。</p>' + actions(btn('checkout', '确认权益并下单', p.id, true) + btn('back-shop', '返回')));
  }
  function checkoutView() {
    return card('确认订单', '<h2>' + esc(quote.name) + '</h2>' + row('测试实付', money(quote.total)) + row('商品版本', 'v' + quote.version) + row('规则版本', quote.rule_version) + '<p>五家测试供应商分别履约。未核销到期按原分摊原路退回，会员与赠券有效期分别管理。</p><p>' + (ref ? '推广线索将在服务端校验后随订单锁定。' : '本单无推广来源，不产生个人推广佣金。') + '</p><label class="field"><span><input type="checkbox" id="terms"> 我已阅读权益、预约、到期退回和售后说明</span></label>' + actions(btn('place-order', '创建测试订单', '', true) + btn('back-shop', '返回')));
  }
  function payView() {
    var o = state.orders.find(function (o) { return o.id === pendingOrder; });
    if (!o) return empty('订单未找到', '请使用下单时的用户身份。');
    return card('测试收银台', badge(o.status) + '<h2>' + esc(o.name) + '</h2><div class="money">' + money(o.total) + '</div><p>这里不会发起真实支付。下方操作向隔离测试机构提交测试成功事件，结果由服务端查单展示。</p>' + row('发放状态', labels[o.grant_status]) + (o.status === 'UNPAID' ? '<label class="field"><span><input id="fail-grant" type="checkbox"> 测试发券失败后的补发流程</span></label>' + actions(btn('test-pay', '确认测试支付（无资金）', o.id, true)) : actions(btn('go-coupons', '查看我的卡券', '', true) + btn('go-orders', '查看订单进度'))));
  }
  function coupons() {
    if (selectedCoupon) return couponDetail();
    var f = query.get('filter') || 'all', list = state.coupons.filter(function (c) { return f === 'all' || c.status === f; });
    return '<h2>我的卡券</h2><label class="field">权益状态<select id="coupon-filter">' + [['all','全部'],['ISSUED','待使用'],['REDEEMED','已核销'],['FROZEN','退款中'],['REFUNDED','售后完成']].map(function(x){return '<option value="'+x[0]+'"'+(f===x[0]?' selected':'')+'>'+x[1]+'</option>';}).join('') + '</select></label>' + (list.length ? list.map(function (c) { return card('', badge(c.status) + '<h3>' + esc(c.name) + '</h3><p>测试供应商 ' + c.merchant + ' · 门店 ' + c.merchant + '<br>有效期至 ' + date(c.valid_to) + '</p>' + actions(btn('coupon', '查看 / 预约 / 使用', c.id, true))); }).join('') : empty('暂无该状态的卡券', '购买券包或开通会员后，权益会出现在这里。发放中订单可在订单页查询。'));
  }
  function couponDetail() {
    var c = state.coupons.find(function (c) { return c.id === selectedCoupon; });
    if (!c) return empty('无法访问该卡券', '请切换回拥有该券的用户身份。');
    var ap = state.appointments.find(function (a) { return a.coupon === c.id && a.status === 'RESERVED'; });
    var usable = c.status === 'ISSUED' && c.valid_to > state.now;
    var html = card('', badge(c.status) + '<h2>' + esc(c.name) + '</h2><p>' + esc(c.spec) + '</p>' + row('服务供应商 / 门店', '测试供应商 ' + c.merchant + ' / 门店 ' + c.merchant) + row('有效期至', date(c.valid_to)) + row('原单分摊 / 未用可退', money(c.basis)) + '<p>限指定门店和标准服务使用一次；预约及实际履约不等于核销。额外服务不在本券范围内。</p>');
    if (usable) html += card(ap ? '我的预约 · 可改期' : '选择服务日期', (ap ? row('已预约', ap.date) : '<p>提前预约，避免到店等待。未预约不占门店产能。</p>') + '<label class="field">服务日期<select id="appointment-date">' + c.availability.map(function (a) { return '<option value="' + a.date + '"' + (!a.usable || !a.remaining ? ' disabled' : '') + '>' + a.date + ' · 余 ' + a.remaining + ' / ' + a.total + '</option>'; }).join('') + '</select></label>' + actions(btn('book', ap ? '确认改期' : '确认预约', c.id, true) + (ap ? btn('cancel-appointment', '取消预约', ap.id) + btn('token', '展示动态核销口令', c.id) : '')) + (tokenResult && tokenResult.coupon === c.id ? '<div class="receipt"><p>测试核销口令 · <span id="token-countdown"></span><br>请由对应门店工作人员预览后确认核销；不要将口令公开分享。</p><div class="commerce-code" id="redemption-code">' + esc(tokenResult.token) + '</div></div>' : ''));
    html += card('售后与帮助', '<p>未使用可提交退款受理；已核销服务失败可申请复核和先行赔付。到期退回由任务自动处理，无需申请。</p>' + (['ISSUED','REDEEMED'].includes(c.status) ? '<label class="field">申请原因<textarea id="refund-reason" rows="2" placeholder="请描述需要帮助的问题"></textarea></label>' + actions(btn('refund', '提交售后申请', c.id)) : '<p>请在订单 / 售后中查看处理进度。</p>') + actions(btn('go-coupons', '返回卡券列表')));
    return html;
  }
  function member() {
    return '<h2>我的会员</h2>' + (state.memberships.length ? state.memberships.map(function (m) { return card('新居住年度会员', badge(m.status) + row('开始日期', date(m.start)) + row('到期日期', date(m.end)) + '<p>赠券发放及券有效期请查看我的卡券。会员到期不影响尚有效的赠券。</p>'); }).join('') : empty('尚未开通会员', '也可以先购买独立券包，按需体验生活权益。')) + actions(btn('product', state.memberships.length ? '查看续费方案' : '查看会员方案', 'member-999', true));
  }
  function orders() {
    return '<h2>订单与售后</h2>' + (state.orders.length ? state.orders.slice().reverse().map(function (o) { return card(esc(o.name), badge(o.status) + badge(o.grant_status) + row('金额', money(o.total)) + '<p>订单 ' + esc(o.id) + '</p>' + actions(o.status === 'UNPAID' ? btn('pay-order', '前往测试收银台', o.id, true) : btn('go-coupons', '查看逐券权益', '', true)) + '<p>发票受理：选择下方工单类型提交，客服处理进度可在本页查询。</p>' + '<label class="field">帮助类型<select id="help-kind-' + o.id + '"><option value="INVOICE">开票受理</option><option value="HELP">订单咨询</option></select></label>' + actions(btn('help', '提交受理工单', o.id))); }).join('') : empty('还没有权益订单', '去权益专区选一份适合自己的生活权益。')) +
      card('售后申请', state.refunds.length ? state.refunds.map(function (f) { return '<div class="receipt">' + badge(f.status) + '<b>' + money(f.amount) + '</b><p>' + esc(f.reason) + '</p><small>受理号 ' + esc(f.id) + '</small></div>'; }).join('') : '<p>暂无申请。可从卡券详情提交售后。</p>') +
      card('开票 / 帮助工单', (state.help || []).length ? state.help.map(function (h) { return '<div class="receipt">' + badge(h.status) + '<b>' + (h.kind === 'INVOICE' ? '开票受理' : '订单咨询') + '</b><p>受理号 ' + esc(h.id) + '</p><p>' + esc(h.reply || '待客服处理；联调时限为1个工作日响应') + '</p></div>'; }).join('') : '<p>暂无工单。</p>');
  }
  function payoutCards() {
    return card('机构可用金额 · 测试镜像', '<div class="money">' + money(state.provider_available) + '</div><p>来源：隔离测试机构 · 更新 ' + new Date(state.provider_updated_at).toLocaleTimeString('zh-CN') + '<br>已确认不等于可提现。账期释放后可发起测试指令，不扣真实资金。</p>' + '<label class="field">申请金额（元）<input id="withdraw-amount" inputmode="decimal" placeholder="如 19.98"></label>' + actions(btn('withdraw', view === 'merchant' ? '申请测试结算' : '申请测试提现', '', true, !state.provider_available))) +
      card('付款指令记录', state.payouts.length ? state.payouts.map(function (p) { return '<div class="receipt">' + badge(p.status === 'PAID' ? '已支付（测试）' : p.status) + '<b>' + money(p.amount) + '</b><p>请求 ' + esc(p.provider_request) + '</p>' + (p.status === 'UNKNOWN' ? '<p>正在查询原机构请求，切勿重复提交。</p>' : '') + '</div>'; }).join('') : '<p>暂无申请记录。</p>');
  }
  function promoter() {
    var confirmed = state.commissions.reduce(function (s, c) { return s + c.amount; }, 0);
    return card('推广工作台', '<h2>把好生活分享给邻里</h2><p>测试推广资格：已审核。仅单层直接推荐，实际核销后确认佣金。下单未核销时尚未赚取佣金。</p>' + kpis([['已确认累计', confirmed], ['机构可用', state.provider_available]]), 'commerce-hero-placeholder') +
      card('选择推广商品', '<label class="field">商品<select id="share-product">' + state.products.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</select></label>' + actions(btn('share', '生成专属推广链接', '', true, !state.products.length)) + (shareResult ? '<div class="receipt"><p>专属链接已生成，有效期7天；登录后归属仍由服务端校验。</p><a id="share-link" class="commerce-code" href="' + esc(shareResult.href) + '">打开商品分享页</a><label class="field">可复制链接<input readonly id="share-url" value="' + esc(location.origin + shareResult.href) + '"></label>' + actions(btn('copy-share', '复制链接')) + '</div>' : '')) +
      card('佣金明细', state.commissions.length ? state.commissions.map(function (c) { return '<div class="receipt">' + badge(c.status) + '<b>' + money(c.amount) + '</b><p>来源核销 ' + esc(c.id) + '</p></div>'; }).join('') : '<p>暂无已确认佣金。朋友购买后，需实际核销权益才确认。</p>') + payoutCards() +
      card('推广订单', state.orders.length ? state.orders.map(function (o) { return '<div class="receipt"><b>' + esc(o.name) + '</b><p>' + esc(o.id) + '</p>' + badge(o.status) + badge(o.grant_status) + '</div>'; }).join('') : '<p>暂无归属订单。</p>');
  }
  function merchant() {
    return card('核销工作台', '<h2>' + esc(state.actor.name) + '</h2><p>仅限测试门店 ' + esc(state.actor.merchant) + '。扫码能力未接入，使用动态口令安全替代；预览不会核销。</p><label class="field">用户动态核销口令<input id="redeem-token" autocomplete="off" placeholder="粘贴用户卡券详情中的口令" value="' + esc(previewResult ? previewResult.token : '') + '"></label>' + actions(btn('preview', '预览权益', '', true)) + (previewResult ? '<div class="receipt"><h3>' + esc(previewResult.name) + '</h3>' + row('服务日期', previewResult.appointment_date) + row('本商户应结', money(previewResult.supplier_payable)) + '<p>' + esc(previewResult.expected_payment) + '</p><label class="field"><span><input type="checkbox" id="service-confirmed"> 确认测试服务已履约并记录凭证</span></label>' + actions(btn('redeem', '确认核销', '', true)) + '</div>' : '')) +
      card('门店预约', state.appointments.length ? state.appointments.map(function (a) { return '<div class="receipt">' + badge(a.status) + '<b>' + a.date + '</b><p>预约 ' + esc(a.id) + '</p></div>'; }).join('') : '<p>尚无预约。</p>') +
      card('核销与应结记录', state.redemptions.length ? state.redemptions.map(function (r) { return '<div class="receipt">' + badge(r.status) + '<b>' + money(r.supplier_payable) + '</b><p>核销 ' + esc(r.id) + '</p></div>'; }).join('') : '<p>尚无核销；可先用用户端完成购买、预约并获取口令。</p>') + payoutCards();
  }
  function admin() {
    var s = state.summary;
    return card('权益运营与资金镜像', '<h2>订单、履约与售后，一处跟进</h2><p>沈阳 · 隔离测试环境。下方金额为业务记录及测试机构镜像，不是生产资金余额。</p>' + kpis([['测试收款累计', s.paid], ['未核销负债', s.unredeemed], ['商户应结', s.supplier], ['渠道佣金', s.channel], ['平台净留', s.retained], ['未用退回', s.refunded], ['先行赔付', s.compensation], ['已追回', s.recovery]]) + actions(btn('release', '模拟机构账期到达', '', true) + btn('expiry-job', '扫描到期自动退回') + btn('sales', state.sales_enabled ? '暂停新增销售' : '恢复测试销售')), 'wide') +
      card('订单与发券监控', state.orders.length ? state.orders.slice().reverse().map(function (o) { return '<div class="receipt"><b>' + esc(o.name) + ' · ' + money(o.total) + '</b><p>' + esc(o.id) + '</p>' + badge(o.status) + badge(o.grant_status) + actions(btn('retry', '重试原批次发券', o.id, false, o.status !== 'PAID')) + '</div>'; }).join('') : '<p>暂无订单。先在用户端创建测试订单。</p>') +
      card('售后复核', state.refunds.length ? state.refunds.map(function (f) { return '<div class="receipt">' + badge(f.status) + badge(f.type === 'SERVICE_FAILURE' ? '已核销履约失败 · 先行赔付' : '未核销退回') + '<b>' + money(f.amount) + '</b><p>' + esc(f.reason) + '</p>' + actions(btn('approve-refund', '复核并提交测试机构', f.id, true, f.status !== 'REQUESTED')) + '</div>'; }).join('') : '<p>暂无申请。申请人与复核人分离。</p>') +
      card('付款 / 代发指令', state.payouts.length ? state.payouts.map(function (p) { return '<div class="receipt">' + badge(p.status === 'PAID' ? '已支付（测试）' : p.status) + '<b>' + money(p.amount) + '</b><p>' + esc(p.who) + ' · ' + esc(p.provider_request) + '</p>' + actions(btn('payout-unknown', '模拟超时', p.id, false, p.status !== 'PROCESSING') + btn('payout-query', '查询原机构请求', p.id, true, p.status !== 'UNKNOWN') + btn('payout-paid', '模拟确认到账', p.id, false, p.status !== 'PROCESSING')) + '</div>'; }).join('') : '<p>暂无指令。账期到达后由商户或推广员申请。</p>') +
      card('赔付与追偿', state.compensations.length ? state.compensations.map(function (c) { return '<div class="receipt">' + badge(c.recovery_status) + row('自有资金赔付', money(c.amount)) + row('应收商户代偿', '测试供应商 ' + c.recovery_merchant + ' · ' + money(c.recovery_amount - c.recovered)) + '<p>资金来源：独立测试赔付专户；未用退回不计入此项。</p>' + actions(btn('recover', '模拟追偿到账', c.id, true, c.recovery_status !== 'UNRECOVERED')) + '</div>'; }).join('') : '<p>暂无赔付，未核销退款不进入赔付科目。</p>') +
      card('测试券生命周期', state.coupons.length ? state.coupons.map(function (c) { return '<div class="receipt">' + badge(c.status) + '<b>' + esc(c.name) + '</b><p>用户 ' + esc(c.user) + ' · ' + esc(c.id) + '</p>' + actions(btn('expire', '推进到期并原路退回', c.id, false, c.status !== 'ISSUED')) + '</div>'; }).join('') : '<p>暂无券实例。</p>') +
      card('测试预约产能', '<p>仅控制隔离测试门店；不能把容量调到已预约数以下。</p><label class="field">门店<select id="capacity-store">' + ['A','B','C','D','E'].map(function (m) { return '<option>store-' + m + '</option>'; }).join('') + '</select></label><label class="field">日期<input id="capacity-date" type="date"></label><label class="field">总产能<input id="capacity-total" type="number" min="0" max="100" value="10"></label>' + actions(btn('capacity', '保存测试产能', '', true))) +
      card('会员期限测试', state.memberships.length ? state.memberships.map(function (m) { return '<div class="receipt"><p>' + esc(m.user) + ' · 到期 ' + date(m.end) + '</p>' + actions(btn('membership-expire', '模拟会员到期（不撤销券）', m.id)) + '</div>'; }).join('') : '<p>暂无会员。</p>') +
      card('开票与帮助受理', (state.help || []).length ? state.help.map(function (h) { return '<div class="receipt">' + badge(h.status) + '<p>' + esc(h.kind) + ' · ' + esc(h.id) + '</p>' + actions(btn('help-resolve', '登记已响应（测试）', h.id, false, h.status === 'RESOLVED')) + '</div>'; }).join('') : '<p>暂无受理工单。</p>') +
      card('审计与账务检查', row('平衡账事件', state.ledger.length + ' 组') + row('已记录操作', state.audit.length + ' 条（最近100条）') + '<ul class="commerce-list">' + state.audit.slice(-8).reverse().map(function (a) { return '<li>' + esc(a.actor) + '<small>' + esc(a.action) + '</small></li>'; }).join('') + '</ul>');
  }
  function render() {
    tabs();
    if (!state || state.actor.role !== view) { content.innerHTML = empty('当前身份无权访问此工作台', '请在顶部选择对应的隔离测试身份。服务端仍逐接口校验权限。'); return; }
    if (view === 'consumer') content.innerHTML = tab === 'checkout' ? checkoutView() : tab === 'pay' ? payView() : tab === 'coupons' ? coupons() : tab === 'member' ? member() : tab === 'orders' ? orders() : shop();
    else content.innerHTML = view === 'merchant' ? merchant() : view === 'promoter' ? promoter() : admin();
    clearInterval(tokenTimer);
    if (tokenResult && document.getElementById('token-countdown')) {
      var tick = function () {
        var remain = Math.max(0, Math.ceil((tokenResult.expires_at - Date.now()) / 1000));
        var el = document.getElementById('token-countdown'); if (el) el.textContent = remain ? remain + '秒后失效' : '已失效，请重新获取';
        if (!remain) { var code = document.getElementById('redemption-code'); if (code) code.textContent = '口令已失效'; clearInterval(tokenTimer); }
      }; tick(); tokenTimer = setInterval(tick, 1000);
    }
  }
  async function refresh() { state = await api.request('/state'); if (view === 'consumer' && query.get('city')) state.products = await api.request('/catalog?city=' + encodeURIComponent(query.get('city'))); render(); }
  function value(id) { var el = document.getElementById(id); return el ? el.value : ''; }
  async function act(action, target) {
    var result;
    if (action === 'product') { productId = target; tab = 'shop'; }
    else if (action === 'back-shop') { productId = null; tab = 'shop'; }
    else if (action === 'checkout') { quote = await api.request('/order-quotes', { product_id: target, version: state.products.find(function (p) { return p.id === target; }).version }); tab = 'checkout'; }
    else if (action === 'place-order') { if (!document.getElementById('terms').checked) throw new Error('请先阅读并勾选权益及售后说明'); result = await api.request('/orders', { product_id: quote.product_id, version: quote.version, promotion_token: ref || undefined }); pendingOrder = result.id; tab = 'pay'; }
    else if (action === 'pay-order') { pendingOrder = target; tab = 'pay'; }
    else if (action === 'test-pay') { await api.request('/orders/' + target + '/test-pay', { fail_grant: document.getElementById('fail-grant').checked }); notify('测试事件已提交；已从服务端读取支付及发放状态。'); }
    else if (action === 'go-coupons') { tab = 'coupons'; selectedCoupon = null; tokenResult = null; }
    else if (action === 'go-orders') tab = 'orders';
    else if (action === 'coupon') { tab = 'coupons'; selectedCoupon = target; tokenResult = null; }
    else if (action === 'book') { await api.request('/appointments', { coupon_id: target, date: value('appointment-date') }); tokenResult = null; notify('预约已更新。'); }
    else if (action === 'cancel-appointment') { await api.request('/appointments/' + target + '/cancel', {}); tokenResult = null; notify('预约已取消，产能已释放。'); }
    else if (action === 'token') { tokenResult = await api.request('/me/coupons/' + target + '/redemption-token', {}); tokenResult.coupon = target; }
    else if (action === 'refund') { await api.request('/refunds', { coupon_id: target, reason: value('refund-reason') }); tokenResult = null; notify('售后已受理，权益已冻结，请在订单 / 售后查看进度。'); }
    else if (action === 'preview') { var t = value('redeem-token').trim(); previewResult = await api.request('/redemption-previews', { token: t, store: 'store-' + state.actor.merchant }); previewResult.token = t; notify('预览成功，尚未核销。'); }
    else if (action === 'redeem') { if (!document.getElementById('service-confirmed').checked) throw new Error('请先确认测试履约及凭证'); await api.request('/redemptions', { token: previewResult.token, store: previewResult.store, service_confirmed: true }); previewResult = null; notify('核销完成，本商户应结明细已生成。'); }
    else if (action === 'share') shareResult = await api.request('/promotion-links', { product_id: value('share-product') });
    else if (action === 'copy-share') { var input = document.getElementById('share-url'); if (navigator.clipboard) { await navigator.clipboard.writeText(input.value); notify('链接已复制。'); } else { input.select(); notify('请复制已选中的链接。'); return; } }
    else if (action === 'withdraw') { var amount = value('withdraw-amount'); if (!/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error('请输入最多两位小数的正金额'); await api.request('/withdrawals', { amount: Math.round(Number(amount) * 100) }); notify('已提交测试机构指令，预占由测试机构维护。'); }
    else if (action === 'release') { await api.request('/admin/test-release', {}); notify('测试机构已返回账期可用状态。'); }
    else if (action === 'retry') { await api.request('/admin/orders/' + target + '/retry', {}); notify('已重试原发放批次，不新增赠送权利。'); }
    else if (action === 'approve-refund') { await api.request('/admin/refunds/' + target + '/approve', {}); notify('售后已复核并由测试机构处理。'); }
    else if (action === 'expire') { await api.request('/admin/coupons/' + target + '/test-expire', {}); notify('测试到期任务完成，退回与赔付分开记录。'); }
    else if (action === 'expiry-job') { result = await api.request('/admin/expiry-job', {}); notify('到期扫描完成，本次处理 ' + result.processed + ' 张。'); }
    else if (action === 'recover') await api.request('/admin/compensations/' + target + '/recover', {});
    else if (action.indexOf('payout-') === 0) await api.request('/admin/payouts/' + target + '/' + action.slice(7), {});
    else if (action === 'sales') await api.request('/admin/sales', { enabled: !state.sales_enabled });
    else if (action === 'capacity') { await api.request('/admin/test-capacity', { store: value('capacity-store'), date: value('capacity-date'), total: Number(value('capacity-total')) }); notify('测试产能已保存。'); }
    else if (action === 'membership-expire') await api.request('/admin/test-membership-expire', { id: target });
    else if (action === 'help') { await api.request('/help', { order_id: target, kind: value('help-kind-' + target) }); notify('已生成受理工单。'); }
    else if (action === 'help-resolve') await api.request('/admin/help/' + target + '/resolve', {});
    await refresh();
  }
  document.addEventListener('click', async function (event) {
    var nav = event.target.closest('[data-tab]'); if (nav && !busy) { tab = nav.dataset.tab; productId = null; selectedCoupon = null; tokenResult = null; notify(''); await refresh().catch(function (e) { notify(e.message, true); }); return; }
    var button = event.target.closest('[data-action]'); if (!button || button.disabled || busy) return;
    busy = true; document.body.dataset.commerceBusy = 'true'; button.disabled = true; notify('');
    try { await act(button.dataset.action, button.dataset.id); } catch (e) { notify(e.message, true); } finally { busy = false; document.body.dataset.commerceBusy = 'false'; if (button.isConnected) button.disabled = false; }
  });
  document.addEventListener('change', async function (event) {
    try {
      if (event.target.id === 'identity') { api.clear(); previewResult = null; shareResult = null; tokenResult = null; pendingOrder = null; selectedCoupon = null; tab = 'shop'; await api.login(event.target.value); notify('已切换隔离测试身份。'); await refresh(); }
      if (event.target.id === 'city') { query.set('city', event.target.value); await refresh(); }
      if (event.target.id === 'coupon-filter') { query.set('filter', event.target.value); render(); }
    } catch (e) { notify(e.message, true); }
  });
  async function boot() {
    try {
      meta = await api.request('/meta');
      if (meta.mode !== 'isolated-memory-test' || meta.real_money !== false) throw new Error('当前环境不是无资金联调环境');
      var select = document.getElementById('identity');
      select.innerHTML = meta.identities.map(function (a) { return '<option value="' + a.id + '">' + esc(a.name) + '</option>'; }).join('');
      var existing = api.actor(), defaultId = view === 'consumer' ? 'user-a' : view === 'promoter' ? 'promoter-a' : view === 'merchant' ? 'merchant-A' : 'admin';
      // Each workbench explicitly exchanges a test-only identity for an opaque server session.
      await api.login(existing && existing.role === view ? existing.id : defaultId);
      select.value = api.actor().id; await refresh();
    } catch (e) { content.innerHTML = empty('权益联调暂不可用', '请启动本地无资金联调服务后刷新。本页面不会回落为虚假的交易成功。'); notify(e.message, true); }
  }
  boot();
})();
