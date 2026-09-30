import '../styles/channel.css';

const SVCS = [
  { icon: '/assets/lvju/icons/conv-charter.png', title: '包车出行', sub: '持证司导' },
  { icon: '/assets/lvju/icons/conv-guide.png', title: '本地向导', sub: '认证向导' },
  { icon: '/assets/lvju/icons/conv-ticket.png', title: '门票预订', sub: '免排队' },
  { icon: '/assets/lvju/icons/conv-luggage.png', title: '行李寄存', sub: '就近网点' },
  { icon: '/assets/lvju/icons/conv-weather.png', title: '天气预报', sub: '景区实况' },
  { icon: '/assets/lvju/icons/conv-medical.png', title: '医疗急救', sub: '就近医院' },
  { icon: '/assets/lvju/icons/conv-translate.png', title: '翻译助手', sub: '方言/外语' },
  { icon: '/assets/lvju/icons/conv-charge.png', title: '充电租赁', sub: '共享充电' },
];

export default function Convenience() {
  return (
    <div className="chan-page">
      <div className="hero-sm conv">
        <div className="bg" />
        <div className="in">
          <div className="ek">Travel Helpers</div>
          <h1>
            出门在外
            <br />
            有人接得住
          </h1>
          <p>出行、向导、票务、寄存、急救，旅居在贵州的一整套便民服务</p>
        </div>
      </div>

      <div className="sec-h">
        <span className="bar" />
        <h2>便民服务</h2>
      </div>
      <div className="conv-svc">
        <div className="conv-svc-grid">
          {SVCS.map((s) => (
            <a key={s.title} className="conv-tile" href="#" onClick={(e) => e.preventDefault()}>
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
        <h2>黔东南 · 今日实况</h2>
      </div>
      <div className="panel">
        <div className="kv">
          <span className="k">天气 · 西江</span>
          <span className="v">⛅ 多云 22℃ / 16℃</span>
        </div>
        <div className="kv">
          <span className="k">景区人流</span>
          <span className="v">🟢 舒适 · 适宜出行</span>
        </div>
        <div className="kv">
          <span className="k">空气质量</span>
          <span className="v">优 · AQI 38</span>
        </div>
      </div>

      <a className="banner" href="tel:12301">
        <span className="bi">
          <img src="/assets/lvju/icons/guide-bi.png" alt="" />
        </span>
        <div className="bt">
          <b>贵州旅居服务热线</b>
          <p>12301 · 投诉举报 / 咨询求助 7×24h</p>
        </div>
        <span className="go">一键拨打 ›</span>
      </a>
    </div>
  );
}
