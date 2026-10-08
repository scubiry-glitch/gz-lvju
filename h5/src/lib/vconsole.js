/** 测试环境挂 vConsole；生产不加载。强制：?vconsole=1 或 localStorage VCONSOLE=1 */

function wantVConsole() {
  try {
    const q = new URLSearchParams(location.search);
    if (q.get('vconsole') === '1' || q.get('vconsole') === 'true') return true;
    if (localStorage.getItem('VCONSOLE') === '1') return true;
  } catch {
    /* ignore */
  }
  const h = location.hostname || '';
  if (/^(localhost|127\.0\.0\.1)$/i.test(h)) return true;
  if (/\.test\.ke\.com$/i.test(h) || /\.tt[abc]\.test\.ke\.com$/i.test(h)) return true;
  if (/\.meizu\.life$/i.test(h)) return true; // sytest 等演示域
  return false;
}

export function initVConsole() {
  if (!wantVConsole() || window.__vc) return;
  const s = document.createElement('script');
  s.src = 'https://cdn.bootcdn.net/ajax/libs/vConsole/3.15.1/vconsole.min.js';
  s.onload = () => {
    try {
      window.__vc = new window.VConsole();
    } catch {
      /* ignore */
    }
  };
  s.onerror = () => {
    const s2 = document.createElement('script');
    s2.src = 'https://unpkg.com/vconsole@3.15.1/dist/vconsole.min.js';
    s2.onload = () => {
      try {
        window.__vc = new window.VConsole();
      } catch {
        /* ignore */
      }
    };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s);
}
