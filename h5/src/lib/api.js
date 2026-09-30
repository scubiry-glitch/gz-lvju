import { authHeaders } from './auth.js';

export async function api(path, opts = {}) {
  const headers = authHeaders({
    Accept: 'application/json',
    ...(opts.body && !(opts.body instanceof FormData)
      ? { 'Content-Type': 'application/json' }
      : {}),
    ...(opts.headers || {}),
  });
  const res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || res.statusText || '请求失败');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function catalog(params = {}) {
  const q = new URLSearchParams(params).toString();
  return api('/api/juzhu/catalog' + (q ? '?' + q : ''));
}

export function spots(params = {}) {
  const q = new URLSearchParams(params).toString();
  return api('/api/juzhu/spots' + (q ? '?' + q : ''));
}

export function spot(id) {
  return api('/api/juzhu/spots/' + encodeURIComponent(id));
}

export function routes(params = {}) {
  const q = new URLSearchParams(params).toString();
  return api('/api/juzhu/routes' + (q ? '?' + q : ''));
}

export function project(id) {
  return api('/api/juzhu/projects/' + encodeURIComponent(id));
}

export function projectUnits(id) {
  return api('/api/juzhu/projects/' + encodeURIComponent(id) + '/units');
}

export function stayCalendar(id, { month, unitId, units } = {}) {
  const q = new URLSearchParams();
  if (month) q.set('month', month);
  if (unitId) q.set('unit_id', String(unitId));
  if (units && units.length) q.set('units', units.join(','));
  const qs = q.toString();
  return api('/api/juzhu/projects/' + encodeURIComponent(id) + '/stay-calendar' + (qs ? '?' + qs : ''));
}

export function createBooking(body) {
  return api('/api/juzhu/booking', { method: 'POST', body: JSON.stringify(body) });
}

export function bookingPay(body) {
  return api('/api/juzhu/booking/pay', { method: 'POST', body: JSON.stringify(body) });
}

export function bookingLookup(body) {
  return api('/api/juzhu/booking/lookup', { method: 'POST', body: JSON.stringify(body) });
}

export function bookingContacts() {
  return api('/api/juzhu/booking/contacts');
}

export function saveBookingContact(body) {
  return api('/api/juzhu/booking/contacts', { method: 'POST', body: JSON.stringify(body) });
}

export function authMe() {
  return api('/api/auth/me');
}

export function virtualPhone(id) {
  return api('/api/juzhu/projects/' + encodeURIComponent(id) + '/virtual-phone');
}

export function myBookings() {
  return api('/api/juzhu/booking/my');
}

export function topics() {
  return api('/api/juzhu/topics');
}

export function cancelBooking(body) {
  return api('/api/juzhu/booking/cancel', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function tenantLogin(phone, password) {
  return api('/api/juzhu/auth/tenant', {
    method: 'POST',
    body: JSON.stringify({ phone, password }),
  });
}

/** 精选好房：与 lvju-app-home-demo 同口径 */
export function pickFeaturedProjects(cat) {
  const dmap = {};
  (cat.districts || []).forEach((d) => {
    dmap[d.id] = d;
  });
  const eligible = (cat.projects || []).filter((p) => p.channel === 'rental' || p.channel === 'minsu');
  const tagsOf = (p) => (Array.isArray(p.tags) ? p.tags : []);
  const priority = (p) => {
    if (p.is_featured === 1) return 0;
    if (tagsOf(p).includes('旅居')) return 1;
    if (p.channel === 'minsu') return 2;
    return 3;
  };
  const curated = eligible
    .filter((p) => {
      const tags = tagsOf(p);
      return !tags.includes('保租房') && !tags.includes('演示');
    })
    .sort(
      (a, b) =>
        priority(a) - priority(b) ||
        (a.featured_rank || 999) - (b.featured_rank || 999) ||
        (a.sort_order || 999) - (b.sort_order || 999),
    );
  const src = curated.slice(0, 2);
  if (src.length < 2) {
    const used = {};
    src.forEach((p) => {
      used[p.id] = true;
    });
    for (const p of eligible) {
      if (!used[p.id]) {
        src.push(p);
        used[p.id] = true;
      }
      if (src.length === 2) break;
    }
  }
  return { projects: src, dmap };
}
