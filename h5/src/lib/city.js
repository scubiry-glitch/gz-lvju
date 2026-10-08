/** 与 screens/_jzapi.js CITY_TREE 同口径（旅居首页城市切换） */
export const CITY_TREE = [
  { prov: '辽宁', cities: ['沈阳', '大连', '鞍山', '抚顺', '本溪', '丹东', '锦州', '营口'] },
  { prov: '江苏', cities: ['南京', '苏州', '无锡', '常州', '镇江', '扬州', '泰州', '南通', '盐城', '徐州'] },
  { prov: '四川', cities: ['成都', '绵阳', '德阳', '南充', '宜宾', '自贡', '泸州', '乐山'] },
  { prov: '贵州', cities: ['贵阳', '遵义', '六盘水', '安顺', '毕节', '铜仁'] },
];

const CITY_KEY = 'bzf_jz_city';
/** 旅居首页默认（与 lvju-app-home-demo 一致） */
export const HOME_DEFAULT_CITY = '贵阳';

export function regionProvinces() {
  return CITY_TREE.map((n) => n.prov);
}

export function citiesOf(prov) {
  const n = CITY_TREE.find((x) => x.prov === prov);
  return n ? n.cities.slice() : [];
}

export function provinceOf(loc) {
  for (const n of CITY_TREE) {
    if (n.prov === loc || n.cities.includes(loc)) return n.prov;
  }
  return null;
}

export function readStoredCity() {
  try {
    return localStorage.getItem(CITY_KEY) || '';
  } catch {
    return '';
  }
}

export function writeStoredCity(city) {
  try {
    localStorage.setItem(CITY_KEY, city);
  } catch {
    /* ignore */
  }
}

export function resolveHomeCity() {
  try {
    const q = new URLSearchParams(location.search).get('city');
    if (q) return q;
  } catch {
    /* ignore */
  }
  return readStoredCity() || HOME_DEFAULT_CITY;
}

export function syncCityToUrl(city) {
  try {
    const p = new URLSearchParams(location.search);
    p.set('city', city);
    history.replaceState(null, '', location.pathname + '?' + p.toString());
  } catch {
    /* ignore */
  }
}
