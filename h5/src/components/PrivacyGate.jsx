import { useEffect, useState } from 'react';
import { ensureBeikeSession, getLianjiaToken } from '../lib/auth.js';

const PRIV_VER = 'v1';

function uidKey(acct) {
  const id = (acct && (acct.uid || acct.id)) || '';
  return 'bzf_lvju_privacy_' + PRIV_VER + (id ? ':' + id : '');
}

function agreed(acct) {
  try {
    return !!localStorage.getItem(uidKey(acct));
  } catch {
    return false;
  }
}

function markAgreed(acct) {
  try {
    localStorage.setItem(uidKey(acct), String(Date.now()));
  } catch {
    /* ignore */
  }
}

function exitChannel() {
  try {
    if (window.JsBridgeV3 && typeof window.JsBridgeV3.closeWeb === 'function') {
      window.JsBridgeV3.closeWeb({});
      return;
    }
  } catch {
    /* ignore */
  }
  try {
    if (window.$ljBridge && typeof window.$ljBridge.closeWeb === 'function') {
      window.$ljBridge.closeWeb();
      return;
    }
  } catch {
    /* ignore */
  }
  if (history.length > 1) history.back();
  else location.replace('about:blank');
}

/** 登录验票成功后弹一次隐私协议（与 home-demo 同口径） */
export default function PrivacyGate() {
  const [show, setShow] = useState(false);
  const [acct, setAcct] = useState(null);

  useEffect(() => {
    let alive = true;
    async function boot() {
      if (!getLianjiaToken()) {
        if (alive) setShow(false);
        return;
      }
      const j = await ensureBeikeSession();
      if (!alive) return;
      if (!(j && j.ok)) {
        setShow(false);
        return;
      }
      const a = { id: j.uid || '', uid: j.uid || '', display_name: j.display_name || '' };
      setAcct(a);
      setShow(!agreed(a));
    }
    boot();
    const onShow = () => boot();
    window.addEventListener('pageshow', onShow);
    return () => {
      alive = false;
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  if (!show) return null;

  return (
    <div className="priv-mask" role="presentation">
      <div className="priv-card" role="dialog" aria-labelledby="privTitle" aria-modal="true">
        <h3 id="privTitle">用户隐私保护提示</h3>
        <div className="body">
          欢迎使用贝壳旅居频道。为向您提供找房、预订与客服等服务，我们需要收集、使用必要的账号与设备信息。详情请阅读
          <a href="/lvju-app-privacy.html">《隐私政策》</a>与
          <a href="/lvju-app-terms.html">《用户服务协议》</a>。
          点击「同意」即表示您已阅读并同意相关条款；若不同意，将退出本频道。
        </div>
        <div className="priv-acts">
          <button type="button" className="no" onClick={() => exitChannel()}>
            不同意
          </button>
          <button
            type="button"
            className="yes"
            onClick={() => {
              markAgreed(acct);
              setShow(false);
            }}
          >
            同意
          </button>
        </div>
      </div>
    </div>
  );
}
