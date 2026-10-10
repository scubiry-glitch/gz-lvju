import { useSearchParams } from 'react-router-dom';
import HtmlFrame from './HtmlFrame.jsx';

export default function Vouchers() {
  const [sp] = useSearchParams();
  const q = new URLSearchParams();
  for (const k of ['city', 'kind', 'category']) {
    const v = sp.get(k);
    if (v) q.set(k, v);
  }
  const qs = q.toString();
  return <HtmlFrame title="门票券" src={'/juzhu-vouchers.html' + (qs ? '?' + qs : '')} />;
}
