/* Shared settlement console. All money and authorization decisions belong to the server. */
(function () {
  'use strict';
  const BASE = '/api/settlement/v1';
  const $ = (s, root = document) => root.querySelector(s);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const exportJobs = new Map();
  const state = { identity: null, tab: 'items', filters: {}, rows: [], page: 1, loadVersion: 0 };
  const isAdmin = document.body.dataset.settlementView === 'admin';
  const content = $('#settlement-content');
  const names = { commerce: '生活权益', jiazheng: '生活服务', booking: '预订（民宿/长租）', minsu: '民宿', rental: '长租', offline: '线下支付（仅对账）', BOOKING_ORDER: '预订订单记录', ORDER_RECORDED: '订单已记录', BOOKING_CHECKOUT_DELAY: '按订单离店日期延后结算', CUSTOMER_ACCEPTANCE: '客户验收确认', COUPON_REDEMPTION: '权益有效核销', pay_center: '站内收银台', wechat_mini: '外部小程序', AUTO: '自动结算', REVIEW: '审核后结算', HOLD: '暂停结算', DRAFT: '草稿', READY: '待执行', AUTHORIZED: '已授权', IN_REVIEW: '审核中', WAITING_SCHEDULE: '待付款时间', SUBMITTING: '提交中', UNKNOWN: '结果待查询', SUCCESS: '已完成', SUCCEEDED: '已完成', FAILED: '失败', PAID: '已支付', PARTIAL: '部分完成', PENDING: '待处理', PUBLISHED: '已发布', VERIFIED: '已核验', REJECTED: '已驳回', UNVERIFIED: '待核验', COMPLETE: '资料齐全', INCOMPLETE: '资料待补', MISSING: '资料待补', DISPUTED: '有异议', CONFIRMED: '已确认', supplier: '商户应结', merchant: '商户应结', channel: '推广佣金', retained: '平台留存', beike: '平台佣金', PAYMENT: '外部收款', REFUND: '外部退款', FULFILLMENT: '履约确认', CHANNEL_SETTLEMENT: '渠道结付', COMMISSION_RECEIPT: '佣金到账', PAYMENT_ARRANGEMENT: '调整付款安排', ENTITLEMENT_ADJUSTMENT: '调整应结权益' };
  Object.assign(names, { EXECUTING:'执行中',PARTIALLY_PAID:'部分已付',FAILED_FINAL:'明确失败',CANCELLED:'已取消',SUPERSEDED:'已被新版本替代',REVOKED:'已撤销',QUEUED:'排队处理中',RUNNING:'处理中',RETRY:'等待重试',AVAILABLE:'可用',DONE:'已完成',ACTIVE:'已生效',DISABLED:'已停用',PENDING_PAYMENT:'等待实际付款',RECEIVABLE:'待向商户追偿',RECOVERED:'已追偿',RETURN_DUE:'待退还商户',compensation:'客户赔付',RECOVERY_OBLIGATION:'追偿义务',RECOVERY_RECEIPT:'追偿到账',APPROVED:'已批准', ISSUED:'已出账', MATCHED:'已核对', DIFFERENCE:'存在差异', PENDING_EVIDENCE:'待补凭证', PENDING_REVIEW:'待复核', BUSINESS_CONFIRMED:'业务已确认', PROVIDER_CONFIRMED:'机构已确认', CONTRACT_CONFIRMED:'合同已确认', CONFLICT:'资料有冲突', ORDER_COVERAGE:'订单记录', ORDER_STATUS:'订单状态', INTERNAL_OBLIGATION:'站内应结', INTERNAL_DISCHARGE:'站内结付', EXTERNAL_OBLIGATION:'外部佣金应计', EXTERNAL_TRADE:'外部交易', UNMATCHED_EXTERNAL_TRADE:'交易待匹配', PENDING_LEDGER_RECONCILIATION:'历史账务待补', TRANSFER_SUCCEEDED:'转账成功', MERCHANT_RELEASE_SUCCEEDED:'商户原款已释放', PAYOUT_SUCCEEDED:'佣金支付成功', PLATFORM_TRANSFER_SUCCEEDED:'佣金划转成功', PROCESSING:'机构处理中', OPEN:'待处理', RESOLVED:'已处理', NOT_RECEIVED:'未收到资料', PARTIAL_COVERAGE:'资料部分覆盖', REPORTED:'已报送', identity:'推广账号', platform:'平台主体', platform_transfer:'平台佣金划转', promoter:'推广佣金' });
  const label = v => names[v] || names[String(v || '').toUpperCase()] || String(v || '—');
  function money(v) {
    if (v == null || v === '') return '金额待补';
    try { const n = BigInt(v); const a = n < 0n ? -n : n; return (n < 0n ? '-¥' : '¥') + (a / 100n).toLocaleString('zh-CN') + '.' + String(a % 100n).padStart(2, '0'); } catch (_) { return '金额待补'; }
  }
  function minor(v, signed = false) {
    const s = String(v || '').trim();
    if (!(signed ? /^-?\d+(?:\.\d{1,2})?$/ : /^\d+(?:\.\d{1,2})?$/).test(s)) throw new Error('金额请填写最多两位小数的数字。');
    const negative = s.startsWith('-'); const [a, b = ''] = s.replace(/^-/, '').split('.');
    return String((BigInt(a) * 100n + BigInt(b.padEnd(2, '0'))) * (negative ? -1n : 1n));
  }
  const yuan = v => { try { const n = BigInt(v); return (n < 0n ? '-' : '') + String((n < 0n ? -n : n) / 100n) + '.' + String((n < 0n ? -n : n) % 100n).padStart(2, '0'); } catch (_) { return ''; } };
  const instant = v => new Date(typeof v === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
  const date = v => { if (!v) return '—'; const d = instant(v); return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('zh-CN', { hour12: false }); };
  const day = v => { if (!v) return '—'; if (/^\d{4}-\d\d-\d\d$/.test(String(v))) return String(v); const d = instant(v); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-CA', { timeZone:'Asia/Shanghai' }); };
  function bookingText(record) {
    const booking = record.booking || {};
    const pieces = [];
    if (booking.category_label || booking.category) pieces.push('品类 ' + (booking.category_label || label(booking.category)));
    if (booking.checkin || booking.checkout) pieces.push('入住 ' + day(booking.checkin) + ' · 离店 ' + day(booking.checkout));
    if (booking.rooms != null) pieces.push(String(booking.rooms) + ' 间');
    const quoted = record.quoted_minor ?? (booking.price_total != null ? minor(booking.price_total) : null);
    const commission = record.commission_minor ?? (booking.commission_fee != null ? minor(booking.commission_fee) : null);
    if (quoted != null) pieces.push('下单房费 ' + money(quoted));
    if (commission != null) pieces.push('锁定佣金 ' + money(commission));
    if (record.order_status) pieces.push('订单：' + ({ pending:'待商家确认', confirmed:'已确认', cancelled:'已取消', completed:'已完成' }[record.order_status] || label(record.order_status)));
    if (record.pay_status) pieces.push('支付：' + ({ offline:'线下支付，待核验', unpaid:'未支付', paid:'已支付', paying:'支付确认中', refunding:'退款处理中', refunded:'已退款', partially_refunded:'部分已退款' }[record.pay_status] || label(record.pay_status)));
    if (booking.checkout) pieces.push('结算时间按订单离店日期及账单日规则计算');
    return pieces.join('；');
  }
  const localDate = v => { if (!v) return ''; const d = instant(v); if (Number.isNaN(d.getTime())) return ''; return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
  const rowsOf = v => Array.isArray(v) ? v : v && (v.rows || v.items) || [];
  const can = p => !!state.identity && (state.identity.permissions || []).some(x => x === '*' || x === p);
  const makerChecker = () => state.identity ? state.identity.maker_checker !== false : true;
  const soloNote = () => makerChecker() ? '' : '（双人复核已关闭，可自行复核批准）';
  const partyName = id => { const p = (state.identity?.parties || []).find(p => String(p.id) === String(id)); return p ? p.name : id ? '主体 ' + id : '—'; };
  const badge = v => '<span class="badge ' + (/UNKNOWN|HOLD|REVIEW|PENDING|UNVERIFIED|INCOMPLETE|MISSING/i.test(v || '') ? 'warn' : /FAIL|REJECT|DISPUT/i.test(v || '') ? 'error' : '') + '">' + esc(label(v)) + '</span>';
  const button = (text, action, id, primary = false) => '<button type="button"' + (primary ? ' class="primary"' : '') + ' data-action="' + esc(action) + '"' + (id != null ? ' data-id="' + esc(id) + '"' : '') + '>' + esc(text) + '</button>';
  const field = (title, body, hint = '', full = false) => '<label class="field' + (full ? ' full' : '') + '"><span>' + esc(title) + '</span>' + body + (hint ? '<small>' + esc(hint) + '</small>' : '') + '</label>';
  const input = (name, value = '', attrs = '') => '<input name="' + esc(name) + '" value="' + esc(value) + '" ' + attrs + '>';
  const options = (list, selected) => list.map(([v, t]) => '<option value="' + esc(v) + '"' + (String(v) === String(selected) ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
  const select = (name, list, selected, attrs = '') => '<select name="' + esc(name) + '" ' + attrs + '>' + options(list, selected) + '</select>';
  const detail = (title, value) => '<div class="detail-row"><span>' + esc(title) + '</span><strong>' + esc(value) + '</strong></div>';
  const noData = (title, note = '请调整筛选条件，或稍后刷新查看。') => '<div class="empty"><h2>' + esc(title) + '</h2><p>' + esc(note) + '</p></div>';
  function status(text, error = false) { const el = $('#settlement-status'); el.textContent = text; el.classList.toggle('error', error); }
  function toast(text) { const n = document.createElement('div'); n.className = 'toast'; n.setAttribute('role', 'status'); n.textContent = text; document.body.append(n); setTimeout(() => n.remove(), 4500); }
  function requestKey() { return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  function headers(key) { const h = { Accept: 'application/json' }; const token = window.BZF_CONSOLE?.token(); if (token) h.Authorization = 'Bearer ' + token; if (key) { h['Content-Type'] = 'application/json'; h['Idempotency-Key'] = key; } return h; }
  async function api(path, body, key) {
    let response;
    if (body !== undefined) key = key || requestKey();
    if (path === '/admin/execution-plans' && body !== undefined) body = { ...body, request_key: key };
    try { response = await fetch(BASE + path, { method: body === undefined ? 'GET' : 'POST', headers: headers(body === undefined ? null : key || requestKey()), credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) }); }
    catch (_) { throw new Error('网络中断，提交结果暂未确认。请保留当前页面重试，系统会沿用同一请求编号。'); }
    const invalidResponse = () => {
      const message = response.status === 401 ? '请登录后继续。'
        : response.status === 404 ? '结算服务尚未就绪，请稍后重试。'
        : response.status >= 500 ? '结算服务暂时不可用，请稍后重试。'
        : response.status === 403 ? '当前账号暂时无法访问结算服务。'
        : '结算服务响应异常，请稍后重新加载。';
      const error = new Error(message); error.status = response.status; error.code = 'invalid_response'; return error;
    };
    let data; try { data = await response.json(); } catch (_) { throw invalidResponse(); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalidResponse();
    if (!response.ok || data.error) { const e = new Error(data.error?.message || (typeof data.error === 'string' && data.error) || '操作未完成，请稍后重试。'); e.status = response.status; e.code = data.code; throw e; }
    return Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data;
  }
  function keyedSubmit() { const keys = new Map(); return (path, body) => { const signature = path + JSON.stringify(body); if (!keys.has(signature)) keys.set(signature, requestKey()); return api(path, body, keys.get(signature)); }; }
  function modal(title, html, submitLabel, onSubmit) {
    const dialog = document.createElement('dialog');
    dialog.innerHTML = '<form><div class="dialog-head"><h2>' + esc(title) + '</h2><button type="button" data-close aria-label="关闭">×</button></div><div class="dialog-body">' + html + '<p class="form-error" role="alert"></p></div><div class="dialog-actions"><button type="button" data-close>关闭</button>' + (onSubmit ? '<button class="primary" type="submit">' + esc(submitLabel || '提交') + '</button>' : '') + '</div></form>';
    document.body.append(dialog); dialog.showModal(); dialog.addEventListener('close', () => dialog.remove());
    dialog.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => dialog.close()));
    const submit = keyedSubmit(); const form = $('form', dialog);
    form.addEventListener('submit', async e => { e.preventDefault(); if (!onSubmit) return; const b = $('[type=submit]', dialog); if (b.disabled) return; b.disabled = true; $('.form-error', dialog).textContent = ''; try { const close = await onSubmit(new FormData(form), dialog, submit); if (close !== false) dialog.close(); } catch (e) { $('.form-error', dialog).textContent = e.message; } finally { if (b.isConnected) b.disabled = false; } });
    return dialog;
  }
  function table(heads, rows) { return '<div class="table-wrap"><table><thead><tr>' + heads.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'; }
  function qs(values) { const p = new URLSearchParams(); Object.entries(values).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); }); return '?' + p.toString(); }
  function filterHTML() {
    const f = state.filters; const parties = (state.identity?.parties || []).map(p => [p.id, p.name]);
    const partyFilterField = '<label class="field"><span>结算主体</span>' + select('party_id', isAdmin && state.tab !== 'external' ? [['', '全部授权主体'], ...parties] : parties, f.party_id) + '<small>仅显示授权范围内主体：主体在「账户与协议 · 业务主体绑定」双人复核准入，账号可见范围由账号中心「数据权限」控制，详见 <a href="settlement-manual.html#roles" target="_blank" rel="noopener">结算手册</a>。</small></label>';
    return '<form id="settlement-filter" class="panel filters">' + field('业务', select('biz_type', [['', '全部业务'], ['commerce', '生活权益'], ['jiazheng', '生活服务'], ['booking', '预订（民宿/长租）']], f.biz_type)) + field('支付渠道', select('payment_mode', [['', '全部渠道'], ['pay_center', '站内收银台'], ['wechat_mini', '外部小程序'], ['offline', '线下支付（仅对账）']], f.payment_mode)) + partyFilterField + '<div class="filter-actions"><button class="primary" type="submit">查询</button>' + button('刷新', 'refresh') + '</div></form>';
  }
  function tabsHTML() { return '<nav class="tabs" role="tablist" aria-label="结算工作区">' + [['items', '应结与付款', 'settlement.fund.read'], ['approvals', '审批待办', 'settlement.approval.act'], ['policies', '结算规则', 'settlement.policy.write'], ['external', '外部对账资料', 'settlement.external.import'], ['configuration', '账户与协议', 'settlement.policy.write'], ['own-funds', '补差与赔付', 'settlement.fund.read']].filter(([, , p]) => can(p) || (p === 'settlement.policy.write' && can('settlement.policy.review')) || (p === 'settlement.external.import' && can('settlement.external.review'))).map(([id, title]) => '<button type="button" role="tab" data-action="tab" data-id="' + id + '" aria-selected="' + (state.tab === id) + '">' + title + '</button>').join('') + '</nav>'; }
  async function initialize() {
    content.setAttribute('aria-busy', 'true');
    try {
      state.identity = await api('/me');
      window.BZF_SETTLEMENT = { identity: state.identity, can };
      $('#settlement-account').textContent = state.identity.account?.display_name || state.identity.account?.login_name || '已登录';
      $('[data-action=login]').hidden = true; $('[data-action=logout]').hidden = false;
      window.BZF_COMMERCE_NAV?.refresh();
      const tabFromHash = /^[#]*tab=([\w-]+)$/.exec(location.hash || '');
      if (isAdmin && tabFromHash) state.tab = tabFromHash[1];
      if (!isAdmin && !state.filters.party_id) state.filters.party_id = state.identity.parties?.[0]?.id || '';
      await load();
    } catch (e) {
      state.identity = null;
      $('#settlement-account').textContent = e.status === 401 ? '尚未登录' : '账号读取失败';
      content.innerHTML = '<section class="panel">' + noData(e.status === 401 ? '登录后查看结算与对账' : '暂时无法读取结算数据', e.status === 401 ? '请使用已获授权的新居住账号登录。' : e.message) + '<div class="actions">' + button(e.status === 401 ? '账号登录' : '重新加载', e.status === 401 ? 'login' : 'initialize', null, true) + '</div></section>';
    } finally { content.setAttribute('aria-busy', 'false'); }
  }
  async function load() {
    const version = ++state.loadVersion;
    content.setAttribute('aria-busy', 'true'); status('');
    try {
      if (!isAdmin) { if (!can('settlement.statement.read')) { content.innerHTML = '<section class="panel">' + noData('当前账号没有账单查看权限', '请由账号管理员配置结算主体及账单权限。') + '</section>'; return; } }
      const permittedTabs = [['items', 'settlement.fund.read'], ['approvals', 'settlement.approval.act'], ['policies', 'settlement.policy.write'], ['policies', 'settlement.policy.review'], ['external', 'settlement.external.import'], ['external', 'settlement.external.review'], ['configuration', 'settlement.policy.write'], ['configuration', 'settlement.policy.review'], ['own-funds', 'settlement.fund.read']].filter(([, p]) => can(p)).map(([t]) => t);
      if (isAdmin && !permittedTabs.includes(state.tab)) state.tab = permittedTabs[0];
      if (isAdmin && !state.tab) { content.innerHTML = '<section class="panel">' + noData('当前账号没有结算管理权限', '您仍可通过收款方对账单入口查看获授权的账单。') + '</section>'; return; }
      if (isAdmin && state.tab === 'external' && !state.filters.party_id) state.filters.party_id = state.identity.parties?.[0]?.id || '';
      if (isAdmin && state.tab === 'own-funds') { await loadOwnFunds(version); return; }
      if (isAdmin && state.tab === 'configuration') { await loadConfiguration(version); return; }
      if (isAdmin && state.tab === 'external' && (state.filters.biz_type === 'booking' || state.filters.payment_mode === 'offline')) { content.innerHTML = tabsHTML() + filterHTML() + '<section class="panel">' + noData('预订订单请通过收款方对账单核对', '线下房费仅作为订单对账资料，不在生活服务外部凭证入口提交，也不发起站内付款。') + '</section>'; return; }
      let path = isAdmin ? { items: '/admin/items', approvals: '/admin/approval-tasks', policies: '/admin/policies', external: '/admin/external-evidence' }[state.tab] : '/me/settlement-statements';
      const result = await api(path + qs({ ...state.filters, page: state.page, limit: 50 }));
      if (!isAdmin && version === state.loadVersion) { try { state.statementPolicies = rowsOf(await api('/me/statement-policy')); } catch (_) { state.statementPolicies = []; } }
      if (version !== state.loadVersion) return;
      const allRows = rowsOf(result);
      const paginate = !isAdmin || state.tab === 'items';
      state.rows = paginate && !result.page ? allRows.slice((state.page - 1) * 50, state.page * 50) : allRows;
      state.pagination = { total: result.total ?? allRows.length, has_more: result.has_more ?? (paginate && allRows.length > state.page * 50) };
      content.innerHTML = (isAdmin ? tabsHTML() : '') + filterHTML() + (!isAdmin ? statementsHTML(result) : state.tab === 'items' ? itemsHTML(result) : state.tab === 'policies' ? policiesHTML(result) : state.tab === 'approvals' ? approvalsHTML(result) : externalHTML(result));
    } catch (e) { if (version === state.loadVersion) { status(e.message, true); content.innerHTML = (isAdmin ? tabsHTML() : '') + filterHTML() + '<section class="panel">' + noData('暂未取得业务数据', e.message) + '</section>'; } }
    finally { if (version === state.loadVersion) content.setAttribute('aria-busy', 'false'); }
  }
  function itemsHTML(result) {
    const rows = state.rows.map(r => '<tr><td><strong>' + esc(r.order_no || r.biz_order_no || r.id) + '</strong><small>' + esc(label(r.biz_type)) + ' · ' + esc(label(r.payment_mode)) + '</small></td><td>' + esc(r.beneficiary_name || partyName(r.beneficiary_party_id)) + '<small>' + esc(label(r.line_kind)) + '</small></td><td class="money">' + esc(money(r.payable_minor)) + '</td><td class="money">' + esc(money(r.planned_minor)) + '</td><td class="money">' + esc(money(r.discharged_minor)) + '</td><td>' + esc(date(r.not_before_at)) + '</td><td>' + badge(r.status) + (r.hold_reason ? '<small class="break">' + esc(r.hold_reason) + '</small>' : '') + '</td><td>' + button('查看 / 处理', 'item', r.id) + '</td></tr>');
    return '<section class="panel"><div class="panel-head"><div><h2>逐笔应结</h2><p>付款安排、审批与机构回执相互关联，外部和线下支付仅用于对账；预订（民宿/长租）按订单离店日期计资格：未配置账单日时逐笔 T+N 结算，配置账单日后统一在账单日随账单批量结算。</p></div><span class="muted">本页 ' + rows.length + ' 笔</span></div>' + (rows.length ? table(['业务订单', '收款方', '应结金额', '计划付款', '已结付', '最早付款时间', '进度', '操作'], rows) : noData('暂无符合条件的应结记录')) + pagination(result) + '</section>';
  }
  function pagination(result) { result = state.pagination || result; return '<div class="pagination">' + (state.page > 1 ? button('上一页', 'prev') : '') + '<span>第 ' + state.page + ' 页</span>' + (result.has_more || result.total > state.page * 50 ? button('下一页', 'next') : '') + '</div>'; }
  async function showItem(id) {
    const item = await api('/admin/items/' + encodeURIComponent(id));
    const ctx = item.context || {};
    const booking = (typeof ctx.snapshot === 'string' ? JSON.parse(ctx.snapshot) : ctx.snapshot)?.booking || ctx.booking;
    const actions = item.payment_mode !== 'pay_center' ? '<p class="notice">本订单仅用于对账，不通过本工作台发起付款。</p>' : (can('settlement.fund.adjust') ? button('调整付款安排', 'adjust', id) : '') + (can('settlement.fund.write') ? button('按规则申请结算', 'authorize', id, true) + button('创建执行计划', 'execute', id) : '');
    const orders = item.execution_orders || [];
    const d = modal('应结详情', '<div class="actions">' + badge(item.status) + '<span class="muted">版本 ' + esc(item.revision) + '</span></div><div class="detail-grid">' + detail('业务订单', ctx.biz_order_no || item.biz_order_no || id) + detail('业务 / 支付', label(item.biz_type) + ' / ' + label(item.payment_mode)) + detail('收款主体', partyName(item.beneficiary_party_id)) + detail('款项', label(item.line_kind)) + detail('应结总额', money(item.payable_minor)) + detail('计划付款', money(item.planned_minor)) + detail('已结付', money(item.discharged_minor)) + detail('剩余应结', money(item.remaining_minor)) + detail('最早付款时间', date(item.not_before_at)) + detail('收款账户', item.account_label || item.account_id || '待配置') + '</div>' + (item.hold_reason ? '<p class="notice">' + esc(item.hold_reason) + '</p>' : '') + '<div class="actions">' + actions + '</div><hr class="section-divider"><h3>执行记录</h3>' + (orders.length ? table(['请求编号', '金额', '状态', '操作'], orders.map(o => '<tr><td class="break">' + esc(o.request_no || o.id) + '</td><td>' + esc(money(o.amount_minor)) + '</td><td>' + badge(o.status) + '</td><td>' + (can('settlement.fund.write') ? button('查询机构结果', 'query-execution', o.id) : '—') + '</td></tr>')) : '<p class="subtle">暂无执行记录。提交受理后仍需以机构查询或回执确认结果。</p>') + '<h3>调整记录</h3>' + (item.adjustments?.length ? table(['时间', '调整类型', '原因'], item.adjustments.map(a => '<tr><td>' + esc(date(a.created_at)) + '</td><td>' + esc(label(a.kind)) + '</td><td class="break">' + esc(a.reason) + '</td></tr>')) : '<p class="subtle">暂无调整。</p>'));
    if (item.biz_type === 'booking' && booking) { const note = document.createElement('p'); note.className = 'notice'; note.textContent = bookingText({ ...item, booking }); $('.dialog-body', d).prepend(note); }
    d.dataset.itemId = id; d._item = item;
  }
  async function adjustItem(id, from) {
    const item = from?._item || await api('/admin/items/' + encodeURIComponent(id));
    const [accountResult, sourceResult] = await Promise.all([api('/admin/accounts' + qs({ party_id: item.beneficiary_party_id })), api('/admin/funding-sources' + qs({ party_id: item.beneficiary_party_id, source_type: 'supplement' }))]);
    const accounts = rowsOf(accountResult).filter(a => String(a.party_id) === String(item.beneficiary_party_id) && /^approved$/i.test(a.status));
    from?.close();
    const html = '<p class="notice">调整付款安排不会减少剩余应付。变更应结权益需填写依据，并重新完成审批。执行中的款项请先查询结果。</p><div class="form-grid">' + field('调整类型', select('kind', [['PAYMENT_ARRANGEMENT', '付款安排：金额、时间、账户'], ['ENTITLEMENT_ADJUSTMENT', '应结权益变更：补付或减免']])) + field('本次计划付款（元）', input('planned', yuan(item.planned_minor ?? item.remaining_minor), 'inputmode="decimal"'), '仅调整本次付款，未付余额继续保留。') + field('应结增减（元）', input('delta', '', 'inputmode="decimal"'), '权益变更时填写；增加填正数，减少填负数。') + field('最早付款时间', input('not_before_at', localDate(item.not_before_at), 'type="datetime-local"')) + field('收款账户', select('account_id', [['', '保留当前账户'], ...accounts.map(a => [a.id, a.name || a.account_label || ('已验证账户 · ' + String(a.merchant_no || a.id).slice(-6))])], item.account_id), '仅展示本收款主体获批的账户。') + field('已确认补差资金来源', select('source_id', [['', '增加应结时选择'], ...rowsOf(sourceResult).map(s => [s.id, (s.name || '已核验资金') + ' · 可用 ' + money(s.available_minor ?? s.remaining_minor)])]), '仅增加应结时使用，原订单资金不会被重复占用。') + field('调整依据 / 凭证编号', input('evidence', '', 'maxlength="500"')) + field('调整原因', '<textarea name="reason" required maxlength="1000" placeholder="说明变更背景及约定依据"></textarea>', '', true) + '</div><div id="adjust-preview"></div>';
    let previewed = '';
    const d = modal('单笔调整', html, '预览调整结果', async (data, dialog, submit) => {
      const payload = { expected_revision: item.revision, kind: data.get('kind'), reason: data.get('reason').trim() };
      if (data.get('planned').trim() !== '') payload.planned_minor = minor(data.get('planned'));
      if (payload.kind === 'ENTITLEMENT_ADJUSTMENT') payload.delta_minor = minor(data.get('delta'), true);
      if (data.get('not_before_at')) payload.not_before_at = new Date(data.get('not_before_at')).toISOString();
      if (data.get('account_id')) payload.account_id = data.get('account_id');
      if (data.get('evidence').trim()) payload.evidence = data.get('evidence').trim();
      if (data.get('source_id')) payload.source_id = data.get('source_id');
      const signature = JSON.stringify(payload);
      if (signature !== previewed) {
        const r = await submit('/admin/items/' + encodeURIComponent(id) + '/adjustments/preview', payload);
        const after = r.after || {};
        $('#adjust-preview', dialog).innerHTML = '<div class="preview"><h3>确认调整结果</h3><div class="detail-grid">' + detail('调整前应结', money(r.before?.payable_minor ?? item.payable_minor)) + detail('调整后应结', money(after.payable_minor)) + detail('调整后计划付款', money(after.planned_minor)) + detail('剩余应结', money(after.remaining_minor)) + '</div><p class="subtle">' + (r.requires_review ? '提交后需要重新审批。' : '提交后由规则重新校验授权和付款条件。') + '</p></div>';
        previewed = signature; $('[type=submit]', dialog).textContent = '确认提交调整'; return false;
      }
      await submit('/admin/items/' + encodeURIComponent(id) + '/adjustments', payload); toast('调整已提交'); await load();
    });
    $('form', d).addEventListener('input', () => { if (previewed) { previewed = ''; $('#adjust-preview', d).textContent = ''; $('[type=submit]', d).textContent = '预览调整结果'; } });
  }
  function approvalsHTML() {
    return '<section class="panel"><div class="panel-head"><div><h2>我的审批待办</h2><p>仅展示当前账号可处理的节点，变更后的款项按新版本重新审批。</p></div></div>' + (state.rows.length ? table(['应结记录', '审批节点', '版本', '状态', '操作'], state.rows.map(r => '<tr><td>' + esc(r.item_id) + '</td><td>' + esc(r.node_name || r.name || '财务审批') + '</td><td>' + esc(r.revision) + '</td><td>' + badge(r.status) + '</td><td>' + button('查看并审批', 'approval', r.id) + '</td></tr>')) : noData('暂无待处理审批')) + '</section>';
  }
  async function approval(id) {
    const task = state.rows.find(r => String(r.id) === String(id));
    const item = await api('/admin/items/' + encodeURIComponent(task.item_id));
    modal('审批结算申请', '<div class="detail-grid">' + detail('收款方', partyName(item.beneficiary_party_id)) + detail('计划付款', money(item.planned_minor)) + detail('收款账户', item.account_label || item.account_id) + detail('最早付款时间', date(item.not_before_at)) + '</div><div class="form-grid">' + field('审批结论', select('action', [['approve', '通过'], ['reject', '驳回']])) + field('审批意见', '<textarea name="note" required maxlength="1000"></textarea>') + '</div>', '提交审批', async (data, d, submit) => { await submit('/admin/approval-tasks/' + encodeURIComponent(id) + '/actions', { revision: task.revision, action: data.get('action'), note: data.get('note').trim() }); toast('审批已记录'); await load(); });
  }
  function policiesHTML() {
    return '<section class="panel"><div class="panel-head"><div><h2>结算规则</h2><p>按业务、商户与金额范围配置；发布后应用于新的结算授权。预订（民宿/长租）的账单日是 T+N 账单日模式的单一配置来源，出账周期自动随动。</p></div>' + (can('settlement.policy.write') ? button('新建规则', 'new-policy', null, true) : '') + '</div>' + (state.rows.length ? table(['适用范围', '结算方式', '优先级', '版本 / 状态', '审批节点', '操作'], state.rows.map(r => '<tr><td>' + esc(label(r.biz_type)) + '<small>' + esc(r.party_id ? partyName(r.party_id) : '授权业务范围') + ' · ' + esc(label(r.payment_mode || '全部渠道')) + '</small></td><td>' + badge(r.mode) + (r.biz_type === 'booking' ? '<small>' + esc(r.conditions?.booking_checkout_delay_days == null ? '离店等待天数待配置' : '离店后 ' + r.conditions.booking_checkout_delay_days + ' 天') + '</small><small>' + (r.conditions?.billing_day != null ? '每月 ' + esc(r.conditions.billing_day) + ' 日账单日随账单批量结算' : '逐笔 T+N') + '</small>' : '') + '</td><td>' + esc(r.priority) + '</td><td>v' + esc(r.version || 1) + ' ' + badge(r.status) + '</td><td>' + esc(r.mode === 'HOLD' ? '暂不执行' : r.mode === 'REVIEW' ? (r.nodes || []).map(n => n.name).join(' → ') || '待配置审批节点' : '无需人工审批') + '</td><td>' + (can('settlement.policy.review') && /draft|pending/i.test(r.status || '') ? button('审核发布', 'publish-policy', r.id) : can('settlement.policy.write') && /^(approved|active)$/i.test(r.status || '') ? button('停用规则', 'disable-policy', r.id) : '—') + '</td></tr>')) : noData('尚未配置结算规则', '未命中有效规则的款项不会自动出款。')) + '</section>';
  }
  function newPolicy() {
    const parties = state.identity.parties || [];
    const html = '<div class="form-grid">' + field('业务', select('biz_type', [['commerce', '生活权益'], ['jiazheng', '生活服务'], ['booking', '预订（民宿/长租）']])) + field('商户 / 主体', select('party_id', [['', '当前业务的全部授权主体'], ...parties.map(p => [p.id, p.name])])) + field('支付渠道', select('payment_mode', [['pay_center', '站内收银台'], ['offline', '线下支付（仅对账）']]), '线下渠道只用于对账，配置规则不会产生站内付款。') + field('结算方式', select('mode', [['REVIEW', '审核后结算'], ['AUTO', '自动结算'], ['HOLD', '暂停结算']])) + field('离店后等待天数', input('booking_checkout_delay_days', '', 'type="number" min="0" max="3650" step="1"'), '按订单离店日期计算资格（T+N 的 N）；到期后仍按所选自动或审核规则处理。') + field('账单日（每月几号，选填）', input('billing_day', '', 'type="number" min="1" max="28" step="1"'), '留空 = 逐笔：每笔订单离店 N 天后单独结算。填写 = 账单日模式：订单在离店 N 天后统一等到最近一个账单日，随账单批量结算（T+N）。') + field('优先级', input('priority', '100', 'type="number" required min="0" step="1"')) + field('金额下限（元）', input('min', '', 'inputmode="decimal"')) + field('金额上限（元）', input('max', '', 'inputmode="decimal"')) + '</div><hr class="section-divider"><h3>人工审批节点</h3><p class="subtle">按显示顺序依次审核。会签需全部审批人通过，或签由任一审批人通过。</p><div id="policy-nodes"></div>' + button('添加审批节点', 'add-node');
    const d = modal('新建结算规则', html, '保存草稿', async (data, dialog, submit) => {
      const payload = { biz_type: data.get('biz_type'), payment_mode: data.get('payment_mode'), priority: Number(data.get('priority')), mode: data.get('mode'), conditions: {}, nodes: [] };
      if (payload.biz_type === 'booking') {
        const days = String(data.get('booking_checkout_delay_days') || '').trim(); if (!/^\d+$/.test(days) || Number(days) > 3650) throw new Error('预订结算需填写 0 至 3650 的整数等待天数。'); payload.conditions.booking_checkout_delay_days = Number(days);
        const bill = String(data.get('billing_day') || '').trim(); if (bill !== '') { if (!/^\d+$/.test(bill) || Number(bill) < 1 || Number(bill) > 28) throw new Error('账单日须为每月 1–28 日的整数，留空表示逐笔结算。'); payload.conditions.billing_day = Number(bill); }
      }
      if (data.get('party_id')) payload.party_id = data.get('party_id');
      if (data.get('min').trim()) payload.conditions.min_minor = minor(data.get('min'));
      if (data.get('max').trim()) payload.conditions.max_minor = minor(data.get('max'));
      if (payload.conditions.min_minor && payload.conditions.max_minor && BigInt(payload.conditions.min_minor) > BigInt(payload.conditions.max_minor)) throw new Error('金额下限不能大于上限。');
      if (payload.mode === 'REVIEW') { dialog.querySelectorAll('.node-row').forEach(row => { const ids = $('[name=node_approvers]', row).value.split(/[,，\s]+/).filter(Boolean); if (!ids.length || ids.some(v => !/^\d+$/.test(v))) throw new Error('每个审批节点需填写有效的审批人账号编号。'); payload.nodes.push({ name: $('[name=node_name]', row).value.trim(), mode: $('[name=node_mode]', row).value, approver_ids: ids }); }); if (!payload.nodes.length) throw new Error('审核后结算至少需要一个人工审批节点。'); }
      await submit('/admin/policies', payload); toast('规则草稿已保存'+(makerChecker()?'，需由另一位授权人员审核发布':'；双人复核已关闭，可在本页直接审核发布')); await load();
    });
    const syncBookingDelay = () => { const booking = $('[name=biz_type]', d).value === 'booking'; const delay = $('[name=booking_checkout_delay_days]', d); const bill = $('[name=billing_day]', d); $('[name=payment_mode] option[value=offline]', d).disabled = !booking; if (!booking && $('[name=payment_mode]', d).value === 'offline') $('[name=payment_mode]', d).value = 'pay_center'; delay.required = booking; delay.disabled = !booking; delay.closest('.field').hidden = !booking; bill.disabled = !booking; bill.closest('.field').hidden = !booking; };
    $('[name=biz_type]', d).addEventListener('change', syncBookingDelay); syncBookingDelay();
    appendNode(d);
  }
  function appendNode(d) {
    const node = document.createElement('div'); node.className = 'node-row';
    node.innerHTML = field('节点名称', input('node_name', '', 'required maxlength="60" placeholder="如：财务复核"')) + field('审批人账号编号', input('node_approvers', '', 'required placeholder="多个账号用逗号分隔"')) + field('审核方式', select('node_mode', [['ALL', '会签'], ['ANY', '或签']])) + button('移除', 'remove-node');
    $('#policy-nodes', d).append(node); syncNodeMode(d);
  }
  function syncNodeMode(d) { const review = $('[name=mode]', d)?.value === 'REVIEW'; d.querySelectorAll('.node-row input,.node-row select').forEach(e => { e.disabled = !review; }); }
  function statementCycleHTML() {
    const list = (state.statementPolicies || []).filter(p => !state.filters.party_id || String(p.party_id) === String(state.filters.party_id));
    if (!list.length) return '';
    const cycle = p => p.billing_day ? '每月 ' + esc(p.billing_day) + ' 日为账单日（T+N 账单日模式，账单汇总该日前已到结算期的预订订单）' : '自然月出账（逐笔结算）';
    const pieces = list.map(p => (state.filters.party_id ? '' : esc(partyName(p.party_id)) + '：') + '<span>' + cycle(p) + '</span> · 本期 ' + day(p.current_period?.period_start) + ' 至 ' + day(p.current_period?.period_end) + ' · 下次出账 ' + date(p.next_run_at));
    return '<p class="notice">出账周期：' + pieces.join('；') + '</p>';
  }
  function statementsHTML() {
    const actions = (can('settlement.external.submit') && state.filters.biz_type !== 'booking' && state.filters.payment_mode !== 'offline' ? button('补充外部对账资料', 'submit-evidence') : '') + (can('settlement.statement.generate') ? button('生成账单', 'generate-statement', null, true) : '');
    return '<section class="panel"><div class="panel-head"><div><h2>账单记录</h2><p>账期末余额与当前收款进度分别展示；资料补齐后保留历史版本。</p></div><div class="actions">' + actions + '</div></div>' + statementCycleHTML() + (state.rows.length ? table(['账期 / 账单', '结算主体', '版本', '核验进度', '资料覆盖', '发布状态', '操作'], state.rows.map(r => '<tr><td><strong>' + esc(day(r.period_start)) + ' 至 ' + esc(day(r.period_end)) + '</strong><small>' + esc(r.statement_no || r.id) + ' · 结束日不含当日</small></td><td>' + esc(partyName(r.party_id)) + '</td><td>v' + esc(r.version) + '</td><td>' + badge(r.recon_status) + '</td><td>' + badge(r.coverage_status) + '</td><td>' + badge(r.publication_status) + '</td><td>' + button('查看账单', 'statement', r.id) + '</td></tr>')) : noData('暂无已生成账单', '站内、外部与预订（民宿/长租）线下支付均按约定账期出账；待补资料将在账单中明确标注。')) + pagination({}) + '</section>';
  }
  async function showStatement(id) {
    const r = await api('/me/settlement-statements/' + encodeURIComponent(id)); const snapshot = r.snapshot || {}; const summary = snapshot.summary || r.summary || {}; const lines = snapshot.lines || [];
    const fields = [['opening_minor', '期初未结'], ['accrued_minor', '本期新增应结'], ['reduced_minor', '本期应付冲减'], ['discharged_minor', '本期结付'], ['closing_minor', '期末未结'], ['reported_payment_minor', '外部申报收款'], ['verified_payment_minor', '已核验外部收款'], ['verified_refund_minor', '已核验外部退款'], ['external_net_minor', '外部净收款'], ['external_receivable_opening_minor', '期初佣金应收'], ['external_receivable_accrued_minor', '本期佣金应收'], ['external_receivable_settled_minor', '本期佣金已收'], ['external_receivable_outstanding_minor', '佣金未收'], ['external_payable_opening_minor', '期初佣金应付'], ['external_payable_accrued_minor', '本期佣金应付'], ['external_payable_settled_minor', '本期佣金已付'], ['external_payable_outstanding_minor', '佣金未付'], ['recovery_receivable_opening_minor', '期初追偿应收'], ['recovery_receivable_accrued_minor', '本期追偿应收'], ['recovery_receivable_reduced_minor', '追偿应收冲减'], ['recovery_receivable_recovered_minor', '追偿实际收回'], ['recovery_receivable_outstanding_minor', '追偿待收回'], ['recovery_payable_opening_minor', '期初追偿应还'], ['recovery_payable_accrued_minor', '本期追偿应还'], ['recovery_payable_reduced_minor', '追偿应还冲减'], ['recovery_payable_recovered_minor', '实际已归还'], ['recovery_payable_outstanding_minor', '追偿待归还'], ['bank_returned_minor', '银行退票'], ['split_returned_minor', '分账回退']];
    const metrics = fields.filter(([key]) => Object.prototype.hasOwnProperty.call(summary, key)).map(([key, title]) => '<div class="metric"><span>' + title + '</span><strong>' + esc(money(summary[key])) + '</strong></div>').join('');
    const actions = (can('settlement.statement.export') ? ['csv', 'xlsx', 'pdf'].map(format => button('下载 ' + format.toUpperCase(), 'export-' + format, id)).join('') : '') + (can('settlement.statement.confirm') ? button('确认账单', 'confirm-statement', id) : '') + (can('settlement.statement.dispute') ? button('提出异议', 'dispute-statement', id) : '');
    const unknown = summary.unknown_amount_count ?? summary.unknown_count ?? lines.filter(l => l.record_type !== 'BOOKING_ORDER' && l.amount_minor == null && l.payable_minor == null).length;
    const d = modal('对账单 · ' + (r.statement_no || id), '<div class="actions">' + badge(r.recon_status) + badge(r.coverage_status) + '<span class="muted">v' + esc(r.version) + ' · 截至 ' + esc(date(r.as_of)) + '</span></div><p class="subtle">' + esc(partyName(r.party_id)) + ' · ' + esc(day(r.period_start)) + ' 至 ' + esc(day(r.period_end)) + '（结束日不含当日） · ' + esc(r.currency || 'CNY') + '</p>' + (metrics ? '<div class="metrics">' + metrics + '</div>' : '') + (unknown ? '<p class="notice">有 ' + esc(unknown) + ' 条记录金额待补，未按零元计入已知金额合计。资料核验后会生成新的账单版本。</p>' : '') + '<div class="actions">' + actions + '</div><hr class="section-divider">' + (lines.length ? table(['业务 / 订单', '项目', '金额', '支付渠道', '核验', '说明'], lines.map(l => '<tr><td>' + esc(label(l.biz_type)) + '<small>' + esc(l.order_ref || l.biz_order_no || l.order_no || l.order_id || '—') + '</small></td><td>' + esc(label(l.kind || l.event_kind || l.line_kind || l.record_type)) + '</td><td class="money">' + esc(l.record_type === 'BOOKING_ORDER' ? '—（订单记录）' : money(l.amount_minor ?? l.payable_minor)) + '</td><td>' + esc(label(l.payment_mode)) + '</td><td>' + badge(l.verification_status || l.status || 'PENDING') + '</td><td class="break">' + esc(l.record_type === 'BOOKING_ORDER' ? bookingText(l) + '；房费及佣金为下单快照，实际收付另列流水。' : l.note || l.reason || l.coverage_reason || '') + '</td></tr>')) : '<p class="subtle">该账期暂无明细。</p>'));
    d._statement = r;
  }
  function generateStatement() {
    const parties = state.identity.parties || []; const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), 1); const next = new Date(now.getFullYear(), now.getMonth() + 1, 1); const toDay = d => new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    modal('生成对账单', '<div class="form-grid">' + field('结算主体', select('party_id', parties.map(p => [p.id, p.name]), state.filters.party_id, 'required')) + field('币种', select('currency', [['CNY', '人民币']])) + field('账期开始', input('period_start', toDay(start), 'type="date" required')) + field('账期结束（不含当日）', input('period_end', toDay(next), 'type="date" required')) + field('业务', select('biz_type', [['', '全部授权业务'], ['commerce', '生活权益'], ['jiazheng', '生活服务'], ['booking', '预订（民宿/长租）']], state.filters.biz_type)) + field('支付渠道', select('payment_mode', [['', '全部支付渠道'], ['pay_center', '站内收银台'], ['wechat_mini', '外部小程序'], ['offline', '线下支付（仅对账）']], state.filters.payment_mode)) + '</div><p class="notice">资料缺失的外部订单正常列入账单，金额待补或待核验项目会单独标明。</p>', '生成账单', async (data, d, submit) => { const p = { party_id: data.get('party_id'), currency: data.get('currency'), period_start: data.get('period_start'), period_end: data.get('period_end') }; if (p.period_start >= p.period_end) throw new Error('结束日期必须晚于开始日期。'); if (data.get('biz_type')) p.biz_types = [data.get('biz_type')]; if (data.get('payment_mode')) p.payment_modes = [data.get('payment_mode')]; await submit('/admin/settlement-statements/generate', p); toast('账单已生成'); await load(); });
  }
  async function exportStatement(id, format, b) {
    const exportKey = String(id) + ':' + format; const submit = keyedSubmit(); const result = exportJobs.get(exportKey) || await submit('/me/settlement-statements/' + encodeURIComponent(id) + '/exports', { format }); exportJobs.set(exportKey, result);
    const exportId = result.id || result.export_id; if (!exportId) throw new Error('未取得导出任务编号，请稍后重试。');
    let job = result;
    for (let attempt = 0; !/^(READY|COMPLETED|SUCCESS)$/i.test(job.status || '') && attempt < 12; attempt++) {
      if (/FAILED|REJECTED|EXPIRED/i.test(job.status || '')) { exportJobs.delete(exportKey); throw new Error(job.error || '导出未完成，请稍后重试。'); }
      b.textContent = '正在生成…'; await new Promise(resolve => setTimeout(resolve, 1000)); job = await api('/me/statement-exports/' + encodeURIComponent(exportId));
    }
    if (!/^(READY|COMPLETED|SUCCESS)$/i.test(job.status || '')) { toast('账单正在生成，请稍后重新点击下载'); return; }
    const response = await fetch(BASE + '/me/statement-exports/' + encodeURIComponent(exportId) + '/download', { headers: headers(), credentials: 'same-origin' });
    if (!response.ok) { let d; try { d = await response.json(); } catch (_) {} throw new Error(d?.error || '暂时无法下载，请确认当前账号仍有账单权限。'); }
    const blob = await response.blob(); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = '对账单-' + String(id).replace(/[^\w-]/g, '') + '.' + format; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); toast('账单已下载');
  }
  function statementResponse(id, dispute) {
    document.querySelectorAll('dialog').forEach(d => { if (d._statement) d.close(); });
    modal(dispute ? '提交账单异议' : '确认账单', '<p class="subtle">' + (dispute ? '请说明争议项目、金额及依据。提交异议不会覆盖原账单。' : '确认本账单的展示内容；确认不代表平台已收到外部佣金。') + '</p><div class="form-grid">' + (dispute ? field('争议明细编号（选填）', input('line_key')) + field('凭证编号', input('evidence_ref', '', 'required maxlength="500"')) : '') + field(dispute ? '异议说明' : '确认备注', '<textarea name="note" ' + (dispute ? 'required' : '') + ' maxlength="1000"></textarea>', '', true) + '</div>', dispute ? '提交异议' : '确认账单', async (data, d, submit) => { const p = dispute ? { reason: data.get('note').trim(), line_key: data.get('line_key') || undefined, evidence_ref: data.get('evidence_ref') || undefined } : { note: data.get('note').trim() }; await submit('/me/settlement-statements/' + encodeURIComponent(id) + (dispute ? '/disputes' : '/confirmations'), p); toast(dispute ? '异议已提交，等待处理' : '账单确认已记录'); await load(); });
  }
  function externalHTML() {
    return '<section class="panel"><div class="panel-head"><div><h2>外部对账资料</h2><p>外部收款、退款、结付及佣金到账分别核验，导入人与复核人相互独立。</p></div><div class="actions">' + (can('settlement.external.import') ? button('导入凭证', 'import-evidence', null, true) + button('CSV 批量导入', 'import-csv') : '') + '</div></div>' + (state.rows.length ? table(['外部交易', '主体', '事件', '金额', '核验状态', '操作'], state.rows.map(r => '<tr><td class="break">' + esc(r.transaction_id || r.source_event_id || r.id) + '<small>' + esc(r.channel) + '</small></td><td>' + esc(partyName(r.party_id)) + '</td><td>' + esc(label(r.event_kind)) + '</td><td class="money">' + esc(money(r.amount_minor)) + '</td><td>' + badge(r.verification_status || r.status) + '</td><td>' + (can('settlement.external.review') && ((r.evidence || []).some(e => /^(PENDING|UNVERIFIED|CONFLICT)$/i.test(e.review_status || 'PENDING')) || !/^(VERIFIED|REJECTED)$/i.test(r.verification_status || r.status || '')) ? button('复核', 'review-evidence', r.id) : '—') + '</td></tr>')) : noData('暂无外部对账资料', '即使尚未导入外部流水，已关联业务订单仍可正常生成账单。')) + '</section>';
  }
  function evidenceForm(admin) {
    if (state.filters.biz_type === 'booking' || state.filters.payment_mode === 'offline') throw new Error('预订订单请通过收款方对账单核对。');
    const parties = state.identity.parties || [];
    modal(admin ? '导入外部对账凭证' : '补充外部对账资料', '<p class="notice">资料提交后等待财务复核；未知金额可留空，不能填零代替。</p><div class="form-grid">' + field('结算主体', select('party_id', parties.map(p => [p.id, p.name]), state.filters.party_id, 'required')) + field('资料类型', select('event_kind', [['PAYMENT', '外部收款'], ['REFUND', '外部退款'], ['FULFILLMENT', '履约确认'], ['CHANNEL_SETTLEMENT', '渠道结付'], ['COMMISSION_RECEIPT', '佣金到账']])) + field('外部渠道', input('channel', '', 'required maxlength="80" placeholder="如：商家小程序"')) + field('渠道环境', select('environment', [['production', '正式交易'], ['sandbox', '测试交易']])) + field('外部商户账号', input('merchant_account', '', 'required maxlength="160"')) + field('外部交易 / 事件编号', input('transaction_id', '', 'required maxlength="160"')) + field('关联原事件编号', input('original_event_id', '', 'maxlength="100"'), '退款或结付时填写对应原收款事件。') + field('业务关联编号（选填）', input('context_id', '', 'maxlength="100"')) + field('金额（元，未知可留空）', input('amount', '', 'inputmode="decimal"')) + field('事件发生时间', input('occurred_at', '', 'type="datetime-local"')) + field('凭证编号 / 已上传文件引用', input('evidence_ref', '', 'required maxlength="1000"'), '填写能由复核人独立查证的凭证位置。', true) + '</div>', '提交资料', async (data, d, submit) => { const p = Object.fromEntries(data); delete p.amount; p.amount_minor = data.get('amount').trim() === '' ? null : minor(data.get('amount')); p.currency = 'CNY'; p.source_type = admin ? 'PROVIDER_STATEMENT' : 'MERCHANT_REPORT'; if (p.occurred_at) p.occurred_at = new Date(p.occurred_at).toISOString(); else delete p.occurred_at; for (const k of ['original_event_id', 'context_id']) if (!p[k]) delete p[k]; await submit(admin ? '/admin/external-evidence' : '/me/external-evidence-submissions', p); toast('资料已提交，等待独立复核'); await load(); });
  }
  function parseCSV(text) {
    const rows = []; let row = [], value = '', quoted = false;
    for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; } else if (c === ',' && !quoted) { row.push(value); value = ''; } else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(value); if (row.some(v => v.trim())) rows.push(row); row = []; value = ''; } else value += c; }
    if (quoted) throw new Error('CSV 引号不完整，请检查文件。'); row.push(value); if (row.some(v => v.trim())) rows.push(row); return rows;
  }
  function importCSV() {
    if (state.filters.biz_type === 'booking' || state.filters.payment_mode === 'offline') throw new Error('预订订单请通过收款方对账单核对。');
    let imported = []; const completed = new Set();
    const d = modal('批量导入外部对账凭证', '<p class="subtle">UTF-8 编码 CSV，最多 200 行。逐条校验后导入，全部资料均需独立复核。</p><div class="file-box">' + field('选择 CSV 文件', '<input type="file" name="csv" accept=".csv,text/csv" required>') + '</div><p class="subtle break">列名：party_id,channel,environment,merchant_account,event_kind,transaction_id,amount_minor,currency,occurred_at,evidence_ref。金额以分填写，未知留空。</p><div id="csv-preview"></div>', '导入预览中的资料', async (data, dialog, submit) => { if (!imported.length) throw new Error('请先选择有效的 CSV 文件。'); let count = 0; for (let i = 0; i < imported.length; i++) { if (completed.has(i)) continue; try { await submit('/admin/external-evidence', imported[i]); completed.add(i); count++; $('#csv-preview', dialog).textContent = '已导入 ' + completed.size + ' / ' + imported.length + ' 条'; } catch (e) { throw new Error('第 ' + (i + 2) + ' 行未完成：' + e.message + ' 已完成行不会重复导入。'); } } toast('导入完成，共 ' + completed.size + ' 条待复核资料'); await load(); });
    $('[name=csv]', d).addEventListener('change', async e => { imported = []; completed.clear(); $('.form-error', d).textContent = ''; try { const file = e.target.files[0]; if (!file) return; if (file.size > 1024 * 1024) throw new Error('CSV 文件不能超过 1 MB。'); const csv = parseCSV((await file.text()).replace(/^\uFEFF/, '')); if (csv.length < 2 || csv.length > 201) throw new Error('请提供 1 至 200 行资料。'); const headings = csv.shift().map(s => s.trim()); const required = ['party_id', 'channel', 'environment', 'merchant_account', 'event_kind', 'transaction_id', 'amount_minor', 'currency', 'evidence_ref']; if (required.some(k => !headings.includes(k))) throw new Error('CSV 缺少必需列，请按页面列名整理文件。'); const allowed = new Set((state.identity.parties || []).map(p => String(p.id))); imported = csv.map((row, i) => { const p = {}; headings.forEach((k, j) => { if (required.includes(k) || ['occurred_at', 'context_id', 'original_event_id', 'source_event_id'].includes(k)) p[k] = (row[j] || '').trim(); }); if (!allowed.has(p.party_id)) throw new Error('第 ' + (i + 2) + ' 行主体不在您的授权范围内。'); if (p.amount_minor && !/^\d+$/.test(p.amount_minor)) throw new Error('第 ' + (i + 2) + ' 行金额必须为非负整数分。'); p.amount_minor = p.amount_minor || null; p.source_type = 'PROVIDER_STATEMENT'; return p; }); $('#csv-preview', d).innerHTML = '<div class="preview"><h3>待导入 ' + imported.length + ' 条</h3>' + table(['主体', '类型', '金额'], imported.slice(0, 5).map(p => '<tr><td>' + esc(partyName(p.party_id)) + '</td><td>' + esc(label(p.event_kind)) + '</td><td>' + esc(money(p.amount_minor)) + '</td></tr>')) + '<p class="subtle">仅预览前 5 条。提交后进入待复核状态。</p></div>'; } catch (error) { $('.form-error', d).textContent = error.message; $('#csv-preview', d).textContent = ''; } });
  }
  function reviewEvidence(id) {
    const row = state.rows.find(r => String(r.id) === String(id));
    const evidence = (row.evidence || []).find(e => /^(PENDING|UNVERIFIED|CONFLICT)$/i.test(e.review_status || 'PENDING')) || row;
    const evidenceId = evidence.id;
    modal('复核外部对账资料', '<div class="detail-grid">' + detail('结算主体', partyName(row.party_id)) + detail('事件类型', label(row.event_kind)) + detail('金额', money(row.amount_minor)) + detail('外部交易', row.transaction_id || row.source_event_id) + detail('凭证引用', evidence.evidence_ref || row.evidence_ref) + detail('事件时间', date(row.occurred_at)) + '</div><div class="form-grid">' + field('复核结果', select('decision', [['verify', '核验通过'], ['reject', '驳回资料']])) + field('复核说明', '<textarea name="note" required maxlength="1000"></textarea>') + '</div>', '提交复核', async (data, d, submit) => { await submit('/admin/external-evidence/' + encodeURIComponent(evidenceId) + '/reviews', { decision: data.get('decision'), note: data.get('note').trim() }); toast('复核结果已记录'); await load(); });
  }
  async function loadOwnFunds(version) {
    const kind = state.ownKind || 'sources';
    const path = { sources:'/admin/own-fund-sources', compensations:'/admin/compensations', recoveries:'/admin/compensation-recoveries' }[kind];
    const result = await api(path); if (version !== state.loadVersion) return; state.rows = rowsOf(result);
    const tabs = [['sources','独立补差资金'],['compensations','客户赔付'],['recoveries','商户追偿']].map(([k,t]) => button(t,'own-funds-kind',k,k===kind)).join('');
    const create = can('settlement.fund.write') && kind !== 'recoveries' ? button(kind==='sources'?'登记自有资金':'申请客户赔付',kind==='sources'?'new-own-source':'new-compensation',null,true) : '';
    const rows = state.rows.map(r => '<tr><td class="break">' + esc(r.case_ref || r.provider_reference || r.compensation_id) + '<small>' + esc(label(r.biz_type)) + ' · ' + esc(partyName(r.party_id)) + '</small></td><td>' + esc(money(r.amount_minor)) + '</td><td>' + (kind==='recoveries' ? esc(money(r.activated_minor)) : badge(r.status)) + '</td><td>' + (kind==='recoveries' ? esc(partyName(r.debtor_party_id)) : esc(date(r.created_at))) + '</td><td>' + (kind==='recoveries' ? badge(r.status) : button('查看 / 复核',kind==='sources'?'review-own-source':'review-compensation',r.id)) + '</td></tr>');
    content.innerHTML = tabsHTML() + '<section class="panel"><div class="panel-head"><div><h2>补差与赔付</h2><p>独立资金入账、赔付审批、机构付款分别记录；实际付款后才形成可追偿金额。</p></div>' + create + '</div><div class="actions">' + tabs + '</div><hr class="section-divider">' + (rows.length ? table(kind==='recoveries'?['赔付事项','核定上限','已形成应收','追偿商户','进度']:['业务事项','金额','审核状态','申请时间','操作'],rows) : noData('暂无相关记录')) + '</section>';
  }
  async function ownFormData() {
    const [itemResult,accountResult,sourceResult] = await Promise.all([api('/admin/items'),api('/admin/accounts'),api('/admin/own-fund-sources')]);
    const items = rowsOf(itemResult), accounts = rowsOf(accountResult).filter(a => /^approved$/i.test(a.status));
    const contexts = [...new Map(items.filter(i => i.context_id && i.payment_mode==='pay_center').map(i => [i.context_id,[i.context_id,label(i.biz_type)+' · '+(i.biz_order_no || i.order_id || i.context_id)]])).values()];
    return {items,accounts,contexts,sources:rowsOf(sourceResult).filter(s=>s.status==='APPROVED')};
  }
  async function ownSourceForm() {
    const {contexts,accounts} = await ownFormData();
    const own = accounts.filter(a => decode(a.capabilities).own_funds_verified===true);
    modal('登记独立自有资金', '<p class="notice">仅登记已核验的独立入账凭证。顾客原支付与分账佣金不能重复登记为补差资金，提交后需另一位财务复核。</p><div class="form-grid">' + field('关联业务订单',select('context_id',[['','请选择'],...contexts],'','required')) + field('自有资金账户',select('account_id',[['','请选择已核验账户'],...own.map(a=>[a.id,partyName(a.party_id)+' · 尾号 '+String(a.merchant_no).slice(-6)])],'','required')) + field('入账金额（元）',input('amount','','required inputmode="decimal"')) + field('机构入账流水号',input('provider_reference','','required maxlength="128"')) + field('入账核验凭证',input('evidence_ref','','required maxlength="500"'),'',true) + '</div>','提交入账复核',async(data,d,submit)=>{await submit('/admin/own-fund-sources',{context_id:data.get('context_id'),account_id:data.get('account_id'),amount_minor:minor(data.get('amount')),provider_reference:data.get('provider_reference').trim(),evidence_ref:data.get('evidence_ref').trim(),source_type:'supplement'});toast('入账资料已提交，审核通过后可用于付款');await load();});
  }
  async function compensationForm() {
    const {contexts,accounts,items,sources} = await ownFormData();
    const d = modal('申请真实客户赔付','<p class="notice">赔付使用独立自有资金。审批通过后创建客户应付，实际到账由后续机构付款结果确认。</p><div class="form-grid">' + field('原业务订单',select('context_id',[['','请选择'],...contexts],'','required')) + field('已确认履约单位',select('original_unit_id',[['','先选择业务订单']],'','required')) + field('赔付资金来源',select('source_id',[['','先选择业务订单']],'','required')) + field('客户收款账户',select('account_id',[['','请选择原客户已批准账户'],...accounts.map(a=>[a.id,partyName(a.party_id)+' · 尾号 '+String(a.merchant_no).slice(-6)])],'','required')) + field('赔付金额（元）',input('amount','','required inputmode="decimal"')) + field('售后赔付事项编号',input('case_ref','','required maxlength="128"')) + field('处理凭证',input('evidence_ref','','required maxlength="500"')) + field('赔付原因','<textarea name="reason" required maxlength="1000"></textarea>') + '</div>','提交赔付申请',async(data,dialog,submit)=>{const p=Object.fromEntries(data);delete p.amount;p.amount_minor=minor(data.get('amount'));await submit('/admin/compensations',p);toast('赔付申请已提交，等待独立复核'+soloNote());await load();});
    $('[name=context_id]',d).addEventListener('change',e=>{
      const units=[...new Map(items.filter(i=>i.context_id===e.target.value&&i.unit_id&&i.line_kind==='merchant').map(i=>[i.unit_id,[i.unit_id,'已确认服务 · 应结 '+money(i.original_payable_minor ?? i.payable_minor)]])).values()];
      $('[name=original_unit_id]',d).innerHTML=options([['','请选择履约单位'],...units]);
      $('[name=source_id]',d).innerHTML=options([['','请选择已核验独立资金'],...sources.filter(s=>s.context_id===e.target.value).map(s=>[s.source_id,'入账 '+money(s.amount_minor)+' · 流水 '+s.provider_reference])]);
    });
  }
  function reviewOwnRecord(id,compensation) {
    const r=state.rows.find(x=>String(x.id)===String(id));
    const html='<div class="detail-grid">'+detail('审核状态',label(r.status))+detail('金额',money(r.amount_minor))+detail('关联业务',r.context_id)+detail('申请人',r.created_by)+detail(compensation?'售后事项':'机构流水',compensation?r.case_ref:r.provider_reference)+detail('原始凭证',r.evidence_ref)+(compensation?detail('赔付原因',r.reason)+detail('客户收款主体',partyName(r.beneficiary_party_id))+detail('后续应付记录',r.item_id||'审批后生成'):'')+'</div>'+field('独立复核意见','<textarea name="note" required maxlength="1000"></textarea>');
    modal(compensation?'客户赔付复核':'自有资金入账复核',html,compensation?'批准赔付，进入付款流程':'确认独立入账',can('settlement.fund.review')&&r.status==='DRAFT'?async(data,d,submit)=>{await submit((compensation?'/admin/compensations/':'/admin/own-fund-sources/')+encodeURIComponent(id)+'/approve',{note:data.get('note').trim()});toast(compensation?'赔付已批准，等待付款授权与机构执行':'独立资金已核验，可用于后续付款');await load();}:null);
  }
  const configTitles = { accounts: '机构收款账户', bindings: '业务主体绑定', profiles: '商户结算协议' };
  const decode = value => typeof value === 'string' ? JSON.parse(value) : value || {};
  const operationNames = { SPLIT:'分账划转', RETURN:'分账回退', PAYOUT:'佣金付款', RELEASE:'商户原款释放' };
  async function loadConfiguration(version) {
    const kind = state.configKind || 'accounts';
    const r = await api('/admin/configuration/' + kind + qs(state.filters));
    if (version !== state.loadVersion) return;
    state.rows = rowsOf(r);
    const tabs = '<div class="actions">' + Object.entries(configTitles).map(([k, t]) => button(t, 'config-kind', k, k === kind)).join('') + '</div>';
    content.innerHTML = tabsHTML() + '<section class="panel"><div class="panel-head"><div><h2>账户与协议准入</h2><p>资料保存为草稿，由另一位授权人员复核后生效。' + soloNote() + '</p></div>' + (can('settlement.policy.write') ? button('新增' + configTitles[kind], 'new-configuration', kind, true) : '') + '</div>' + tabs + '<hr class="section-divider">' + (state.rows.length ? table(['结算主体', '配置摘要', '状态', '创建时间', '操作'], state.rows.map(row => '<tr><td>' + esc(partyName(row.party_id)) + '</td><td class="break">' + esc(kind === 'accounts' ? row.provider + ' · ' + row.environment + ' · 尾号 ' + String(row.merchant_no).slice(-6) : kind === 'bindings' ? label(row.source_domain) + ' · 业务编号 ' + row.source_entity_id : label(row.biz_type) + ' · ' + label(row.payment_mode) + ' · v' + row.version) + '</td><td>' + badge(row.status) + '</td><td>' + esc(date(row.created_at)) + '</td><td>' + button('查看 / 复核', 'review-configuration', row.id) + '</td></tr>')) : noData('尚无' + configTitles[kind])) + '</section>';
  }
  function partyField() {
    const parties = state.identity.parties || [];
    const lookup = '<small class="lookup-links"><button type="button" class="link" data-action="lookup-party">查询已有主体 →</button></small>';
    if (state.identity.can_manage_parties === true) return '<label class="field"><span>法律主体标识</span>' + input('party_id', state.filters.party_id || '', 'required maxlength="64" pattern="[A-Za-z0-9_.:-]{1,64}" list="settlement-party-list"') + '<datalist id="settlement-party-list">' + parties.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('') + '</datalist><small>推荐结构 法人:业务类型:业务编号（如 bianxi:jiazheng:151），由表单信息自动拼装，可手动覆盖；复用已有主体则填已有代号。业务绑定复核后生效。</small>' + lookup + '</label>';
    return '<label class="field"><span>结算主体</span>' + select('party_id', parties.map(p => [p.id, p.name]), state.filters.party_id, 'required') + lookup + '</label>';
  }
  // 主体/业务编号查询：数据来自结算域自己的绑定与账户接口，点击行回填来源表单。
  async function partyLookupDialog(source, kind) {
    const partyMode = kind !== 'entity';
    const d = modal(partyMode ? '查询已有结算主体' : '查询已绑定业务编号', '<div id="party-lookup-body"><p class="subtle">正在读取主体目录…</p></div>');
    const fillField = (name, value) => { if (!source || !source.isConnected) return; const target = source.querySelector('[name=' + name + ']'); if (!target || !target.isConnected) return;
      if (target.tagName === 'SELECT') { let option = [...target.options].find(o => o.value === value); if (!option) { option = document.createElement('option'); option.value = value; option.textContent = value; target.append(option); } target.value = value; }
      else target.value = value; };
    try {
      const [bindingResult, accountResult] = await Promise.all([api('/admin/configuration/bindings'), api('/admin/accounts')]);
      const bindings = rowsOf(bindingResult), accounts = rowsOf(accountResult), body = $('#party-lookup-body', d);
      if (partyMode) {
        const byParty = new Map(), accountCount = new Map();
        for (const b of bindings) { const list = byParty.get(b.party_id) || []; list.push(b); byParty.set(b.party_id, list); }
        for (const a of accounts) accountCount.set(a.party_id, (accountCount.get(a.party_id) || 0) + 1);
        const ids = [...new Set([...byParty.keys(), ...accounts.map(a => a.party_id)])].sort();
        body.innerHTML = '<p class="subtle">点击行回填主体标识。</p>' + (ids.length ? table(['法律主体标识', '业务绑定', '已批准账户', '状态'], ids.map(id => { const list = byParty.get(id) || [], approved = list.some(b => /^approved$/i.test(b.status));
          return '<tr data-fill="' + esc(id) + '" style="cursor:pointer"><td><strong>' + esc(id) + '</strong></td><td class="break">' + esc(list.length ? list.map(b => label(b.source_domain) + ' · ' + (b.source_entity_id || '—') + (/^approved$/i.test(b.status) ? '' : '（待复核）')).join('；') : '尚未绑定') + '</td><td>' + (accountCount.get(id) || 0) + '</td><td>' + (approved ? '已批准' : list.length ? '待复核' : '—') + '</td></tr>'; })) : '<p class="subtle">主体目录为空：还没有任何主体绑定或收款账户。</p>');
      } else {
        const rows = bindings.slice().sort((a, b) => (/^approved$/i.test(b.status) ? 1 : 0) - (/^approved$/i.test(a.status) ? 1 : 0));
        body.innerHTML = '<div class="form-grid"><label class="field"><span>商家目录搜索</span>' + input('vendor-query', '', 'maxlength="64" placeholder="按商家编号或名称搜索，如 151 / 蓝犀牛"') + '<small class="lookup-links"><button type="button" class="link" data-action="search-vendor">搜索商家 →</button>（按编号或名称，找到后点击行回填编号）</small></label></div><div id="vendor-search-results"></div>' + '<p class="subtle">已绑定的业务编号（点击行回填；主体字段为空时一并回填）：</p>' + (rows.length ? table(['业务来源', '业务主体编号', '法律主体', '状态'], rows.map(b => '<tr data-fill="' + esc(b.source_entity_id || '') + '" data-party="' + esc(b.party_id || '') + '" style="cursor:pointer"><td>' + esc(label(b.source_domain)) + '</td><td><strong>' + esc(b.source_entity_id || '—') + '</strong></td><td>' + esc(b.party_id || '—') + '</td><td>' + badge(b.status) + '</td></tr>')) : '<p class="subtle">尚无业务主体绑定，请用上方搜索找到商家。</p>');
        const results = $('#vendor-search-results', body), queryInput = $('[name=vendor-query]', body);
        const doSearch = async () => {
          const q = queryInput.value.trim(); if (!q) return;
          results.innerHTML = '<p class="subtle">正在搜索商家…</p>';
          try {
            const found = rowsOf(await api('/admin/vendor-directory' + qs({ query: q })));
            results.innerHTML = found.length ? table(['商家编号', '名称', '类型', '状态'], found.map(v => '<tr data-fill="' + esc(String(v.id)) + '" style="cursor:pointer"><td><strong>' + esc(String(v.id)) + '</strong></td><td>' + esc(v.name || '—') + '</td><td>' + esc(v.type || '—') + '</td><td>' + badge(v.review_status || v.status || 'PENDING') + '</td></tr>')) : '<p class="subtle">没有匹配的商家，可改用编号或名称关键词。</p>';
            results.querySelectorAll('tr[data-fill]').forEach(tr => tr.addEventListener('click', () => { fillField('source_entity_id', tr.dataset.fill);
             const partyInput = source.querySelector('[name=party_id]');
             if (partyInput && !partyInput.value && /^[\w-]+$/.test(tr.dataset.fill)) {
               const legal = (source.querySelector('[name=legal_code]')?.value || '').trim(), domain = source.querySelector('[name=source_domain]')?.value;
               if (domain) fillField('party_id', (/^[A-Za-z0-9_-]{1,24}$/.test(legal) ? legal + ':' : '') + domain + ':' + tr.dataset.fill);
             }
             d.close(); }));
          } catch (e) { results.innerHTML = '<p class="notice">' + esc(e.message) + '</p>'; }
        };
        $('[data-action=search-vendor]', body).addEventListener('click', doSearch);
        queryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
      }
      body.querySelectorAll('tr[data-fill]').forEach(tr => tr.addEventListener('click', () => { const value = tr.dataset.fill; if (!value) return;
        if (partyMode) fillField('party_id', value);
        else { fillField('source_entity_id', value); const partyInput = source.querySelector('[name=party_id]'); if (tr.dataset.party && partyInput && !partyInput.value) fillField('party_id', tr.dataset.party); }
        d.close(); }));
    } catch (e) { const body = $('#party-lookup-body', d); if (body) body.innerHTML = '<p class="notice">' + esc(e.message) + '</p>'; }
  }
  async function newConfiguration(kind) {
    let fields = partyField(), profileAccounts = [];
    if (kind === 'bindings') fields += field('业务来源', select('source_domain', [['commerce','生活权益商户'],['jiazheng','生活服务商户'],['booking','预订商户（民宿/长租）'],['identity','推广账号'],['platform','平台法律主体']])) + field('法人代号', input('legal_code', '', 'maxlength="24" pattern="[A-Za-z0-9_-]{1,24}" placeholder="如 bianxi"'), '法人/集团缩写代号，同一法人所有业务共用；与业务来源、业务编号共同拼出法律主体标识。') + '<label class="field"><span>业务主体编号</span>' + input('source_entity_id', '', 'required maxlength="64"') + '<small>业务系统里的真实编号，如搬家商家 151、服务商 18；不能用另一业务的同号主体代替。</small><small class="lookup-links"><button type="button" class="link" data-action="lookup-entity">搜索商家 / 查询已绑定 →</button> · <a href="p-vendor-rates.html" target="_blank" rel="noopener">商家档案（费率台）↗</a>（需商家费率权限）</small></label>';
    if (kind === 'accounts') fields += field('支付机构', input('provider', '', 'required maxlength="32"')) + field('环境', select('environment', [['production','正式环境'],['sandbox','测试环境']])) + field('机构商户号', input('merchant_no', '', 'required maxlength="128"')) + field('机构资金合同号', input('contract_no', '', 'required maxlength="128"')) + field('币种', select('currency', [['CNY','人民币']])) + field('已核验能力', '<div class="actions"><label class="check-label"><input type="checkbox" name="receive">收款</label>' + Object.entries(operationNames).map(([k,t]) => '<label class="check-label"><input type="checkbox" name="operation" value="' + k + '">' + t + '</label>').join('') + '</div>', '仅勾选已由机构材料验证的能力，机构未开通的操作无法执行。', true) + field('独立自有资金能力', '<label class="check-label"><input type="checkbox" name="own_funds_verified">已核验独立自有资金，非顾客原支付或佣金专款</label>', '', true) + field('独立自有资金核验凭证', input('own_funds_evidence_ref', '', 'maxlength="500"')) + field('机构核验材料', input('evidence_ref', '', 'required maxlength="500"'), '填写合同、联调验收记录等可独立核验的材料引用。', true);
    if (kind === 'profiles') {
      const accounts = rowsOf(await api('/admin/accounts')).filter(a => /^approved$/i.test(a.status));
      profileAccounts = accounts;
      const accountOptions = [['','请选择已批准账户'], ...accounts.map(a => [a.id, partyName(a.party_id) + ' · ' + a.provider + ' · 尾号 ' + String(a.merchant_no).slice(-6)])];
      fields += field('业务', select('biz_type', [['jiazheng','生活服务'],['commerce','生活权益'],['booking','预订（民宿/长租）']])) + field('支付渠道', select('payment_mode', [['pay_center','站内收银台'],['wechat_mini','外部小程序'],['offline','线下支付（仅对账）']])) + field('业务合同 / 协议编号', input('contract_ref', '', 'required maxlength="191"'), '本协议是资金域合同快照；平台抽佣比例在「商家费率台」（p-vendor-rates）另配。') + field('结算计算方式', select('calculation_mode', [['PROPORTIONAL','按比例佣金'],['FIXED_COST','固定服务成本与独立佣金']])) + field('佣金比例（%）', input('commission_percent', '', 'inputmode="decimal" placeholder="以合同为准"')) + field('推广分成占佣金比例（%）', input('channel_percent', '0', 'inputmode="decimal"')) + field('固定服务成本（元）', input('fixed_cost', '', 'inputmode="decimal"')) + field('合同明确的平台佣金（元）', input('fixed_commission', '', 'inputmode="decimal"')) + field('舍入约定', select('rounding', [['','请选择合同约定'],['FLOOR_BPS_V1','不足一分舍去'],['HALF_UP_BPS_V1','四舍五入到分']], '', 'required')) + field('履约确认方式', select('recognition_mode', [['CUSTOMER_ACCEPTANCE','客户验收确认'],['COUPON_REDEMPTION','权益有效核销'],['BOOKING_CHECKOUT_DELAY','离店后 N 天（在结算规则配置）']])) + field('履约后结算等待（小时）', input('settlement_delay_hours', '0', 'type="number" min="0" step="1" required')) + field('原款存放方式', select('funding_mode', [['MERCHANT_CONTROLLED_RECEIPT','商户账户原款受控，结算时释放'],['CONTROLLED_COLLECTION','平台受控收款后分配'],['MERCHANT_ALREADY_SETTLED','商户已结清，仅核验应计']])) + field('原款账户', select('source_account_id', accountOptions)) + field('商户收款账户', select('merchant_account_id', accountOptions)) + field('平台佣金账户', select('platform_account_id', accountOptions)) + field('机构资金合同号', input('contract_no', '', 'maxlength="128"')) + field('支付收款契约版本', input('collection_mapping_version', '', 'maxlength="128"')) + field('分账机构契约版本', input('contract_mapping_version', '', 'maxlength="128"')) + field('原款控制核验证据', input('funding_evidence_ref', '', 'maxlength="500"')) + field('机构资金有效期限', input('expires_at', '', 'type="datetime-local"')) + field('佣金划转会同时释放商户原款', '<label class="check-label"><input type="checkbox" name="implicit_merchant_release">机构已确认该联动行为</label>', '勾选后，两部分必须同时获得授权并满足付款时间。', true);
    }
    const d = modal('新增' + configTitles[kind], '<div class="form-grid">' + fields + '</div>', '保存待复核资料', async (data, dialog, submit) => {
      let p = { party_id: data.get('party_id') };
      if (kind === 'bindings') { p.source_domain = data.get('source_domain'); p.source_entity_type = { commerce:'merchant', jiazheng:'vendor', booking:'vendor', identity:'account', platform:'entity' }[p.source_domain]; p.source_entity_id = data.get('source_entity_id').trim(); }
      if (kind === 'accounts') { ['provider','environment','merchant_no','contract_no','currency'].forEach(k => p[k] = data.get(k).trim()); p.capabilities = { evidence_ref:data.get('evidence_ref').trim(), receive:data.has('receive'), operations:data.getAll('operation'), own_funds_verified:data.has('own_funds_verified') }; if (p.capabilities.own_funds_verified) { if (!data.get('own_funds_evidence_ref').trim()) throw new Error('请填写独立自有资金的核验证据。'); p.capabilities.own_funds_evidence_ref = data.get('own_funds_evidence_ref').trim(); } }
      if (kind === 'profiles') {
        p.biz_type = data.get('biz_type'); p.payment_mode = data.get('payment_mode');
        if (p.payment_mode === 'offline' && p.biz_type !== 'booking') throw new Error('线下支付对账当前仅适用于预订（民宿/长租）。');
        if (p.biz_type === 'booking' && p.payment_mode === 'wechat_mini') throw new Error('预订（民宿/长租）请选择站内收银台或线下支付对账。');
        if (p.biz_type === 'booking' && data.get('recognition_mode') !== 'BOOKING_CHECKOUT_DELAY') throw new Error('预订（民宿/长租）按订单离店日期和结算规则中的等待天数确认履约。');
        const calculation = { mode:data.get('calculation_mode'), rounding:data.get('rounding'), contract_ref:data.get('contract_ref').trim() };
        const bps = v => { const n = BigInt(minor(v)); if (n > 10000n) throw new Error('比例应在 0% 至 100% 之间。'); return Number(n); };
        calculation.channel_bps = bps(data.get('channel_percent'));
        if (calculation.mode === 'PROPORTIONAL') calculation.commission_bps = bps(data.get('commission_percent'));
        else { calculation.fixed_cost_minor = minor(data.get('fixed_cost')); calculation.fixed_commission_minor = minor(data.get('fixed_commission')); }
        p.snapshot = { contract_ref:calculation.contract_ref, calculation, recognition_policy:{ mode:data.get('recognition_mode') }, settlement_delay_hours:p.biz_type === 'booking' ? 0 : Number(data.get('settlement_delay_hours')) };
        if (p.payment_mode === 'pay_center') { ['source_account_id','merchant_account_id','platform_account_id','contract_mapping_version','funding_evidence_ref','funding_mode','contract_no'].forEach(k => { const value = data.get(k).trim(); if (!value) throw new Error('站内结算需补齐账户、机构合同及资金核验材料。'); p.snapshot[k] = value; }); const sourceAccount = profileAccounts.find(a => String(a.id) === String(p.snapshot.source_account_id)); if (!sourceAccount || !data.get('collection_mapping_version').trim()) throw new Error('请填写支付收款契约版本并选择已批准的原款账户。'); if (p.snapshot.contract_no !== sourceAccount.contract_no) throw new Error('资金合同号必须与所选原款账户一致。'); p.snapshot.collection = { mapping_version:data.get('collection_mapping_version').trim(), contract_no:sourceAccount.contract_no, source_merchant_no:sourceAccount.merchant_no, provider:sourceAccount.provider, environment:sourceAccount.environment }; p.snapshot.implicit_merchant_release = data.has('implicit_merchant_release'); if (data.get('expires_at')) p.snapshot.expires_at = new Date(data.get('expires_at')).toISOString(); }
      }
      await submit('/admin/configuration/' + kind, p); toast('资料已保存，等待独立复核'+soloNote()); await load();
    });
    if (kind === 'bindings') {
      const suggestParty = () => { const party = $('[name=party_id]', d), code = $('[name=legal_code]', d), domain = $('[name=source_domain]', d), entity = $('[name=source_entity_id]', d);
        if (!party || party.value || !code || !domain || !entity) return;
        const legal = code.value.trim(), id = entity.value.trim();
        if (!domain.value || !/^[\w-]+$/.test(id)) return;
        party.value = (/^[A-Za-z0-9_-]{1,24}$/.test(legal) ? legal + ':' : '') + domain.value + ':' + id; };
      $('[name=legal_code]', d).addEventListener('input', suggestParty);
      $('[name=source_domain]', d).addEventListener('change', suggestParty);
      $('[name=source_entity_id]', d).addEventListener('input', suggestParty);
    }
    if (kind === 'profiles') {
      const syncProfile = () => {
        const booking = $('[name=biz_type]', d).value === 'booking';
        $('[name=recognition_mode]', d).value = booking ? 'BOOKING_CHECKOUT_DELAY' : $('[name=biz_type]', d).value === 'commerce' ? 'COUPON_REDEMPTION' : 'CUSTOMER_ACCEPTANCE';
        for (const option of $('[name=recognition_mode]', d).options) option.disabled = booking ? option.value !== 'BOOKING_CHECKOUT_DELAY' : option.value === 'BOOKING_CHECKOUT_DELAY';
        const delay = $('[name=settlement_delay_hours]', d); delay.closest('.field').hidden = booking; delay.required = !booking;
        const offline = $('[name=payment_mode] option[value=offline]', d); offline.disabled = !booking;
        $('[name=payment_mode] option[value=wechat_mini]', d).disabled = booking;
        if (booking && $('[name=payment_mode]', d).value === 'wechat_mini') $('[name=payment_mode]', d).value = 'pay_center';
        if (!booking && $('[name=payment_mode]', d).value === 'offline') $('[name=payment_mode]', d).value = 'pay_center';
      };
      $('[name=biz_type]', d).addEventListener('change', syncProfile); syncProfile();
    }
  }
  function reviewConfiguration(id) {
    const row = state.rows.find(r => String(r.id) === String(id)); const kind = state.configKind || 'accounts'; const s = decode(row.snapshot); const a = decode(row.capabilities); const c = s.calculation || {};
    let details = detail('结算主体', partyName(row.party_id)) + detail('状态', label(row.status)) + detail('申请人账号', row.created_by);
    if (kind === 'bindings') details += detail('来源业务', label(row.source_domain)) + detail('业务主体编号', row.source_entity_id);
    if (kind === 'accounts') details += detail('支付机构 / 环境', row.provider + ' / ' + row.environment) + detail('机构商户号', row.merchant_no) + detail('机构资金合同', row.contract_no) + detail('已核验能力', (a.receive ? ['收款'] : []).concat((a.operations || []).map(k => operationNames[k] || k)).join('、')) + detail('核验材料', a.evidence_ref) + detail('独立自有资金能力', a.own_funds_verified ? '已核验' : '未开通') + detail('独立资金凭证', a.own_funds_evidence_ref);
    if (kind === 'profiles') details += detail('业务 / 渠道', label(row.biz_type) + ' / ' + label(row.payment_mode)) + detail('合同编号', s.contract_ref) + detail('佣金计算', c.mode === 'FIXED_COST' ? '固定成本 ' + money(c.fixed_cost_minor) + ' / 佣金 ' + money(c.fixed_commission_minor) : yuan(c.commission_bps) + '%') + detail('推广佣金比例', yuan(c.channel_bps || 0) + '%') + detail('舍入规则', c.rounding === 'FLOOR_BPS_V1' ? '不足一分舍去' : '四舍五入到分') + detail('履约确认', label(s.recognition_policy?.mode)) + detail('等待时间', row.biz_type === 'booking' ? '按结算规则配置的离店等待天数' : (s.settlement_delay_hours || 0) + ' 小时') + detail('支付收款契约版本', s.collection?.mapping_version) + detail('收款机构 / 环境', (s.collection?.provider || '—') + ' / ' + (s.collection?.environment || '—')) + detail('分账机构契约版本', s.contract_mapping_version) + detail('机构资金合同', s.contract_no) + detail('原款账户', s.source_account_id) + detail('商户账户', s.merchant_account_id) + detail('平台佣金账户', s.platform_account_id) + detail('资金核验证据', s.funding_evidence_ref) + detail('原款联动释放', s.implicit_merchant_release ? '是，需同时授权' : '否') + detail('资金有效期', date(s.expires_at));
    modal(configTitles[kind] + '复核', '<div class="detail-grid">' + details + '</div>', '批准生效', can('settlement.policy.review') && row.status === 'draft' ? async (data, d, submit) => { await submit('/admin/configuration/' + kind + '/' + encodeURIComponent(id) + '/approve', {}); toast('配置已批准'); await load(); } : null);
  }
  function confirmAction(title, text, path, payload) { modal(title, '<p>' + esc(text) + '</p>', '确认提交', async (data, d, submit) => { await submit(path, payload); toast('操作已提交，请查看最新状态'); await load(); }); }
  document.addEventListener('submit', e => { if (e.target.id !== 'settlement-filter') return; e.preventDefault(); state.filters = Object.fromEntries(new FormData(e.target)); state.page = 1; load(); });
  window.addEventListener('hashchange', () => { const m = /^[#]*tab=([\w-]+)$/.exec(location.hash || ''); if (isAdmin && m && m[1] !== state.tab) { state.tab = m[1]; state.page = 1; load(); } });
  document.addEventListener('change', e => { if (e.target.name === 'mode' && e.target.closest('dialog')) syncNodeMode(e.target.closest('dialog')); });
  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-action]'); if (!b || b.disabled) return; const action = b.dataset.action, id = b.dataset.id; const original = b.textContent;
    b.disabled = true;
    try {
      if (action === 'login') { await window.BZF_CONSOLE.requireLogin('请登录新居住结算与对账中心'); await initialize(); }
      else if (action === 'logout') window.BZF_CONSOLE.logout();
      else if (action === 'initialize') await initialize();
      else if (action === 'refresh') await load();
      else if (action === 'tab') { state.tab = id; state.page = 1; await load(); }
      else if (action === 'prev' || action === 'next') { state.page += action === 'prev' ? -1 : 1; await load(); }
      else if (action === 'item') await showItem(id);
      else if (action === 'adjust') await adjustItem(id, b.closest('dialog'));
      else if (action === 'approval') await approval(id);
      else if (action === 'new-policy') newPolicy();
      else if (action === 'own-funds-kind') { state.ownKind = id; await load(); }
      else if (action === 'new-own-source') await ownSourceForm();
      else if (action === 'new-compensation') await compensationForm();
      else if (action === 'review-own-source') reviewOwnRecord(id, false);
      else if (action === 'review-compensation') reviewOwnRecord(id, true);
      else if (action === 'new-configuration') await newConfiguration(id);
      else if (action === 'lookup-party') partyLookupDialog(b.closest('dialog'), 'party');
      else if (action === 'lookup-entity') partyLookupDialog(b.closest('dialog'), 'entity');
      else if (action === 'review-configuration') reviewConfiguration(id);
      else if (action === 'config-kind') { state.configKind = id; await load(); }
      else if (action === 'add-node') appendNode(b.closest('dialog'));
      else if (action === 'remove-node') b.closest('.node-row').remove();
      else if (action === 'disable-policy') confirmAction('停用结算规则', '未发送明细重新匹配策略，已发送按原单查结果。停用后可发布替代规则。', '/admin/policies/' + encodeURIComponent(id) + '/disable', {});
      else if (action === 'publish-policy') confirmAction('发布结算规则', '请核对适用商户、金额范围与审批节点。发布后将用于后续结算授权。', '/admin/policies/' + encodeURIComponent(id) + '/publish', {});
      else if (action === 'statement') await showStatement(id);
      else if (action === 'generate-statement') generateStatement();
      else if (action.startsWith('export-')) await exportStatement(id, action.slice(7), b);
      else if (action === 'confirm-statement' || action === 'dispute-statement') statementResponse(id, action === 'dispute-statement');
      else if (action === 'submit-evidence' || action === 'import-evidence') evidenceForm(action === 'import-evidence');
      else if (action === 'import-csv') importCSV();
      else if (action === 'review-evidence') reviewEvidence(id);
      else if (action === 'authorize') { const item = b.closest('dialog')._item; confirmAction('申请结算授权', '系统将按当前有效规则判断自动结算、人工审批或暂停。', '/admin/items/' + encodeURIComponent(id) + '/authorize', { expected_revision: item.revision }); }
      else if (action === 'execute') { const item = b.closest('dialog')._item; confirmAction('创建执行计划', '系统将核验授权、可用资金、收款账户和付款时间。满足条件后进入机构执行队列。', '/admin/execution-plans', { item_ids: [id], expected_revisions: { [id]: item.revision } }); }
      else if (action === 'query-execution') { await api('/admin/execution-orders/' + encodeURIComponent(id) + '/query', {}); toast('查询已提交，请刷新详情查看机构结果'); }
    } catch (error) { const d = b.closest('dialog'); if (d) $('.form-error', d).textContent = error.message; else status(error.message, true); }
    finally { if (b.isConnected) { b.disabled = false; b.textContent = original; } }
  });
  initialize();
})();
