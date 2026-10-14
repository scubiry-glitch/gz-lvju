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

function bootVConsole() {
  try {
    if (!window.__vc && window.VConsole) window.__vc = new window.VConsole();
    return !!window.__vc;
  } catch {
    return false;
  }
}

/**
 * 加载并实例化 vConsole；不需要或已就绪时立刻 resolve。
 * 调用方应 await 后再挂 React，避免进站日志落在控制台出现之前。
 */
export function initVConsole() {
  /* 临时关闭：不加载 vConsole。恢复时删掉下一行 return，并取消下方注释。 */
  return Promise.resolve(false);
  // if (!wantVConsole()) return Promise.resolve(false);
  // if (window.__vc) return Promise.resolve(true);
  //
  // return new Promise((resolve) => {
  //   let settled = false;
  //   const done = (ok) => {
  //     if (settled) return;
  //     settled = true;
  //     resolve(!!ok);
  //   };
  //
  //   const s = document.createElement('script');
  //   s.src = 'https://cdn.bootcdn.net/ajax/libs/vConsole/3.15.1/vconsole.min.js';
  //   s.onload = () => done(bootVConsole());
  //   s.onerror = () => {
  //     const s2 = document.createElement('script');
  //     s2.src = 'https://unpkg.com/vconsole@3.15.1/dist/vconsole.min.js';
  //     s2.onload = () => done(bootVConsole());
  //     s2.onerror = () => done(false);
  //     document.head.appendChild(s2);
  //   };
  //   document.head.appendChild(s);
  //   setTimeout(() => done(bootVConsole()), 5000);
  // });
}
