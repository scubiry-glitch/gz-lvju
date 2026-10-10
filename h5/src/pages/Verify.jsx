import { Link, useNavigate, useSearchParams } from 'react-router-dom';

/** 评级编号验真（原 screens/portal-verify 入口在详情页的评级码） */
export default function Verify() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const code = (sp.get('code') || '').trim();

  return (
    <div style={{ minHeight: '100%', background: 'var(--page)', padding: '24px 16px 40px' }}>
      <button
        type="button"
        onClick={() => (history.length > 1 ? navigate(-1) : navigate('/'))}
        style={{
          border: 0,
          background: 'none',
          padding: 0,
          font: 'inherit',
          fontSize: 13,
          color: 'var(--brand-deep)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        ← 返回
      </button>
      <div
        style={{
          marginTop: 16,
          borderRadius: 16,
          padding: '28px 20px',
          color: '#fff',
          background: 'linear-gradient(135deg, #064e3b 0%, #115e59 60%, #14b8a6 100%)',
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.85 }}>平台评级 · 扫码验真</div>
        <h1 style={{ margin: '10px 0 0', fontSize: 22, fontWeight: 700 }}>
          {code ? '评级编号有效入口' : '缺少评级编号'}
        </h1>
        {code ? (
          <div
            style={{
              marginTop: 14,
              display: 'inline-block',
              padding: '8px 14px',
              borderRadius: 999,
              background: 'rgba(255,255,255,.18)',
              fontFamily: 'ui-monospace, monospace',
              fontWeight: 700,
              letterSpacing: 0.04,
            }}
          >
            {code}
          </div>
        ) : null}
        <p style={{ margin: '14px 0 0', fontSize: 13, lineHeight: 1.55, opacity: 0.9 }}>
          本编号由服务认证中台评定并公示。请以房源详情页展示的评级状态与维度得分为准。
        </p>
      </div>
      <div style={{ marginTop: 16, background: '#fff', border: '1px solid var(--border)', borderRadius: 14, padding: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>
          若需了解评定维度与星级口径，可查看
          <Link to="/rating-standard" style={{ color: 'var(--brand)', fontWeight: 600, marginLeft: 4 }}>
            旅居星级评价体系 →
          </Link>
        </div>
      </div>
    </div>
  );
}
