import { Package } from 'lucide-react';
export default function Brand({ light = false }: { light?: boolean }) {
  return <div className={`brand${light ? ' brand-light' : ''}`}><span className="brand-icon"><Package size={24} strokeWidth={1.8} /></span><span>fulfill<span className="brand-dot">.</span></span></div>;
}
