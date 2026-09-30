import { Link } from 'react-router-dom';
import '../styles/channel.css';

const SVCS = [
  { href: '#', icon: '/assets/lvju/icons/guide-tour.png', title: '看房团', sub: '周末发车' },
  { href: '#', icon: '/assets/lvju/icons/guide-loan.png', title: '贷款测算', sub: '月供秒算' },
  { href: '#', icon: '/assets/lvju/icons/guide-advisor.png', title: '1对1顾问', sub: '持证顾问' },
  { href: '#', icon: '/assets/lvju/icons/guide-policy.png', title: '政策解读', sub: '限购/补贴' },
  { href: '#', icon: '/assets/lvju/icons/guide-tax.png', title: '税费计算', sub: '过户明细' },
  { href: '#', icon: '/assets/lvju/icons/guide-escrow.png', title: '签约存管', sub: '资金安全' },
];

export default function Guide() {
  return (
    <div className="chan-page">
      <div className="hero-sm guide">
        <div className="bg" />
        <div className="in">
          <div className="ek">Advisory</div>
          <h1>
            买房这件事
            <br />
            有人替你想周全
          </h1>
          <p>看房团 · 贷款测算 · 1对1顾问 · 签约存管，全程陪跑</p>
        </div>
      </div>

      <div className="sec-h">
        <span className="bar" />
        <h2>导购服务</h2>
      </div>
      <div className="guide-svc">
        <div className="guide-svc-grid">
          {SVCS.map((s) => (
            <a key={s.title} className="guide-tile" href={s.href} onClick={(e) => e.preventDefault()}>
              <span className="ic">
                <img src={s.icon} alt="" />
              </span>
              <b>{s.title}</b>
              <small>{s.sub}</small>
            </a>
          ))}
        </div>
      </div>

      <div className="sec-h">
        <span className="bar" />
        <h2>贷款测算 · 示意</h2>
        <span className="more">重新测算 ›</span>
      </div>
      <div className="panel">
        <div className="kv">
          <span className="k">总价</span>
          <span className="v">¥98 万</span>
        </div>
        <div className="kv">
          <span className="k">首付比例 · 30%</span>
          <span className="v">¥29.4 万</span>
        </div>
        <div className="kv">
          <span className="k">贷款 · 30 年 · 商贷 3.3%</span>
          <span className="v">¥68.6 万</span>
        </div>
        <div className="kv big">
          <span className="k">预估月供</span>
          <span className="v">¥3,004 /月</span>
        </div>
      </div>

      <div className="sec-h">
        <span className="bar" />
        <h2>专属顾问</h2>
      </div>
      <div className="wrap">
        <div className="lrow agent-row">
          <div
            className="th"
            style={{ backgroundImage: 'url(/assets/lvju/icons/agent-avatar.png)' }}
          />
          <div className="info">
            <div className="nm">罗敏 · 资深置业顾问</div>
            <div className="meta">从业 8 年 · 观山湖 / 花溪片区 · 服务 1,200+ 客户</div>
            <div className="tags">
              <span>持证 ✓</span>
              <span>★4.9</span>
              <span>响应快</span>
            </div>
          </div>
        </div>
      </div>

      <Link className="banner" to="/search?seg=newhouse">
        <span className="bi">
          <img src="/assets/lvju/icons/guide-bi.png" alt="" />
        </span>
        <div className="bt">
          <b>看新房 / 二手房源</b>
          <p>边看边问，顾问帮你比对</p>
        </div>
        <span className="go">去看房 ›</span>
      </Link>
    </div>
  );
}
