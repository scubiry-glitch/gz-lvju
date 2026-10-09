import { useState } from 'react';
import { Link } from 'react-router-dom';
import { maskPhone } from '../lib/auth.js';
import { useAuthUser } from '../lib/auth-context.jsx';
import { featureEnabled } from '../lib/features.js';
import '../styles/me.css';

const CAIBEI = featureEnabled('caibei');
const DEFAULT_400 = '400-900-6688';

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
  const { user, ready } = useAuthUser();
  const name = (user && (user.display_name || user.login_name)) || '';
  const phoneLine =
    (user && (user.phone_masked || (user.phone ? maskPhone(user.phone) : ''))) || '';
  const showProfile = ready && !!user;
  const [sheet, setSheet] = useState(null); // '400' | null
  const [hotline] = useState(() => get400());

  function closeSheet() {
    setSheet(null);
  }

  return (
    <div className="me-page">
      <div className="me-hd">
        <div className="bg" />
        {showProfile ? (
          <div className="u">
            <div className="av" id="meAv" aria-hidden>
              <img src="/assets/lvju/me-avatar.png" alt="" />
            </div>
            <div className="ui" id="meUi">
              <div className="nm">{name}</div>
              <div className="ph">{phoneLine}</div>
            </div>
          </div>
        ) : null}
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
            <Link className="menu-row" to="/rating-standard">
              <span className="left">
                <span className="ic">
                  <img src="/assets/lvju/icons/me-menu-star.svg" alt="" />
                </span>
                <span className="ttl">旅居星级评价体系</span>
              </span>
              <span className="right">
                <Chevron />
              </span>
            </Link>
          ) : null}
        </div>
      </div>

      {sheet === '400' ? (
        <div
          className="me-mask"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) closeSheet();
          }}
        >
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
        </div>
      ) : null}
    </div>
  );
}
