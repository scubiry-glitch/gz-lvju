import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { stayCalendar } from '../lib/api.js';
import { formatPrice } from '../lib/price.js';
import {
  addDays,
  buildMonthGrid,
  dayBlocked,
  iso,
  md,
  monthKey,
  monthsFrom,
  startOfToday,
  sumRange,
  nightsBetween,
  mds,
} from '../lib/stay.js';
import '../styles/calsheet.css';

/**
 * 底部滑出房态日历：点选入住→离店，连住校验，已订/关房不可选。
 * onConfirm({ checkin, checkout }) — ISO 字符串
 */
export default function CalSheet({
  open,
  onClose,
  projectId,
  unitId,
  unitIds = [],
  minNights = 15,
  basePrice = 0,
  checkin,
  checkout,
  onConfirm,
}) {
  const today = useMemo(() => startOfToday(), []);
  const maxDay = useMemo(() => addDays(today, 365), [today]);
  const monthList = useMemo(() => monthsFrom(today, 13), [today]);

  const [ci, setCi] = useState(null);
  const [co, setCo] = useState(null);
  const [tip, setTip] = useState('');
  const [cache, setCache] = useState({}); // `${uid}|${mk}` → date map
  const pending = useRef({});
  const monthsRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setCi(checkin ? new Date(checkin + 'T00:00:00') : null);
    setCo(checkout ? new Date(checkout + 'T00:00:00') : null);
    setTip('');
  }, [open, checkin, checkout]);

  const selUid = unitId || 0;

  const dayInfo = useCallback(
    (d) => {
      const mk = monthKey(d);
      const map = cache[selUid + '|' + mk] || cache['0|' + mk] || {};
      return map[iso(d)] || null;
    },
    [cache, selUid],
  );

  const loadMonth = useCallback(
    (mk) => {
      if (!projectId || !open) return;
      const key = 'batch|' + mk;
      if (pending.current[key]) return;
      const us = unitIds.length ? unitIds : selUid ? [selUid] : [];
      pending.current[key] = true;
      stayCalendar(projectId, { month: mk, units: us.length ? us : undefined, unitId: !us.length ? selUid || undefined : undefined })
        .then((j) => {
          setCache((prev) => {
            if (us.length && us.every((u) => prev[u + '|' + mk])) return prev;
            if (!us.length && prev['0|' + mk]) return prev;
            const next = { ...prev };
            if (j.units) {
              j.units.forEach((u) => {
                const map = {};
                (u.days || []).forEach((x) => {
                  map[x.date] = x;
                });
                next[u.unit_id + '|' + mk] = map;
              });
            } else if (j.days) {
              const map = {};
              j.days.forEach((x) => {
                map[x.date] = x;
              });
              next[(selUid || 0) + '|' + mk] = map;
            }
            return next;
          });
        })
        .catch(() => {
          setCache((prev) => {
            const next = { ...prev };
            (us.length ? us : [0]).forEach((u) => {
              next[u + '|' + mk] = next[u + '|' + mk] || {};
            });
            return next;
          });
        })
        .finally(() => {
          delete pending.current[key];
        });
    },
    [projectId, open, unitIds, selUid],
  );

  useEffect(() => {
    if (!open || !monthsRef.current) return;
    const root = monthsRef.current;
    const io = new IntersectionObserver(
      (ents) => {
        ents.forEach((e) => {
          if (e.isIntersecting) loadMonth(e.target.dataset.mk);
        });
      },
      { root, rootMargin: '240px 0px' },
    );
    root.querySelectorAll('[data-mk]').forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [open, loadMonth, monthList]);

  function pick(d) {
    if (d < today || d > maxDay) return;
    const inf = dayInfo(d);
    if (dayBlocked(inf)) return;
    if (!ci || (ci && co) || d <= ci) {
      setCi(d);
      setCo(null);
      setTip('');
      return;
    }
    const n = Math.round((d - ci) / 864e5);
    if (n < minNights) {
      setTip('须连续入住 ≥ ' + minNights + ' 晚 · 最早 ' + md(addDays(ci, minNights)) + ' 离店');
      return;
    }
    let firstBad = null;
    for (let t = new Date(ci); t < d; t.setDate(t.getDate() + 1)) {
      const tInf = dayInfo(t);
      if (dayBlocked(tInf)) {
        firstBad = new Date(t);
        break;
      }
    }
    if (firstBad) {
      setTip(md(firstBad) + (dayInfo(firstBad)?.status === 'booked' ? ' 已订' : ' 关房') + ' · 请调整日期或换房型');
      return;
    }
    setCo(d);
    setTip('');
  }

  const n = ci && co ? Math.round((co - ci) / 864e5) : 0;
  const nights = ci && co ? nightsBetween(ci, co) : [];
  const dayMap = useMemo(() => {
    const map = {};
    nights.forEach((d) => {
      const inf = dayInfo(d);
      if (inf) map[iso(d)] = inf;
    });
    return map;
  }, [nights, dayInfo]);
  const range = sumRange(nights, dayMap, basePrice);

  function confirm() {
    if (!ci || !co || !n) return;
    onConfirm?.({ checkin: iso(ci), checkout: iso(co) });
    onClose?.();
  }

  if (!open) return null;

  return (
    <div className="calsheet open" aria-hidden="false">
      <div className="cs-mask" onClick={onClose} />
      <div className="cs-panel">
        <div className="cs-grip" onClick={onClose} />
        <div className="cs-head">
          <div className="cs-h1">
            选择日期
            <button type="button" className="cs-x" onClick={onClose} aria-label="关闭">
              ✕
            </button>
          </div>
          <div className="cs-range">
            <div className="csd">
              <small>入住</small>
              <b className={ci ? '' : 'ph'}>{ci ? md(ci) : '请选择'}</b>
            </div>
            <span className="carr">→</span>
            <div className="cnn">{n ? n + '晚' : '—'}</div>
            <div className="csd">
              <small>离店</small>
              <b className={co ? '' : 'ph'}>{co ? md(co) : '请选择'}</b>
            </div>
          </div>
          <div className={'cs-tip' + (tip ? ' warn' : '')}>
            {tip || '连住 ' + minNights + ' 晚起 · 点选入住与离店日期，再点「确定」'}
          </div>
        </div>
        <div className="cs-months" ref={monthsRef}>
          {monthList.map((m) => {
            const y = m.getFullYear();
            const mo = m.getMonth();
            const mk = monthKey(m);
            const cells = buildMonthGrid(y, mo);
            return (
              <div className="csm" key={mk} data-mk={mk}>
                <div className="csm-t">
                  {y}年{mo + 1}月
                </div>
                <div className="cs-wk">
                  {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
                    <span key={w}>{w}</span>
                  ))}
                </div>
                <div className="cs-grid">
                  {cells.map((d, i) => {
                    if (!d) return <div className="cd blank" key={'b' + i} />;
                    const past = d < today;
                    const beyond = d > maxDay;
                    const inf = dayInfo(d);
                    const noslot = dayBlocked(inf);
                    const low = inf && inf.remaining != null && inf.remaining > 0 && inf.remaining <= 2;
                    const isCi = ci && iso(d) === iso(ci);
                    const isCo = co && iso(d) === iso(co);
                    const inRange = ci && co && d > ci && d < co;
                    const wknd = d.getDay() === 0 || d.getDay() === 6;
                    const tdy = iso(d) === iso(today);
                    const price = inf && inf.price != null ? Number(inf.price) : basePrice;
                    let cls = 'cd';
                    if (past || beyond) cls += ' past dis';
                    else if (noslot) cls += ' noslot';
                    if (tdy) cls += ' tdy';
                    if (wknd) cls += ' wknd';
                    if (low && !noslot) cls += ' low';
                    if (inRange) cls += ' range';
                    if (isCi || isCo) cls += ' end';
                    return (
                      <div
                        key={iso(d)}
                        className={cls}
                        onClick={() => !(past || beyond || noslot) && pick(d)}
                      >
                        <span className="dn">{d.getDate()}</span>
                        {!past && !beyond ? (
                          <span className="dp">
                            {noslot ? '满' : price ? '¥' + price : '·'}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="cs-legend">
            <span>
              <i style={{ background: 'var(--brand)' }} />
              选中
            </span>
            <span>
              <i style={{ background: 'var(--brand-soft)' }} />
              入住段
            </span>
            <span>
              <i style={{ background: '#f7f8f8' }} />
              不可订
            </span>
          </div>
        </div>
        <div className="cs-bar">
          <div className="cs-tot">
            {n && !range.blocked ? (
              <>
                合计<b>¥{formatPrice(range.total)}</b>
                {mds(ci)}–{mds(co)} · 均价 ¥{Math.round(range.total / n)}/晚
              </>
            ) : n && range.blocked ? (
              <span style={{ color: '#b91c1c', fontWeight: 600 }}>选中户型该时段含已订 · 请换日期或房型</span>
            ) : basePrice ? (
              <>
                <b>¥{formatPrice(basePrice)}</b>/晚起 · 连住 {minNights} 晚起
              </>
            ) : (
              '请选择入住与离店日期'
            )}
          </div>
          <button type="button" className="cs-ok" disabled={!n || range.blocked} onClick={confirm}>
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
