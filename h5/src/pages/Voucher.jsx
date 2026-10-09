import { useSearchParams } from 'react-router-dom';
import HtmlFrame from './HtmlFrame.jsx';

export default function Voucher() {
  const [sp] = useSearchParams();
  const q = new URLSearchParams();
  for (const k of ['kind', 'id', 'city']) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return <HtmlFrame title="权益详情" src={'/juzhu-voucher.html' + (qs ? '?' + qs : '')} />;
}
