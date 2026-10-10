/** 同源旧 HTML 嵌进 H5 路由，地址栏保持 /h5/* */
export default function HtmlFrame({ src, title = '页面' }) {
  if (!src) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>
        缺少页面地址
      </div>
    );
  }
  return (
    <iframe
      title={title}
      src={src}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        minHeight: '100vh',
        border: 0,
        background: '#fff',
      }}
    />
  );
}
