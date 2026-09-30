import { useEffect, useState } from 'react';
import { useAuthUser } from '../lib/auth-context.jsx';

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

/** 壳层已登录后弹一次隐私协议；不再自己打 /auth/beike */
export default function PrivacyGate() {
  const { ready, user } = useAuthUser();
  const [show, setShow] = useState(false);
  const [acct, setAcct] = useState(null);

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      setShow(false);
      setAcct(null);
      return;
    }
    const a = {
      id: user.id || '',
      uid: user.id || '',
      display_name: user.display_name || '',
    };
    setAcct(a);
    setShow(!agreed(a));
  }, [ready, user]);

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
