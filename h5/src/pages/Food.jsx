import { useMemo, useState } from 'react';
import '../styles/channel.css';

const FILT = ['全部', '酸汤鱼', '牛瘪', '小吃', '夜市', '特色餐厅'];
const FOODS = [
  {
    id: 1,
    name: '老凯里酸汤鱼',
    rate: '★ 4.8 · 人均 ¥78',
    meta: '贵阳 · 苗侗酸汤 · 红酸汤底招牌',
    tags: ['必点酸汤鱼', '本地老店'],
    rk: 'NO.1',
    img: '/assets/lvju/food-sourfish.jpg',
    cats: ['酸汤鱼', '特色餐厅'],
  },
  {
    id: 2,
    name: '苗家长桌宴',
    rate: '★ 4.7 · 人均 ¥120',
    meta: '黔东南 · 西江 · 高山流水拦门酒',
    tags: ['民俗体验', '适合多人'],
    rk: 'NO.2',
    img: '/assets/lvju/food-banquet.jpg',
    cats: ['特色餐厅'],
  },
  {
    id: 3,
    name: '花溪牛肉粉',
    rate: '★ 4.6 · 人均 ¥18',
    meta: '贵阳 · 花溪 · 清汤红汤皆可',
    tags: ['平价早餐', '排队店'],
    rk: 'NO.3',
    img: '/assets/lvju/food-noodle.jpg',
    cats: ['小吃'],
  },
  {
    id: 4,
    name: '丝娃娃 · 肠旺面',
    rate: '★ 4.6 · 人均 ¥25',
    meta: '贵阳 · 老街夜市 · 街头小吃组合',
    tags: ['夜市必逛', '多家可选'],
    rk: '小吃',
    img: '/assets/lvju/food-snack.jpg',
    cats: ['小吃', '夜市'],
  },
];

export default function Food() {
  const [filt, setFilt] = useState('全部');
  const [lic, setLic] = useState(false);
  const list = useMemo(
    () => (filt === '全部' ? FOODS : FOODS.filter((f) => f.cats.includes(filt) || f.name.includes(filt))),
    [filt],
  );

  return (
    <div className="chan-page">
      <div className="hero-sm food">
        <div className="bg" />
        <div className="in">
          <div className="ek">Local Flavors</div>
          <h1>
            酸汤滚沸
            <br />
            是贵州的乡愁
          </h1>
          <p>本地人推荐的味道，从苗家长桌到街角粉摊</p>
        </div>
      </div>

      <div className="filt">
        {FILT.map((f) => (
          <a
            key={f}
            href={'#f-' + f}
            className={filt === f ? 'on' : undefined}
            onClick={(e) => {
              e.preventDefault();
              setFilt(f);
            }}
          >
            {f}
          </a>
        ))}
      </div>

      <div className="sec-h">
        <span className="bar" />
        <h2>必吃榜</h2>
        <span className="more">人气排序 ›</span>
      </div>
      <div className="wrap">
        {list.map((f) => (
          <div key={f.id} className="food">
            <div className="th" style={{ backgroundImage: `url(${f.img})` }}>
              <span className="rk">{f.rk}</span>
            </div>
            <div className="info">
              <div className="nm">{f.name}</div>
              <div className="rate">{f.rate}</div>
              <div className="meta">{f.meta}</div>
              <div className="tags">
                {f.tags.map((t) => (
                  <span key={t}>{t}</span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="svc-foot">
        平台旅居产品服务由
        <button type="button" onClick={() => setLic(true)}>
          贝壳智造（北京）科技有限公司
        </button>
        提供
      </div>

      {lic ? (
        <div className="lic-mask" onClick={(e) => e.target === e.currentTarget && setLic(false)}>
          <div className="lic-panel">
            <button type="button" className="lic-x" onClick={() => setLic(false)} aria-label="关闭">
              ✕
            </button>
            <img src="/assets/lvju/biz-license-beike-zhizao.jpg" alt="贝壳智造（北京）科技有限公司营业执照" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
