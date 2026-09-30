import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ensureBeikeSession, maskPhone } from '../lib/auth.js';
import {
  BASE_TYPES,
  CUSTOM_EMOJIS,
  REPAIR_STATUS,
  createRepair,
  customTypes,
  iconOf,
  listRepairs,
  saveCustomType,
} from '../lib/repairs.js';
import { featureEnabled } from '../lib/features.js';
import '../styles/me.css';

const CAIBEI = featureEnabled('caibei');
const ME_PHONE = '138****6688';
const DEFAULT_400 = '400-900-6688';
const OPEN_ST = ['pending', 'dispatched', 'accepted', 'serving'];

function get400() {
  try {
    const u = new URLSearchParams(location.search).get('400');
    if (u) return u;
  } catch {
    /* ignore */
  }
  return DEFAULT_400;
}

function telHref(n) {
  return 'tel:' + String(n).replace(/[^0-9+]/g, '');
}

function Chevron() {
  return (
    <span className="ch">
      <img src="/assets/lvju/icons/me-chevron.svg" alt="" />
    </span>
  );
}

export default function Me() {
  return <MeBody />;
}

function MeBody() {
  const [name, setName] = useState('旅居用户');
  const [phoneLine, setPhoneLine] = useState('已登录');
  const [sheet, setSheet] = useState(null); // 'ticket' | '400' | null
  const [hotline] = useState(() => get400());
  const [ticketTip, setTicketTip] = useState('报修 · 保洁 · 管家');
  const [curType, setCurType] = useState('报修');
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState('');
  const [customIcon, setCustomIcon] = useState(CUSTOM_EMOJIS[0]);
  const [typeTick, setTypeTick] = useState(0);
  const [desc, setDesc] = useState('');
  const [expectTime, setExpectTime] = useState('今天下午');
  const [mine, setMine] = useState(null);
  const [mineErr, setMineErr] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const types = useMemo(() => BASE_TYPES.concat(customTypes().map((c) => c.n)), [typeTick]);

  useEffect(() => {
    ensureBeikeSession().then((j) => {
      if (j && j.ok) {
        setName(j.display_name || j.login_name || '旅居用户');
        setPhoneLine(j.phone_masked || (j.phone ? maskPhone(j.phone) : '已登录'));
      }
    });
  }, []);

  const loadMine = useCallback(() => {
    setMineErr('');
    listRepairs(ME_PHONE)
      .then((all) => {
        setMine(all.slice(0, 10));
        const openN = all.filter((o) => OPEN_ST.includes(o.status)).length;
        setTicketTip(openN ? openN + ' 单进行中' : '报修 · 保洁 · 管家');
      })
      .catch(() => {
        setMine([]);
        setMineErr('工单加载失败（需访问凭据或登录账号）');
      });
  }, []);

  function openTicket() {
    setSheet('ticket');
    setCustomOpen(false);
    loadMine();
  }

  function closeSheet() {
    setSheet(null);
  }

  function addCustom() {
    const n = customName.trim();
    if (!n) return;
    saveCustomType(n, customIcon);
    setCurType(n);
    setCustomOpen(false);
    setCustomName('');
    setTypeTick((t) => t + 1);
  }

  async function submitTicket() {
    if (submitting) return;
    setSubmitting(true);
    try {
      const o = await createRepair({
        type: curType,
        desc: desc.trim() || curType + '服务需求',
        house: '我的旅居 · 贵阳',
        phone: ME_PHONE,
        expectTime,
        source: '旅居客 App · 我的',
      });
      location.href = '/lvju-app-ticket.html?id=' + encodeURIComponent(o.id);
    } catch (err) {
      alert('提交失败：' + (err.message || '未知错误'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="me-page">
      <div className="me-hd">
        <div className="bg" />
        <div className="u">
          <div className="av" id="meAv" aria-hidden>
            <img src="/assets/lvju/me-avatar.png" alt="" />
          </div>
          <div className="ui" id="meUi">
            <div className="nm">{name}</div>
            <div className="ph">{phoneLine}</div>
          </div>
        </div>
      </div>

      <div className="me-sec">
        <div className="me-sec-h">
          <h3>我的订单</h3>
          <Link className="more" to="/orders">
            全部订单
            <Chevron />
          </Link>
        </div>
        <div className="ordbar">
          <Link to="/orders?tab=stay">
            <span className="ic">
              <img src="/assets/lvju/icons/me-ord-stay.png?v=3" alt="" />
            </span>
            待入住
          </Link>
          <Link to="/orders?tab=unpaid">
            <span className="ic">
              <img src="/assets/lvju/icons/me-ord-pay.png?v=3" alt="" />
            </span>
            待支付
          </Link>
          <Link to="/orders?tab=refund">
            <span className="ic">
              <img src="/assets/lvju/icons/me-ord-refund.svg?v=2" alt="" />
            </span>
            退款售后
          </Link>
        </div>
      </div>

      <div className="me-sec" style={{ marginBottom: 20 }}>
        <div className="me-sec-h">
          <h3>常用功能</h3>
        </div>
        <div className="menu-card">
          <button type="button" className="menu-row" onClick={openTicket}>
            <span className="left">
              <span className="ic">
                <img src="/assets/lvju/icons/me-menu-ticket.png?v=3" alt="" />
              </span>
              <span className="ttl">服务工单</span>
            </span>
            <span className="right">
              <span className="tip">{ticketTip}</span>
              <Chevron />
            </span>
          </button>
          <button type="button" className="menu-row" onClick={() => setSheet('400')}>
            <span className="left">
              <span className="ic">
                <img src="/assets/lvju/icons/me-menu-phone.png?v=3" alt="" />
              </span>
              <span className="ttl">400 在线客服</span>
            </span>
            <span className="right">
              <span className="tip">热线 {hotline}</span>
              <Chevron />
            </span>
          </button>
          {CAIBEI ? (
          <a className="menu-row" href="/lvju-rating-standard.html">
            <span className="left">
              <span className="ic">
                <img src="/assets/lvju/icons/me-menu-star.svg" alt="" />
              </span>
              <span className="ttl">旅居星级评价体系</span>
            </span>
            <span className="right">
              <Chevron />
            </span>
          </a>
          ) : null}
        </div>
      </div>

      {sheet ? (
        <div
          className="me-mask"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeSheet();
          }}
        >
          {sheet === 'ticket' ? (
            <div className="me-sheet">
              <h3>
                服务工单
                <button type="button" className="x" onClick={closeSheet} aria-label="关闭">
                  ✕
                </button>
              </h3>
              <div className="lb">
                服务类型 <span style={{ color: '#94a3b8' }}>（点「＋ 自定义」可新增）</span>
              </div>
              <div>
                {types.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={'tchip' + (t === curType ? ' on' : '')}
                    onClick={() => setCurType(t)}
                  >
                    {iconOf(t)} {t}
                  </button>
                ))}
                <button
                  type="button"
                  className="tchip"
                  style={{ borderStyle: 'dashed', color: 'var(--muted)' }}
                  onClick={() => {
                    setCustomOpen(true);
                    setCustomIcon(CUSTOM_EMOJIS[0]);
                    setCustomName('');
                  }}
                >
                  ＋ 自定义
                </button>
              </div>
              {customOpen ? (
                <div className="custom-row">
                  <input
                    type="text"
                    maxLength={8}
                    placeholder="自定义类型名（≤8 字，例：泳池清洁）"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    style={{ marginBottom: 8 }}
                  />
                  <div className="lb" style={{ margin: '2px 0 4px' }}>
                    选个图标
                  </div>
                  <div className="custom-icons">
                    {CUSTOM_EMOJIS.map((e) => (
                      <span key={e} className={e === customIcon ? 'on' : undefined} onClick={() => setCustomIcon(e)}>
                        {e}
                      </span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button type="button" className="go" style={{ margin: 0, flex: 1 }} onClick={addCustom}>
                      添加
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      style={{ margin: 0, flex: '0 0 72px' }}
                      onClick={() => setCustomOpen(false)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="lb">问题描述</div>
              <textarea
                placeholder="例：热水器不出热水，麻烦尽快上门"
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
              />
              <div className="lb">期望上门</div>
              <select value={expectTime} onChange={(e) => setExpectTime(e.target.value)}>
                <option>今天下午</option>
                <option>明天上午</option>
                <option>明天下午</option>
                <option>周末均可</option>
              </select>
              <button type="button" className="go" disabled={submitting} onClick={submitTicket}>
                {submitting ? '提交中…' : '提交工单 · 同步中台派单'}
              </button>
              <div className="lb" style={{ marginTop: 14 }}>
                我的工单 <span style={{ color: '#94a3b8' }}>（点击条目看详情 / 进度 / 评价）</span>
              </div>
              <div>
                {mineErr ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 0' }}>{mineErr}</div>
                ) : mine === null ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 0' }}>加载中…</div>
                ) : mine.length === 0 ? (
                  <div style={{ fontSize: 12, color: 'var(--muted)', padding: '6px 0' }}>
                    暂无工单，提交后实时进入中台工单池
                  </div>
                ) : (
                  mine.map((o) => {
                    const st = REPAIR_STATUS[o.status] || { c: o.status };
                    return (
                      <a key={o.id} className="tk" href={'/lvju-app-ticket.html?id=' + encodeURIComponent(o.id)}>
                        <span className="ic">{iconOf(o.type)}</span>
                        <span className="meta">
                          <b>{o.desc}</b>
                          {o.id} · {o.createdLabel} · 期望 {o.expectTime || '尽快'}
                        </span>
                        <span className={'st st-' + o.status}>{st.c}</span>
                      </a>
                    );
                  })
                )}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 8 }}>
                工单实时进入中台「服务需求 · 工单池」，派单 / 履约状态在此回显。
              </div>
            </div>
          ) : (
            <div className="me-sheet">
              <h3>
                400 在线客服
                <button type="button" className="x" onClick={closeSheet} aria-label="关闭">
                  ✕
                </button>
              </h3>
              <div className="dial">
                <div>
                  <div className="num">{hotline}</div>
                  <div className="sub">旅居服务热线 · 人工客服</div>
                </div>
                <a className="call" href={telHref(hotline)}>
                  立即拨打
                </a>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
