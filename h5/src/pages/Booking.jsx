import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  authMe,
  bookingContacts,
  bookingLookup,
  bookingPay,
  bookingPaymentQuery,
  createBooking,
  bookingCouponQuotes,
  project,
  projectUnits,
  saveBookingContact,
  stayCalendar,
  virtualPhone,
} from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { formatPrice, priceParts, unitNight } from '../lib/price.js';
import { mdWeek, nightCount, nightsBetween, rangeMonths, sumRange, mds, WK } from '../lib/stay.js';
import { featureEnabled } from '../lib/features.js';
import '../styles/booking.css';

const COVER_FALLBACK = '/assets/lvju/xijiang-night.jpg';
const TIMER_IC = '/assets/lvju/icons/booking-timer.png';
const CAIBEI = featureEnabled('caibei');

function asArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a : [];
    } catch {
      return [];
    }
  }
  return v ? [v] : [];
}

function BookingInner() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();

  const [p, setP] = useState(null);
  const [units, setUnits] = useState([]);
  const [me, setMe] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [err, setErr] = useState('');
  const [newPayAttempt, setNewPayAttempt] = useState(false);
  const [loading, setLoading] = useState(true);

  const [unitId, setUnitId] = useState(() => parseInt(sp.get('unit') || '', 10) || '');
  const [checkin, setCheckin] = useState(() => sp.get('checkin') || '');
  const [checkout, setCheckout] = useState(() => sp.get('checkout') || '');
  const [rooms, setRooms] = useState(1);
  const [tx, setTx] = useState(() => sp.get('transaction_mode') || '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [cSel, setCSel] = useState('acct');
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [nightMap, setNightMap] = useState({});
  const [showNights, setShowNights] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ok, setOk] = useState(null); // { order_no, pay_status, cancel_policy_text, cancel_deadline }
  const [paying, setPaying] = useState(false);
  const [noBook, setNoBook] = useState(false);
  const [couponQuotes, setCouponQuotes] = useState([]);
  const [couponId, setCouponId] = useState('');
  const [quotedFor, setQuotedFor] = useState('');
  const [couponStatus, setCouponStatus] = useState('idle');
  const [couponError, setCouponError] = useState('');
  const [couponRefresh, setCouponRefresh] = useState(0);
  const couponContext = [me?.id || '',id,unitId,checkin,checkout,unitId ? rooms : 1].join('|');
  const visibleQuotes = quotedFor === couponContext ? couponQuotes : [];
  const selectedCoupon = visibleQuotes.find((q) => q.coupon_id === couponId);

  const resumeOrderNo = (sp.get('order_no') || '').trim();

  useEffect(() => {
    let alive = true;
    authMe()
      .then((j) => {
        if (!alive) return;
        const acc = j && j.account;
        if (acc) {
          setMe({ id: acc.id, idp_type: acc.idp_type, phone: acc.phone || '', display_name: acc.display_name || '' });
          setName(acc.display_name || '');
          setPhone(acc.phone || '');
        }
      })
      .catch(() => {});
    bookingContacts()
      .then((j) => {
        if (!alive) return;
        setContacts(j.items || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const loadProject = useCallback(async (pid) => {
    setLoading(true);
    setErr('');
    try {
      const [pj, uj] = await Promise.all([project(pid), projectUnits(pid)]);
      const proj = pj || {};
      const us = uj?.units || [];
      setP(proj);
      setUnits(us);
      if (proj.bookable === false) {
        setNoBook(true);
        setLoading(false);
        return;
      }
      let nextTx = sp.get('transaction_mode') || '';
      if (nextTx !== 'booking' && nextTx !== 'payment') {
        if (proj.online_booking) nextTx = 'booking';
        else if (proj.online_payment) nextTx = 'payment';
      }
      if (nextTx === 'booking' && !proj.online_booking && proj.online_payment) nextTx = 'payment';
      if (nextTx === 'payment' && !proj.online_payment && proj.online_booking) nextTx = 'booking';
      setTx(nextTx);

      const qUnit = parseInt(sp.get('unit') || '', 10);
      if (qUnit && us.some((u) => u.id === qUnit)) setUnitId(qUnit);
      if (sp.get('checkin')) setCheckin(sp.get('checkin'));
      if (sp.get('checkout')) setCheckout(sp.get('checkout'));
    } catch (e) {
      setErr(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [sp]);

  useEffect(() => {
    if (resumeOrderNo) {
      setLoading(true);
      bookingLookup({ order_no: resumeOrderNo, contact_phone: sp.get('phone') || phone || '' })
        .then((j) => {
          const o = j.order || {};
          if (o.pay_status === 'paid' || o.pay_status === 'coupon_funded') {
            nav('/paid?channel=booking&order_no=' + encodeURIComponent(o.order_no) + '&phone=' + encodeURIComponent(o.contact_phone_raw || o.contact_phone || ''), { replace: true });
            return;
          }
          setOk({
            order_no: o.order_no,
            pay_status: o.pay_status,
            cancel_policy_text: o.cancel_policy_text,
            cancel_deadline: o.cancel_deadline,
            title: '待支付订单',
            sub:
              (o.project_name || '旅居预订') +
              (o.checkin ? ' · ' + o.checkin + ' → ' + (o.checkout || '') : '') +
              (o.nights ? ' · ' + o.nights + ' 晚' : '') +
              (o.price_total != null ? ' · ¥' + formatPrice(o.price_total) : ''),
            contact_phone: o.contact_phone_raw || o.contact_phone || sp.get('phone') || '',
          });
          setPhone(o.contact_phone_raw || o.contact_phone || phone);
        })
        .catch((e) => setErr(e.message || '加载待支付订单失败'))
        .finally(() => setLoading(false));
      return;
    }
    if (id) loadProject(id);
  }, [id, resumeOrderNo]); // eslint-disable-line react-hooks/exhaustive-deps

  const curUnit = units.find((u) => u.id === Number(unitId));
  const minNights = curUnit?.min_stay_nights || p?.min_stay_nights || 15;
  const perNight = curUnit ? unitNight(curUnit) : priceParts(p || {}).value || 0;
  const cancelText = unitId
    ? curUnit?.cancel_policy_text || ''
    : '整栋预订未指定房型 · 未开通免费取消，提交后不可取消';
  const rating =
    typeof p?.rating === 'string'
      ? (() => {
          try {
            return JSON.parse(p.rating) || {};
          } catch {
            return {};
          }
        })()
      : p?.rating || {};
  const starLine =
    CAIBEI && p?.rating_status === 'passed' && rating.stars
      ? '★ ' + rating.stars + ' 星 · 已评级'
      : '精选房源';
  const coverSrc = assetUrl(p?.cover_image) || COVER_FALLBACK;

  useEffect(() => {
    if (!checkin || !checkout || !id || noBook) return;
    const months = rangeMonths(checkin, checkout);
    let alive = true;
    Promise.all(
      months.map((mk) =>
        stayCalendar(id, { month: mk, unitId: unitId || undefined }).then((j) => {
          const map = {};
          (j.days || []).forEach((d) => {
            map[d.date] = d;
          });
          if (j.units) {
            const u = j.units.find((x) => Number(x.unit_id) === Number(unitId)) || j.units[0];
            (u?.days || []).forEach((d) => {
              map[d.date] = d;
            });
          }
          return map;
        }),
      ),
    ).then((maps) => {
      if (!alive) return;
      const merged = {};
      maps.forEach((m) => Object.assign(merged, m));
      setNightMap(merged);
    });
    return () => {
      alive = false;
    };
  }, [checkin, checkout, id, unitId, noBook]);

  const n = nightCount(checkin, checkout);
  const nightList = nightsBetween(checkin, checkout);
  const range = sumRange(nightList, nightMap, perNight);
  const stayNote =
    n >= 1 && n < minNights
      ? `⚠ 该房源须连续入住 ≥ ${minNights} 晚，当前 ${n} 晚`
      : `旅居房源须连续入住 · 连住 ${minNights} 晚起`;
  const maxRooms = useMemo(() => {
    const qty = curUnit ? parseInt(curUnit.total_qty, 10) || 1 : 1;
    const min = range.minRemaining;
    return Math.max(1, Math.min(qty, min == null ? qty : Math.max(min, 1)));
  }, [curUnit, range.minRemaining]);

  useEffect(() => {
    if (rooms > maxRooms) setRooms(maxRooms);
  }, [maxRooms, rooms]);

  const total = range.total * (unitId ? rooms : 1);
  const okStay = n >= minNights && !range.blocked;
  useEffect(() => {
    if (!me?.id || !p?.online_payment || !okStay || !checkin || !checkout) {
      setCouponQuotes([]); setCouponId(''); setQuotedFor(''); setCouponStatus('idle'); return;
    }
    let alive = true;
    setCouponStatus('loading'); setCouponError('');
    bookingCouponQuotes({ project_id:Number(id),unit_id:unitId ? Number(unitId) : null,checkin,checkout,rooms:unitId ? rooms : 1 })
      .then((result) => { if (alive) { const quotes=result.quotes || []; setCouponQuotes(quotes); setQuotedFor(couponContext); setCouponId((old) => quotes.some((q) => q.coupon_id === old) ? old : ''); setCouponStatus(quotes.length ? 'ready' : 'empty'); } })
      .catch((error) => { if (alive) { setCouponQuotes([]); setCouponId(''); setQuotedFor(couponContext); setCouponError(error.message || '请稍后重试'); setCouponStatus('error'); } });
    return () => { alive = false; };
  }, [me?.id,p?.online_payment,id,unitId,checkin,checkout,rooms,okStay,couponRefresh,couponContext]);

  function applyContact(v) {
    setCSel(v);
    setShowNew(v === 'new');
    if (v === 'acct' && me) {
      setName(me.display_name || '');
      setPhone(me.phone || '');
    } else if (v !== 'new') {
      const c = contacts.find((x) => String(x.id) === String(v));
      if (c) {
        setName(c.name || '');
        setPhone(c.phone || '');
      }
    }
  }

  async function onSaveContact() {
    if (!newName.trim() || !/^1\d{10}$/.test(newPhone)) {
      setErr('联系人姓名与 11 位手机号必填');
      return;
    }
    try {
      const j = await saveBookingContact({ name: newName.trim(), phone: newPhone });
      const item = j.item || j;
      const list = await bookingContacts();
      setContacts(list.items || []);
      if (item?.id) {
        applyContact(String(item.id));
      } else {
        setName(newName.trim());
        setPhone(newPhone);
        setShowNew(false);
      }
      setNewName('');
      setNewPhone('');
    } catch (e) {
      setErr(e.message || '保存失败');
    }
  }

  async function onSubmit() {
    setErr('');
    if (!id) return;
    if (n < minNights) {
      setErr('该房源须连续入住 ≥ ' + minNights + ' 晚（当前 ' + (n || 0) + ' 晚），请回到详情日历选择');
      return;
    }
    if (!name.trim() || !/^1\d{10}$/.test(phone)) {
      setErr('请填写联系人姓名与 11 位手机号');
      return;
    }
    if (!tx) {
      setErr('请选择交易方式');
      return;
    }
    setSubmitting(true);
    try {
      const body = {
        project_id: Number(id),
        unit_id: unitId ? Number(unitId) : null,
        rooms: unitId ? rooms : 1,
        checkin,
        checkout,
        contact_name: name.trim(),
        contact_phone: phone.trim(),
        transaction_mode: tx,
        ...(selectedCoupon ? { coupon_id:selectedCoupon.coupon_id,coupon_quote_gross_minor:selectedCoupon.gross_minor } : {}),
      };
      if (selectedCoupon) body.transaction_mode = 'payment';
      if (!window.BZF_CASHIER?.requestKey && (!selectedCoupon || selectedCoupon.cash_minor > 0)) throw new Error('支付组件加载失败，请刷新页面');
      body.idempotency_key = window.BZF_CASHIER?.requestKey?.('booking-create:' + JSON.stringify(body)) || window.crypto.randomUUID();
      const j = await createBooking(body);
      setOk({
        order_no: j.order_no,
        pay_status: j.pay_status,
        cancel_policy_text: j.cancel_policy_text,
        cancel_deadline: j.cancel_deadline,
        title: j.pay_status === 'coupon_funded' ? '用券预订成功，待商家确认' : '预订提交成功',
        sub: '订单号（请留存，配合手机号查单/取消）',
        contact_phone: phone.trim(),
      });
    } catch (e) {
      setErr(e.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  async function onPay() {
    if (!ok?.order_no) return;
    setPaying(true);
    const contactPhone = ok.contact_phone || phone;
    const result =
      '/h5/paid?channel=booking&order_no=' +
      encodeURIComponent(ok.order_no) +
      '&phone=' +
      encodeURIComponent(contactPhone || '');
    try {
      const lk = await bookingLookup({ order_no: ok.order_no, contact_phone: contactPhone });
      const o = lk.order || {};
      if (o.pay_status === 'paid' || o.pay_status === 'coupon_funded') {
        nav('/paid?channel=booking&order_no=' + encodeURIComponent(ok.order_no) + '&phone=' + encodeURIComponent(contactPhone || ''));
        return;
      }
      if (o.status !== 'pending') {
        alert('订单状态为「' + o.status + '」，无需支付');
        return;
      }
      const cashier = window.BZF_CASHIER;
      if (!cashier) throw new Error('支付组件加载失败，请刷新页面');
      const cashierType = cashier.cashierType();
      if (cashierType === '1') await cashier.ensureAppBridge();
      const requestKey = cashier.requestKey('booking-pay:' + ok.order_no + ':' + cashierType, newPayAttempt);
      setNewPayAttempt(false);
      let pay = cashier.normalize(await bookingPay({
        order_no: ok.order_no,
        contact_phone: contactPhone,
        cashier_type: cashierType,
        idempotency_key: requestKey,
      }));
      if (!pay.cashier_url && pay.pay_status !== 'paid' && pay.next_action !== 'new_attempt') {
        pay = await cashier.waitForCashier(() => bookingPaymentQuery({ order_no: ok.order_no, contact_phone: contactPhone }));
      }
      const paid =
        result + '&app_order_id=' + encodeURIComponent(pay.app_order_id || '');
      if (pay.next_action === 'new_attempt') {
        setNewPayAttempt(true);
        alert('原支付已关闭，请再次点击支付以开启新的付款尝试');
        return;
      }
      if (!cashier.open(pay, { onResult: () => { location.href = paid; }, onCancel: () => setPaying(false) })) {
        setErr(pay.next_action === 'closed' ? '订单已关闭，请重新预订' : '支付结果确认中，请稍后继续查看订单');
      }
    } catch (e) {
      alert(e.message || '支付失败');
    } finally {
      setPaying(false);
    }
  }

  async function callPhone() {
    try {
      const res = await virtualPhone(id);
      if (res.tel) location.href = res.tel;
      else alert(res.error || '暂未配置咨询电话');
    } catch (e) {
      alert(e.message || '暂时无法接通');
    }
  }

  const paidMode = tx === 'payment';
  const modHref =
    '/detail/' +
    id +
    '?' +
    new URLSearchParams({
      ...(unitId ? { unit: String(unitId) } : {}),
      ...(checkin ? { checkin } : {}),
      ...(checkout ? { checkout } : {}),
    }).toString();

  if (loading) {
    return (
      <div className="booking-page">
        <div className="bk-pad muted">加载中…</div>
      </div>
    );
  }

  if (noBook && p) {
    return (
      <div className="booking-page">
        <div className="nobook">
          <div className="ic">📞</div>
          <div className="t">{p.name} · 仅支持电话咨询</div>
          <p>该项目暂未配置在线预订或在线支付，咨询与签约请拨打房源电话。</p>
          <button type="button" className="btn" onClick={callPhone}>
            拨打咨询电话
          </button>
          <Link to={`/detail/${id}`}>← 返回详情</Link>
        </div>
      </div>
    );
  }

  if (ok) {
    return (
      <div className="booking-page">
        <div className="steps">
          <span className="st on">
            <span className="n">1</span>预定下单
          </span>
          <span className="sep">›</span>
          {paidMode ? (
            <>
              <span className="st on">
                <span className="n">2</span>在线支付
              </span>
              <span className="sep">›</span>
              <span className="st">
                <span className="n">3</span>商家确认
              </span>
            </>
          ) : (
            <span className="st">
              <span className="n">2</span>商家确认
            </span>
          )}
        </div>
        <div className="okbox">
          <div className="ok-ic">✓</div>
          <div className="ok-t">{ok.title || '预订提交成功'}</div>
          <div className="ok-s">{ok.sub || '订单号'}</div>
          <div className="ok-no">{ok.order_no}</div>
          <div className="ok-hint">商家确认后订单生效 · 状态可在「订单」页查询</div>
          {ok.cancel_policy_text ? (
            <div className="ok-cp">
              {ok.cancel_policy_text}
              {ok.cancel_deadline ? '（截止 ' + ok.cancel_deadline + '）' : ''}
            </div>
          ) : null}
          {ok.pay_status === 'unpaid' ||
          ok.pay_status === 'creating' ||
          ok.pay_status === 'paying' ||
          ok.pay_status === 'create_unknown' ? (
            <button type="button" className="btn pay" onClick={onPay} disabled={paying}>
              {paying ? '正在拉起收银台…' : '立即支付 →'}
            </button>
          ) : null}
          <Link className="btn ghost" to="/orders">
            去订单页查状态 →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="booking-page">
      <div className="steps">
        <span className="st on">
          <span className="n">1</span>预定下单
        </span>
        <span className="sep">›</span>
        {paidMode ? (
          <>
            <span className="st">
              <span className="n">2</span>在线支付
            </span>
            <span className="sep">›</span>
            <span className="st">
              <span className="n">3</span>商家确认
            </span>
            <span className="sep">›</span>
            <span className="st">
              <span className="n">4</span>完成
            </span>
          </>
        ) : (
          <>
            <span className="st">
              <span className="n">2</span>商家确认
            </span>
            <span className="sep">›</span>
            <span className="st">
              <span className="n">3</span>线下收款
            </span>
          </>
        )}
      </div>

      <div className="minihouse">
        <div className="th" style={{ backgroundImage: `url(${coverSrc})` }} />
        <div className="mi">
          <div className="nm">{p?.name || '—'}</div>
          <div className="meta">{p?.address || ''}</div>
          <div className="st">{starLine}</div>
        </div>
      </div>

      <div className="seg">入住信息</div>
      <div className="confirmbar">
        <div className="ds">
          <small>入住</small>
          <b className={checkin ? '' : 'ph'}>
            {checkin ? mdWeek(new Date(checkin + 'T00:00:00')) : '请选择'}
          </b>
        </div>
        <div className="mid">
          <b>{n || '—'}</b>晚
        </div>
        <div className="ds">
          <small>离店</small>
          <b className={checkout ? '' : 'ph'}>
            {checkout ? mdWeek(new Date(checkout + 'T00:00:00')) : '请选择'}
          </b>
        </div>
        <Link className="mod" to={modHref}>
          修改
        </Link>
      </div>
      <div className="bfield note-row warn">
        <span className="l">{stayNote}</span>
      </div>
      {cancelText ? (
        <div className="bfield note-row muted">
          <span className="l">
            <img className="ic-timer" src={TIMER_IC} alt="" width="12" height="12" />
            退改：{cancelText}
          </span>
        </div>
      ) : null}

      <div className="bfield">
        <span className="l">房型</span>
        <select
          value={unitId || ''}
          onChange={(e) => {
            setUnitId(e.target.value ? Number(e.target.value) : '');
            setRooms(1);
          }}
        >
          <option value="">不限房型（按起价）</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
              {u.area_sqm ? ` · ${u.area_sqm}㎡` : ''}（{u.total_qty || 1} 间）
            </option>
          ))}
        </select>
      </div>
      {unitId ? (
        <div className="bfield">
          <span className="l">间数</span>
          <select value={rooms} onChange={(e) => setRooms(Number(e.target.value))}>
            {Array.from({ length: maxRooms }, (_, i) => i + 1).map((i) => (
              <option key={i} value={i}>
                {i} 间
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="bfield">
        <span className="l">交易方式</span>
        <select value={tx} onChange={(e) => { setTx(e.target.value); if (e.target.value === 'booking') setCouponId(''); }}>
          {p?.online_booking ? (
            <option value="booking">在线预订 · 商家确认后线下收款</option>
          ) : null}
          {p?.online_payment ? (
            <option value="payment">在线支付 · 支付后商家确认</option>
          ) : null}
        </select>
      </div>

      <div className="seg">入住人 / 联系方式</div>
      <div className="bfield">
        <span className="l">联系人</span>
        <select value={cSel} onChange={(e) => applyContact(e.target.value)}>
          {me ? (
            <option value="acct">
              我的资料（{me.display_name || ''} · {(me.phone || '').replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')}）
            </option>
          ) : null}
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.phone}
            </option>
          ))}
          <option value="new">＋ 新增联系人…</option>
        </select>
      </div>
      {showNew ? (
        <div className="cnew">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="联系人姓名" />
          <div className="row">
            <input
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              placeholder="11 位手机号"
              inputMode="numeric"
              maxLength={11}
            />
            <button type="button" className="sv" onClick={onSaveContact}>
              保存
            </button>
          </div>
        </div>
      ) : null}
      <div className="bfield">
        <span className="l">联系人姓名</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="bfield">
        <span className="l">手机号</span>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="numeric"
          maxLength={11}
        />
      </div>

      <div className="seg">价格明细</div>
      <div className="panel">
        <div className="kv">
          <span className="k">
            {okStay
              ? `房费 ${mds(new Date(checkin + 'T00:00:00'))} – ${mds(new Date(checkout + 'T00:00:00'))} · ${n} 晚${rooms > 1 && unitId ? ' × ' + rooms + ' 间' : ''}`
              : `房费 ¥${formatPrice(perNight)} × ${n || '—'} 晚`}
          </span>
          <span className="v">{okStay && total ? '¥' + formatPrice(total) : '—'}</span>
        </div>
        <div className="kv">
          <span className="k muted">
            {range.est ? '按晚均价估算 · 逐晚实价加载中' : '与详情页日历实价同口径'}
          </span>
        </div>
        <div className="kv big">
          <span className="k">房费合计（未用券）</span>
          <span className="v">{okStay && total ? '¥' + formatPrice(total) : '—'}</span>
        </div>
        {p?.online_payment ? <div className="booking-coupon" aria-busy={couponStatus === 'loading' || quotedFor !== couponContext}>
          <div className="booking-coupon-head"><strong>使用权益券</strong><span>{couponStatus === 'ready' && visibleQuotes.length ? `${visibleQuotes.length} 张适用` : ''}</span></div>
          {visibleQuotes.length ? <select aria-label="选择权益券" value={couponId} onChange={(e) => { setCouponId(e.target.value); if (e.target.value) setTx('payment'); }}>
            <option value="">不使用券</option>
            {visibleQuotes.map((q) => <option key={q.coupon_id} value={q.coupon_id}>{q.name} · {q.mode === 'exchange' ? '直接兑换' : '抵用 ¥' + formatPrice(q.coupon_minor / 100)}</option>)}
          </select> : null}
          <p role="status" className="booking-coupon-status">{!okStay ? '选定可预订日期后查询适用券。' : !me?.id ? '登录后可查看本单适用券。' : couponStatus === 'loading' || quotedFor !== couponContext ? '正在核对房型、日期和可用券…' : couponStatus === 'error' ? <>可用券查询失败：{couponError}。可按原价继续，或 <button type="button" onClick={() => setCouponRefresh((v) => v + 1)}>重试查询</button></> : couponStatus === 'empty' ? '本单暂无适用券，请在卡券详情核对适用房型和有效期。' : selectedCoupon ? '' : '选择一张券，现金应付会立即更新。'}</p>
          {selectedCoupon ? <div className="booking-coupon-breakdown" key={selectedCoupon.coupon_id}>{selectedCoupon.mode === 'exchange' ? <div className="kv"><span className="k">签约兑付价</span><span className="v">¥{formatPrice(selectedCoupon.gross_minor / 100)}</span></div> : null}<div className="kv"><span className="k">券抵</span><span className="v">−¥{formatPrice(selectedCoupon.coupon_minor / 100)}</span></div>
            <div className="kv big"><span className="k">本单现金应付</span><span className="v">¥{formatPrice(selectedCoupon.cash_minor / 100)}</span></div>
            <p>{selectedCoupon.mode === 'exchange' ? '直接兑换 1 项指定房型；签约价可能与原房费不同。' : '整张抵用，不拆分找零。'}提交时将重新核对适用范围与金额。</p></div> : null}
        </div> : null}
      </div>
      <button type="button" className="nl-toggle" onClick={() => setShowNights((v) => !v)}>
        {showNights ? '收起逐晚价格 ▴' : '查看逐晚价格 ▾'}
      </button>
      {showNights ? (
        <div className="nlist">
          {nightList.map((d) => {
            const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const inf = nightMap[key];
            const price = inf && inf.price != null ? Number(inf.price) : perNight;
            const booked = inf && (inf.status === 'booked' || inf.status === 'blocked' || (inf.remaining != null && inf.remaining <= 0));
            return (
              <div className="nrow" key={key}>
                <span className="d">
                  {mds(d)} 周{WK[d.getDay()]}
                  {booked ? ' · 已订满' : ''}
                </span>
                <span className={'p' + (booked ? ' hi' : '')}>¥{formatPrice(price)}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      {err ? <div className="berr">{err}</div> : null}

      <div className="agree">
        {paidMode
          ? '提交即同意《旅居预订与退改协议》。资金由贝壳存管，支付后待商家确认。'
          : '提交即同意《旅居预订与退改协议》。本单在线预订，商家确认后线下收款。'}
      </div>

      <div className="bk-cta">
        <div className="p">
          <b>{selectedCoupon ? '¥' + formatPrice(selectedCoupon.cash_minor / 100) : okStay && total ? '¥' + formatPrice(total) : '—'}</b>
          <span>
            {n >= 1 && n < minNights
              ? '连住不足 ' + minNights + ' 晚'
              : n >= 1
                ? '共 ' + n + ' 晚' + (rooms > 1 && unitId ? ' · ' + rooms + ' 间' : '')
                : '待选日期'}
          </span>
        </div>
        <button type="button" className="btn" disabled={submitting || !okStay} onClick={onSubmit}>
          {submitting ? '提交中…' : '提交订单'}
        </button>
      </div>
    </div>
  );
}

export default function Booking() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const resume = (sp.get('order_no') || '').trim();
  if (!id && !resume) {
    return (
      <div className="booking-page">
        <div className="berr">未指定房源 · 请从详情页进入预订</div>
        <div className="bk-pad">
          <Link to="/search">← 去找房</Link>
        </div>
      </div>
    );
  }
  return <BookingInner />;
}
