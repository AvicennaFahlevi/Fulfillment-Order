import type { OrderStatus, Recording } from '../types';
export const orderLabels: Record<OrderStatus, string> = { NEW: 'Menunggu picking', READY: 'Siap packing', PACKING: 'Sedang packing', PACKED: 'Selesai' };
export function OrderBadge({ status }: { status: OrderStatus }) { return <span className={`badge status-${status.toLowerCase()}`}><span className="status-dot" />{orderLabels[status] || status}</span>; }
export function RecordingBadge({ status }: { status: Recording['status'] }) { const labels = { RECORDING: 'Merekam', SAVED: 'Tersimpan', INTERRUPTED: 'Terputus', FAILED: 'Dibatalkan' }; return <span className={`badge recording-${status.toLowerCase()}`}><span className="status-dot" />{labels[status]}</span>; }
export const dateTime = (date: string | null) => date ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) : '—';
export const number = (value: number) => new Intl.NumberFormat('id-ID').format(value);
export function duration(seconds: number) { const count = Math.max(0, Math.floor(seconds)); return `${Math.floor(count / 60).toString().padStart(2, '0')}:${(count % 60).toString().padStart(2, '0')}`; }
