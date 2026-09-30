import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import CalSheet from '../components/CalSheet.jsx';
import { project, projectUnits, stayCalendar, virtualPhone } from '../lib/api.js';
import { assetUrl } from '../lib/asset.js';
import { formatPrice, priceParts, unitNight } from '../lib/price.js';
import { md, monthKey, nightCount, parseIso, sumRange, nightsBetween } from '../lib/stay.js';
import '../styles/detail.css';

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

function parseRating(r) {
  if (Array.isArray(r)) return {};
  if (typeof r === 'string') {
    try {
      const o = JSON.parse(r);
      return o && !Array.isArray(o) ? o : {};
    } catch {
      return {};
    }
  }
  return r && typeof r === 'object' ? r : {};
}

function parseExt(u) {
  if (!u) return {};
  if (u.room_profile && typeof u.room_profile === 'object') return { room_profile: u.room_profile };
  let ex = u.ext;
  if (typeof ex === 'string') {
    try {
      ex = JSON.parse(ex);
    } catch {
      ex = {};
    }
  }
  return ex && typeof ex === 'object' ? ex : {};
}

function profileOf(u) {
  const ex = parseExt(u);
  const p = ex.room_profile;
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}

const FACILITY_CATALOG = {
  ac: { icon: 'fac-ac.svg', label: '空调暖气' },
  washer: { icon: 'fac-washer.svg', label: '洗衣机' },
  fridge: { icon: 'fac-fridge.svg', label: '冰箱' },
  heater: { icon: 'fac-heater.svg', label: '热水器' },
  lock: { icon: 'fac-lock.svg', label: '智能门锁' },
  wifi: { icon: 'fac-wifi.svg', label: '无线网络' },
  tv: { icon: 'fac-tv.svg', label: '电视' },
  hood: { icon: 'fac-hood.svg', label: '油烟机' },
  microwave: { icon: 'fac-microwave.svg', label: '微波炉' },
  induction: { icon: 'fac-induction.svg', label: '电磁炉' },
  kitchen: { icon: '', label: '厨房' },
  window: { icon: '', label: '自然采光' },
  cleaning: { icon: '', label: '清洁服务' },
};

function facilityData(u) {
  const p = profileOf(u);
  const list = [];
  const seen = {};
  function add(key, detail, label) {
    if (seen[key]) return;
    const meta = FACILITY_CATALOG[key] || { icon: '', label: label || key };
    seen[key] = true;
    list.push({
      key,
      icon: meta.icon ? '/assets/lvju/icons/' + meta.icon : '',
      label: label || meta.label,
      detail: detail || '',
    });
  }
  asArr(u.amenities).forEach((key) => {
    const detail = key === 'ac' ? p.climate : key === 'wifi' ? p.network : key === 'heater' ? p.bath_hot_water : '';
    add(key, detail);
  });
  if (p.network) add('wifi', p.network);
  if (p.climate) add('ac', p.climate);
  if (p.bath_hot_water) add('heater', p.bath_hot_water);
  if (p.kitchen) add('kitchen', p.kitchen);
  if (p.window_type && p.window_type !== 'none') {
    add(
      'window',
      (p.window_count ? p.window_count + '扇 · ' : '') + (p.window_openable === false ? '不可开启' : '可开启'),
    );
  }
  if (p.cleaning_frequency) add('cleaning', p.cleaning_frequency);
  return list;
}

function roomFacts(u) {
  const p = profileOf(u);
  const areaType = p.area_type === 'usable' ? '使用面积' : p.area_type === 'building' ? '建筑面积' : '面积';
  let windowLabel = { exterior: '外窗', interior: '内窗', none: '无窗' }[p.window_type] || '';
  if (windowLabel && p.window_type !== 'none') {
    if (p.window_count != null) windowLabel += ' · ' + p.window_count + ' 扇';
    if (p.window_openable != null) windowLabel += p.window_openable ? ' · 可开启' : ' · 不可开启';
  }
  let occupancy = p.max_guests != null ? '最多 ' + p.max_guests + ' 人' : '';
  if (p.max_adults != null) occupancy += (occupancy ? ' · ' : '') + '成人 ' + p.max_adults + ' 人';
  if (p.max_children != null) occupancy += (occupancy ? ' · ' : '') + '儿童 ' + p.max_children + ' 人';
  const smoking = { no: '全屋禁烟', designated: '仅指定区域可吸烟', allowed: '可吸烟' }[p.smoking] || '';
  return [
    [areaType, u.area_sqm ? u.area_sqm + '㎡' : ''],
    ['房屋结构', u.layout_label],
    ['共享空间', p.shared_spaces],
    ['窗户', windowLabel],
    ['入住人数', occupancy],
    ['儿童适住', p.child_age_policy],
    ['加人 / 加床', p.extra_guest_policy],
    ['卧室与床位', p.beds],
    ['洗浴与热水', p.bath_hot_water],
    ['厨房', p.kitchen],
    ['吸烟', smoking],
    ['空调 / 暖气', p.climate],
    ['网络', p.network],
    ['打扫频率', p.cleaning_frequency],
    ['床品 / 毛巾', p.linen_frequency],
  ].filter((row) => row[1] !== '' && row[1] != null);
}

const RATE_DIMS = {
  rental: [
    { k: 'comfort', l: '舒适' },
    { k: 'green', l: '绿色' },
    { k: 'tech', l: '智慧' },
    { k: 'safety', l: '安全' },
  ],
  minsu: [
    { k: 'scenery', l: '环境景观' },
    { k: 'facilities', l: '设施配套' },
    { k: 'service', l: '服务品质' },
    { k: 'location', l: '区位交通' },
    { k: 'culture', l: '在地体验' },
  ],
};

const SPOT_ICON = { scenic: '🏔', biz: '🛍', food: '🍜', cafe: '☕' };

function keeperOf(units) {
  for (const u of units || []) {
    let k = u.keeper;
    if (typeof k === 'string') {
      try {
        k = JSON.parse(k);
      } catch {
        k = null;
      }
    }
    if (Array.isArray(k)) k = k[0];
    if (k && k.name) return k;
  }
  return null;
}

export default function Detail() {
  const { id } = useParams();
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const scrRef = useRef(null);

  const [p, setP] = useState(null);
  const [units, setUnits] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(true);

  const [selUnit, setSelUnit] = useState(() => parseInt(sp.get('unit') || '', 10) || 0);
  const [profileUnit, setProfileUnit] = useState(0);
  const [checkin, setCheckin] = useState(() => sp.get('checkin') || '');
  const [checkout, setCheckout] = useState(() => sp.get('checkout') || '');
  const [calOpen, setCalOpen] = useState(false);
  const [heroIdx, setHeroIdx] = useState(0);
  const [rangeCache, setRangeCache] = useState({});
  const [calling, setCalling] = useState(false);
  const [sec, setSec] = useState('units'); // units | facilities | nearby

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErr('');
    Promise.all([project(id), projectUnits(id)])
      .then(([pj, uj]) => {
        if (!alive) return;
        const proj = Object.assign({}, pj || {}, (uj && uj.project) || {});
        proj.tags = asArr(proj.tags);
        const us = (uj?.units || []).map((u) => {
          u.tags = asArr(u.tags);
          u.amenities = asArr(u.amenities);
          return u;
        });
        setP(proj);
        setUnits(us);
        setPhotos(uj?.photos || []);
        const qUnit = parseInt(sp.get('unit') || '', 10);
        const first = qUnit && us.some((u) => u.id === qUnit) ? qUnit : us[0]?.id || 0;
        setSelUnit(first);
        setProfileUnit(first);
        document.title = (proj.name || '房源详情') + ' · 贝壳找房旅居';
      })
      .catch((e) => {
        if (!alive) return;
        setErr(e.message || '加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const bookable = p?.bookable === true;
  const minNights = useMemo(() => {
    const u = units.find((x) => x.id === selUnit);
    if (u && u.min_stay_nights) return u.min_stay_nights;
    return p?.min_stay_nights || 15;
  }, [p, units, selUnit]);

  const basePrice = useMemo(() => {
    const u = units.find((x) => x.id === selUnit);
    if (u) return unitNight(u);
    return priceParts(p || {}).value || 0;
  }, [units, selUnit, p]);

  const unitIds = useMemo(() => units.map((u) => u.id), [units]);

  const heroUrls = useMemo(() => {
    const urls = photos.map((ph) => assetUrl(ph.file_path)).filter(Boolean);
    if (!urls.length && p?.cover_image) return [assetUrl(p.cover_image)];
    return urls.slice(0, 8);
  }, [photos, p]);

  const spots = Array.isArray(p?.spots) ? p.spots : [];
  const hasFacilities = units.some((u) => roomFacts(u).length || facilityData(u).length || profileOf(u).introduction);
  const hasNearby = spots.length > 0;
  const navItems = useMemo(() => {
    const items = [{ id: 'units', label: '房型', target: 'dUnitsBlock' }];
    if (hasFacilities) items.push({ id: 'facilities', label: '设施', target: 'dFacilitiesBlock' });
    if (hasNearby) items.push({ id: 'nearby', label: '周边', target: 'dNearbyBlock' });
    return items;
  }, [hasFacilities, hasNearby]);

  useEffect(() => {
    if (!bookable || !checkin || !checkout || !id) return;
    const months = new Set();
    nightsBetween(checkin, checkout).forEach((d) => months.add(monthKey(d)));
    let alive = true;
    Promise.all(
      [...months].map((mk) =>
        stayCalendar(id, { month: mk, units: unitIds.length ? unitIds : undefined }).then((j) => ({ mk, j })),
      ),
    ).then((rows) => {
      if (!alive) return;
      const next = {};
      rows.forEach(({ j }) => {
        if (j.units) {
          j.units.forEach((u) => {
            const map = next[u.unit_id] || {};
            (u.days || []).forEach((d) => {
              map[d.date] = d;
            });
            next[u.unit_id] = map;
          });
        } else if (j.days) {
          const map = next[selUnit || 0] || {};
          j.days.forEach((d) => {
            map[d.date] = d;
          });
          next[selUnit || 0] = map;
        }
      });
      setRangeCache(next);
    });
    return () => {
      alive = false;
    };
  }, [bookable, checkin, checkout, id, unitIds, selUnit]);

  const syncUrl = useCallback(
    (ci, co, uid) => {
      const n = new URLSearchParams(sp);
      if (ci) n.set('checkin', ci);
      else n.delete('checkin');
      if (co) n.set('checkout', co);
      else n.delete('checkout');
      if (uid) n.set('unit', String(uid));
      else n.delete('unit');
      setSp(n, { replace: true });
    },
    [sp, setSp],
  );

  function onCalConfirm({ checkin: ci, checkout: co }) {
    setCheckin(ci);
    setCheckout(co);
    syncUrl(ci, co, selUnit);
  }

  function selectUnit(uid) {
    setSelUnit(uid);
    setProfileUnit(uid);
    syncUrl(checkin, checkout, uid);
  }

  function goBooking(uid) {
    const u = uid || selUnit;
    if (!checkin || !checkout) {
      if (u) selectUnit(u);
      setCalOpen(true);
      return;
    }
    const map = rangeCache[u] || {};
    const r = sumRange(nightsBetween(checkin, checkout), map, unitNight(units.find((x) => x.id === u) || {}));
    if (r.blocked) {
      setCalOpen(true);
      return;
    }
    const q = new URLSearchParams();
    q.set('checkin', checkin);
    q.set('checkout', checkout);
    if (u) q.set('unit', String(u));
    nav('/booking/' + id + '?' + q.toString());
  }

  function scrollTo(targetId, secId) {
    setSec(secId);
    const el = document.getElementById(targetId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function callPhone() {
    setCalling(true);
    try {
      const res = await virtualPhone(id);
      if (res.tel) location.href = res.tel;
      else alert(res.error || '该项目暂未配置咨询电话');
    } catch (e) {
      alert(e.message || '暂时无法接通');
    } finally {
      setCalling(false);
    }
  }

  const rating = parseRating(p?.rating);
  const n = nightCount(checkin, checkout);
  const ciD = parseIso(checkin);
  const coD = parseIso(checkout);
  const keeper = keeperOf(units);
  const profileU = units.find((u) => u.id === profileUnit) || units[0];
  const facilities = profileU ? facilityData(profileU) : [];
  const facts = profileU ? roomFacts(profileU) : [];
  const profile = profileU ? profileOf(profileU) : {};
  const dimsDef = RATE_DIMS[p?.channel] || [];
  const st = p?.rating_status || 'draft';
  const txLabels = [p?.online_booking ? '在线预订' : '', p?.online_payment ? '在线支付' : '']
    .filter(Boolean)
    .join(' / ');

  const ctaPrice = useMemo(() => {
    const pd = priceParts(p || {});
    if (n && selUnit) {
      const map = rangeCache[selUnit] || {};
      const r = sumRange(nightsBetween(checkin, checkout), map, basePrice);
      if (r.blocked) return { text: '满', sub: '换日期' };
      return { text: '¥' + formatPrice(r.total), sub: n + '晚合计' };
    }
    if (pd.value != null) return { text: '¥' + formatPrice(pd.value), sub: '起' };
    return { text: '—', sub: pd.note || '' };
  }, [n, selUnit, rangeCache, checkin, checkout, basePrice, p]);

  if (loading) {
    return (
      <div className="pd">
        <div className="pd-hero skl" />
        <div className="pd-block">
          <div className="skl-line" style={{ width: '60%' }} />
          <div className="skl-line" style={{ width: '40%', marginTop: 8 }} />
        </div>
        <div className="pd-block">
          <div className="skl-card">
            <div className="skl skl-th" />
            <div className="skl-lines">
              <div className="skl-line" style={{ width: '55%' }} />
              <div className="skl-line" style={{ width: '38%' }} />
              <div className="skl-line" style={{ width: '70%' }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (err || !p) {
    return (
      <div className="pd">
        <div className="pd-err">
          {err || '房源不存在'}
          <Link to="/search">← 返回找房</Link>
        </div>
      </div>
    );
  }

  const tags = p.tags || [];

  return (
    <div className="pd" ref={scrRef}>
      <button type="button" className="pd-back" onClick={() => nav(-1)} aria-label="返回">
        ←
      </button>

      <div
        className="pd-hero"
        style={heroUrls[0] ? { backgroundImage: `url(${heroUrls[heroIdx] || heroUrls[0]})` } : undefined}
      >
        {heroUrls.length > 1 ? (
          <div
            className="hero-track"
            onScroll={(e) => {
              const t = e.currentTarget;
              setHeroIdx(Math.round(t.scrollLeft / Math.max(1, t.clientWidth)));
            }}
          >
            {heroUrls.map((u) => (
              <div key={u} className="hero-slide" style={{ backgroundImage: `url(${u})` }} />
            ))}
          </div>
        ) : null}
        <div className="badge">
          <span className="star">
            {st === 'passed' && rating.stars
              ? `★ ${rating.stars} 星 · ${rating.star_label || ''}`
              : st === 'pending'
                ? '评级复核中'
                : '待评级'}
          </span>
          <div className="nm">{p.name}</div>
          <div className="lo">{p.address || ''}</div>
        </div>
        {heroUrls.length > 1 ? (
          <div className="dots">
            {heroIdx + 1} / {heroUrls.length}
          </div>
        ) : null}
      </div>

      <div className="pd-block">
        <div className="bt">{tags[0] ? tags[0] + ' · 旅居好房' : '旅居好房'}</div>
        <div className="bs">
          {(p.managed_unit_count ? '在管房源 ' + p.managed_unit_count + ' 套 · ' : '') + (p.address || '')}
        </div>
        <div className="tagline">
          {(tags.length ? tags : ['在架']).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </div>

      {facilities.length ? (
        <div className="pd-block core-facilities">
          <div className="core-hd">
            <div className="bt">热门设施</div>
            <div className="bs">{profileU?.name || ''}</div>
            <button
              type="button"
              className="core-more"
              onClick={() => scrollTo('dFacilitiesBlock', 'facilities')}
            >
              房型详情 ›
            </button>
          </div>
          <div className="facility-grid">
            {facilities.slice(0, 5).map((f) => (
              <div className="facility-item" key={f.key}>
                <span className="fi">
                  {f.icon ? <img src={f.icon} alt="" width="16" height="16" /> : <span aria-hidden>·</span>}
                </span>
                <span className="fn">{f.label}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {navItems.length > 1 ? (
        <nav className="section-nav" aria-label="房源详情分区">
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={sec === item.id ? 'on' : ''}
              aria-current={sec === item.id ? 'true' : undefined}
              onClick={() => scrollTo(item.target, item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="pd-block section-anchor" id="dUnitsBlock">
        <div className="bt">可预订房型</div>
        {bookable ? (
          <button type="button" className="datebar" onClick={() => setCalOpen(true)}>
            <div className="ds">
              <small>入住</small>
              <b className={ciD ? '' : 'ph'}>{ciD ? md(ciD) : '请选择'}</b>
            </div>
            <div className="mid">
              <b>{n ? '共 ' + n + ' 晚' : '— 晚'}</b>
            </div>
            <div className="ds">
              <small>离店</small>
              <b className={coD ? '' : 'ph'}>{coD ? md(coD) : '请选择'}</b>
            </div>
            <span className="ar">›</span>
          </button>
        ) : null}

        {units.length === 0 ? (
          <div className="units-empty">该项目暂无户型明细</div>
        ) : (
          units.map((u, i) => {
            const per = unitNight(u);
            const map = rangeCache[u.id] || {};
            const r = n ? sumRange(nightsBetween(checkin, checkout), map, per) : null;
            const sel = bookable && u.id === selUnit;
            let right;
            if (!bookable) {
              right = (
                <div className="rp">
                  <b>¥{formatPrice(u.rent_monthly || per)}</b>
                  <small>{p.channel === 'minsu' ? '/晚' : '/月起'}</small>
                </div>
              );
            } else {
              right = (
                <>
                  <div className="rp">
                    <b>¥{formatPrice(per)}</b>
                    <small>/晚均</small>
                  </div>
                  {!n ? (
                    <div className="rt">选日期看总价</div>
                  ) : r?.blocked ? (
                    <div className="rt est">该时段含已订</div>
                  ) : (
                    <div className={'rt' + (r?.est ? ' est' : '')}>
                      {(r?.est ? '约 ¥' : '¥') + formatPrice(r?.total) + ' · ' + n + '晚'}
                    </div>
                  )}
                  <span className={'rbtn' + (r?.blocked ? ' full' : '')}>{r?.blocked ? '满' : '订'}</span>
                </>
              );
            }
            return (
              <div
                key={u.id}
                className={'roomcard' + (sel ? ' sel' : '')}
                onClick={() => {
                  if (bookable) selectUnit(u.id);
                  setProfileUnit(u.id);
                }}
              >
                <div
                  className={'rth' + (u.cover_image ? '' : ' g' + ((i % 6) + 1))}
                  style={
                    u.cover_image ? { backgroundImage: `url(${assetUrl(u.cover_image)})` } : undefined
                  }
                />
                <div className="rin">
                  <div className="rnm">{u.name}</div>
                  <div className="rmeta">
                    {[u.area_sqm ? u.area_sqm + '㎡' : '', u.layout_label].filter(Boolean).join(' · ')}
                  </div>
                  {u.cancel_policy_text ? (
                    <div className="rmeta cancel">
                      <img
                        className="ic-timer"
                        src="/assets/lvju/icons/booking-timer.png"
                        alt=""
                        width="12"
                        height="12"
                      />
                      {u.cancel_policy_text}
                    </div>
                  ) : null}
                  <div className="rtags">
                    {asArr(u.tags)
                      .slice(0, 3)
                      .map((t) => (
                        <span key={t}>{t}</span>
                      ))}
                  </div>
                </div>
                <div
                  className="rbuy"
                  onClick={(e) => {
                    if (!bookable) return;
                    e.stopPropagation();
                    goBooking(u.id);
                  }}
                >
                  {right}
                </div>
              </div>
            );
          })
        )}
        <div className="units-note">
          {bookable
            ? txLabels + ' · 总价按逐晚实价合计 · 连住 ' + minNights + ' 晚起 · 已订 / 关房不可选'
            : '该项目未配置可用交易方式 · 价格仅供参考 · 请电话咨询'}
        </div>
      </div>

      {hasFacilities && profileU ? (
        <>
          <div className="pd-block section-anchor" id="dFacilitiesBlock">
            <div className="room-intro-head">
              <div className="rh-copy">
                <div className="bt">房型介绍</div>
                <div className="bs">空间、入住规则与床型信息由商家按房型维护</div>
              </div>
              <span className="room-position">
                {units.indexOf(profileU) + 1} / {units.length}
              </span>
            </div>
            {units.length > 1 ? (
              <div className="room-tabs-wrap">
                <div className="room-tabs" role="tablist">
                  {units.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      role="tab"
                      className={u.id === profileU.id ? 'on' : ''}
                      onClick={() => {
                        setProfileUnit(u.id);
                        if (bookable) selectUnit(u.id);
                      }}
                    >
                      {u.name}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {profile.introduction ? <p className="room-copy">{profile.introduction}</p> : null}
            {facts.length ? (
              <div className="room-facts">
                {facts.map(([k, v]) => (
                  <div className="room-fact" key={k}>
                    <span className="fk">{k}</span>
                    <span className="fv">{v}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="bs" style={{ marginTop: 8 }}>
                商家暂未完善该房型档案
              </div>
            )}
          </div>
          {profile.feature_image ? (
            <figure className="room-showcase">
              <img src={assetUrl(profile.feature_image)} alt={profile.feature_image_caption || profileU.name} />
              {profile.feature_image_caption ? (
                <figcaption>{profile.feature_image_caption}</figcaption>
              ) : null}
            </figure>
          ) : null}
        </>
      ) : null}

      <div className="pd-block" id="dRatingBlock">
        <div className="bt">{p.channel === 'minsu' ? '旅居彩贝评价 · 5 维' : '好房子评价 · 4 维'}</div>
        <div className="bs">{p.channel === 'minsu' ? '按旅居住宿维度评定' : '按好房子维度评定'}</div>
        <div className="rate-rows">
          {st === 'passed' && rating.dims && dimsDef.length ? (
            <>
              {dimsDef.map((d) => {
                const v = +rating.dims[d.k] || 0;
                return (
                  <div className="rate-row" key={d.k}>
                    <span className="k">{d.l}</span>
                    <span className="bar">
                      <i style={{ width: Math.round((v / 5) * 100) + '%' }} />
                    </span>
                    <span className="v">{v.toFixed(1)}</span>
                  </div>
                );
              })}
              <div className="bs" style={{ marginTop: 8 }}>
                综合 <b>{rating.score || '—'}</b> 分 · 评定编号 <b>{rating.code || '—'}</b>
              </div>
            </>
          ) : st === 'pending' ? (
            <div className="bs" style={{ marginTop: 8 }}>
              评级已提交，中台复核中
            </div>
          ) : (
            <div className="bs" style={{ marginTop: 8 }}>
              该项目尚未完成评级自评
            </div>
          )}
        </div>
        {st === 'passed' && rating.code ? (
          <div className="verify">
            <div>
              <div className="no">{rating.code}</div>
              <div className="vb">
                <b>✓</b> 平台评级已通过 · 综合 {rating.score || '—'} 分
              </div>
              <div className="vb">
                <a href={`/screens/portal-verify.html?code=${encodeURIComponent(rating.code)}`}>
                  扫码验真 ↗
                </a>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {keeper ? (
        <div className="pd-block" id="dHostBlock">
          <div className="bt">旅居管家</div>
          <div className="host">
            <div
              className="av"
              style={
                keeper.avatar
                  ? { backgroundImage: `url(${assetUrl(keeper.avatar)})`, backgroundSize: 'cover' }
                  : undefined
              }
            >
              {keeper.avatar ? '' : '👤'}
            </div>
            <div>
              <div className="hn">{keeper.name} · 旅居管家</div>
              <div className="hm">
                平台核验 · 咨询 / 入住全程服务
                {keeper.phone ? ' · 电话经虚拟号保护' : ''}
              </div>
            </div>
            {keeper.level ? <span className="lvl">{keeper.level}</span> : null}
          </div>
        </div>
      ) : null}

      {Array.isArray(p.insurance_types) && p.insurance_types.length ? (
        <div className="pd-block">
          <div className="bt">
            入住保障 <span className="bs" style={{ fontWeight: 400 }}>商家已投保 · 扫码验真可查</span>
          </div>
          {p.insurance_types.map((t) => (
            <div className="insrow" key={t.key || t.label}>
              <span className="ig">{t.icon || '🛡'}</span>
              <span className="it">
                <b>{t.label}</b>
                <small>商家已投保，保单以订单详情为准</small>
              </span>
              <span className="ok">✓ 已投保</span>
            </div>
          ))}
        </div>
      ) : null}

      {hasNearby ? (
        <div className="pd-block nearby section-anchor" id="dNearbyBlock">
          <div className="bt" style={{ marginBottom: 2 }}>
            周边玩法 <span className="bs" style={{ fontWeight: 400 }}>按步程与车程编排 · 商家实地整理</span>
          </div>
          <div className="nb-ek">Nearby · Editor&apos;s Picks</div>
          {spots[0] ? (
            <a
              className="nb-feat"
              href={spots[0].link || `/lvju-app-spot-post.html?id=${spots[0].id}`}
            >
              <div
                className="bg"
                style={
                  spots[0].cover_image
                    ? { backgroundImage: `url(${assetUrl(spots[0].cover_image)})` }
                    : undefined
                }
              />
              <span className="lv">
                {SPOT_ICON[spots[0].type] || '📍'} {spots[0].type_label || ''}
              </span>
              <div className="in">
                <span className="ek">封面故事</span>
                <span className="nm">{spots[0].name}</span>
                <span className="sum">{spots[0].summary || ''}</span>
              </div>
            </a>
          ) : null}
          {spots.slice(1).map((s) => (
            <a
              key={s.id}
              className="nb-row"
              href={s.link || `/lvju-app-spot-post.html?id=${s.id}`}
            >
              <div
                className="th"
                style={
                  s.cover_image ? { backgroundImage: `url(${assetUrl(s.cover_image)})` } : undefined
                }
              />
              <div className="tx">
                <span className="k">{s.type_label || ''}</span>
                <span className="nm">{s.name}</span>
                <span className="sum">{s.summary || ''}</span>
              </div>
              <span className="ar">›</span>
            </a>
          ))}
        </div>
      ) : null}

      <div style={{ height: 14 }} />

      <div className="pd-cta">
        <div className="p">
          <b>
            {ctaPrice.text}
            {ctaPrice.sub === '起' ? <small> 起</small> : null}
          </b>
          <span>{ctaPrice.sub === '起' ? '' : ctaPrice.sub || (bookable ? '选日期看总价' : '面议')}</span>
        </div>
        {bookable ? (
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (checkin && checkout) goBooking(selUnit);
              else {
                scrollTo('dUnitsBlock', 'units');
                const bar = document.querySelector('.datebar');
                if (bar) {
                  bar.classList.remove('flash');
                  void bar.offsetWidth;
                  bar.classList.add('flash');
                }
              }
            }}
          >
            {checkin && checkout ? '去预订' : '查看房型'}
          </button>
        ) : (
          <button type="button" className="btn" onClick={callPhone} disabled={calling}>
            {calling ? '获取专线…' : '电话咨询'}
          </button>
        )}
      </div>

      <CalSheet
        open={calOpen}
        onClose={() => setCalOpen(false)}
        projectId={Number(id)}
        unitId={selUnit}
        unitIds={unitIds}
        minNights={minNights}
        basePrice={basePrice}
        checkin={checkin}
        checkout={checkout}
        onConfirm={onCalConfirm}
      />
    </div>
  );
}
