/** H5 首页「找房·全频道」与找房类型条共用。tab 对齐 catalog.city.hidden_home_tabs；旅居不是首页 tab。 */

export const HOME_CHANNELS = [
  { id: 'lvju', label: '旅居', hint: '短住·候鸟·康养', tab: null, path: '/lvju', icon: '/assets/lvju/icons/chan-lvju.png?v=14', badge: '新' },
  { id: 'minsu', label: '民宿', hint: '整栋·庭院·管家', tab: 'minsu', path: '/minsu', icon: '/assets/lvju/icons/chan-minsu.png?v=15' },
  { id: 'changzu', label: '长租', hint: '整租·合租·月付', tab: 'rental', path: '/changzu', icon: '/assets/lvju/icons/chan-changzu.png?v=14', badge: '新' },
  { id: 'newhouse', label: '新房', hint: '楼盘·特价房', tab: 'newhouse', path: '/search', seg: 'newhouse', emoji: '🏢' },
  { id: 'resale', label: '二手', hint: '在售·真房源', tab: 'resale', path: '/search', seg: 'resale', emoji: '🔑' },
];

export const SEARCH_SEGS = [
  { id: 'all', label: '推荐', kind: 'mixed' },
  { id: 'lvju', label: '旅居', kind: 'stay' },
  { id: 'minsu', label: '民宿', kind: 'stay' },
  { id: 'changzu', label: '长租', kind: 'stay' },
  { id: 'newhouse', label: '新房', kind: 'newhouse' },
  { id: 'resale', label: '二手', kind: 'resale' },
];

export function hiddenHomeTabSet(cat) {
  const raw = cat?.city?.hidden_home_tabs;
  return new Set(Array.isArray(raw) ? raw.map(String) : []);
}

/** 隐藏列表为空 = 全部展示。旅居不在 hidden_home_tabs 里。 */
export function channelShown(id, hidden) {
  if (id === 'all' || id === 'lvju') return true;
  const ch = HOME_CHANNELS.find((c) => c.id === id);
  if (!ch?.tab) return true;
  return !hidden.has(ch.tab);
}

/** 推荐只含仍展示的频道。带「旅居」标签的 rental/minsu 归旅居。 */
export function inShownChannels(p, hidden) {
  const tags = p.tags || [];
  if ((p.channel === 'rental' || p.channel === 'minsu') && tags.includes('旅居')) return true;
  if (p.channel === 'minsu') return channelShown('minsu', hidden);
  if (p.channel === 'rental') return channelShown('changzu', hidden);
  if (p.channel === 'newhouse') return channelShown('newhouse', hidden);
  if (p.channel === 'resale') return channelShown('resale', hidden);
  return false;
}

export function channelHref(ch, city) {
  const q = new URLSearchParams();
  if (city) q.set('city', city);
  if (ch.seg) q.set('seg', ch.seg);
  const qs = q.toString();
  return ch.path + (qs ? `?${qs}` : '');
}
