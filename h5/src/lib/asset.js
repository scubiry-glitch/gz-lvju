/** 把接口下发的相对路径收成站点根绝对路径，并对路径段做 encode（中文文件名） */
export function assetUrl(u) {
  if (!u) return '';
  const s = String(u).trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  if (s.startsWith('//')) return s;
  const path = s.startsWith('/') ? s : '/' + s.replace(/^\.\//, '');
  return path
    .split('/')
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(decodeURIComponent(seg))))
    .join('/');
}
