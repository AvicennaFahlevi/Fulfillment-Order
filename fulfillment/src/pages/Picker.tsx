import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Camera, Check, CheckCircle2, ClipboardCheck, LoaderCircle, Package, ScanLine, Search, ShieldCheck, UserRound, X } from 'lucide-react';
import { api, ApiError, json } from '../api';
import { useAuth } from '../auth';
import type { Order } from '../types';
import './picker.css';

type Detector = { detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>> };
type DetectorConstructor = {
  new(options?: { formats: string[] }): Detector;
  getSupportedFormats?: () => Promise<string[]>;
};
const blockedSource = (status: string) => /cancel|batal|unpaid|belum\s*(dibayar|bayar)|menunggu\s*(pembayaran|bayar)|to\s*pay/i.test(status);
const statusNames: Record<Order['status'], string> = { NEW: 'Menunggu picking', READY: 'Siap dikemas', PACKING: 'Sedang dikemas', PACKED: 'Selesai dikemas' };
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

export default function Picker() {
  const { user } = useAuth();
  const [tracking, setTracking] = useState('');
  const [order, setOrder] = useState<Order | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scannerError, setScannerError] = useState('');
  const [cameraReady, setCameraReady] = useState(false);
  const mounted = useRef(true);
  const userId = useRef(user?.id);
  const requestSerial = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const scannerDialog = useRef<HTMLDivElement>(null);
  const closeScannerButton = useRef<HTMLButtonElement>(null);
  const cameraStream = useRef<MediaStream | null>(null);
  const lookupRef = useRef<(value: string) => Promise<void>>(async () => {});
  userId.current = user?.id;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestSerial.current += 1;
      searchAbort.current?.abort();
      cameraStream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  useEffect(() => {
    requestSerial.current += 1;
    searchAbort.current?.abort();
    setOrder(null);
    setChecked([]);
    setTracking('');
    setError('');
    setNotice('');
    setLoading(false);
    setSaving(false);
    setScannerOpen(false);
  }, [user?.id]);

  async function lookup(value: string) {
    const valueToFind = value.trim();
    if (!valueToFind || !userId.current) {
      setError('Masukkan nomor resi terlebih dahulu.');
      input.current?.focus();
      return;
    }
    const serial = ++requestSerial.current;
    const requestUser = userId.current;
    searchAbort.current?.abort();
    const controller = new AbortController();
    searchAbort.current = controller;
    const isCurrent = () => mounted.current && serial === requestSerial.current && requestUser === userId.current;
    setTracking(valueToFind);
    setOrder(null);
    setChecked([]);
    setError('');
    setNotice('');
    setLoading(true);
    setSaving(false);
    try {
      const result = await api<{ order: Order }>(`/api/orders/${encodeURIComponent(valueToFind)}`, { signal: controller.signal });
      if (isCurrent()) setOrder(result.order);
    } catch (err) {
      if (!isCurrent() || (err instanceof Error && err.name === 'AbortError')) return;
      setError(err instanceof ApiError && err.status === 404
        ? 'Resi belum ditemukan. Periksa nomor resi atau minta admin mengimpor pesanan Shopee terlebih dahulu.'
        : errorMessage(err, 'Pesanan belum dapat dimuat. Coba lagi.'));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }
  lookupRef.current = lookup;

  function closeScanner() {
    cameraStream.current?.getTracks().forEach(track => track.stop());
    cameraStream.current = null;
    setScannerOpen(false);
  }

  useEffect(() => {
    if (!scannerOpen || !user?.id) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | null = null;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setScannerError('');
    setCameraReady(false);
    closeScannerButton.current?.focus();
    const stop = () => {
      active = false;
      if (timer) clearTimeout(timer);
      stream?.getTracks().forEach(track => track.stop());
      if (cameraStream.current === stream) cameraStream.current = null;
    };
    const onVisibility = () => {
      if (document.hidden) { stop(); setScannerOpen(false); }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); stop(); setScannerOpen(false); }
      if (event.key === 'Tab') {
        const focusable = scannerDialog.current?.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex="0"]');
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener('keydown', onKey);

    async function startCamera() {
      const Barcode = (window as unknown as { BarcodeDetector?: DetectorConstructor }).BarcodeDetector;
      if (!Barcode) {
        setScannerError('Browser ini belum mendukung pemindaian kamera. Masukkan nomor resi secara manual atau gunakan scanner barcode USB/Bluetooth.');
        return;
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setScannerError('Kamera memerlukan koneksi HTTPS dan izin browser. Nomor resi tetap dapat dimasukkan secara manual.');
        return;
      }
      try {
        const supported = Barcode.getSupportedFormats ? await Barcode.getSupportedFormats() : undefined;
        const detector = new Barcode(supported?.length ? { formats: supported } : undefined);
        if (!active) return;
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        if (!active) { stream.getTracks().forEach(track => track.stop()); return; }
        cameraStream.current = stream;
        if (!video.current) { stop(); return; }
        video.current.srcObject = stream;
        await video.current.play();
        if (!active) return;
        setCameraReady(true);
        const detect = async () => {
          if (!active || !video.current) return;
          try {
            if (video.current.readyState >= 2) {
              const matches = await detector.detect(video.current);
              if (!active) return;
              const match = matches.find(item => item.rawValue.trim());
              if (match) {
                stop();
                setScannerOpen(false);
                void lookupRef.current(match.rawValue.trim());
                return;
              }
            }
          } catch {
            if (active) {
              stop();
              setScannerError('Barcode belum dapat dibaca oleh kamera ini. Tutup pemindai dan masukkan nomor resi secara manual.');
              setCameraReady(false);
            }
            return;
          }
          if (active) timer = setTimeout(() => { void detect(); }, 180);
        };
        void detect();
      } catch (err) {
        if (!active) return;
        stream?.getTracks().forEach(track => track.stop());
        cameraStream.current = null;
        setScannerError(err instanceof Error && err.name === 'NotAllowedError'
          ? 'Izin kamera belum diberikan. Izinkan kamera di pengaturan browser atau masukkan resi secara manual.'
          : 'Kamera belum dapat diakses. Pastikan tidak digunakan aplikasi lain, atau masukkan resi secara manual.');
      }
    }
    void startCamera();
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [scannerOpen, user?.id]);

  const sourceBlocked = !!order && blockedSource(order.sourceStatus);
  const editable = !!order && order.status === 'NEW' && !sourceBlocked;
  const itemCount = order?.items.length ?? 0;
  const unitCount = order?.items.reduce((total, item) => total + item.quantity, 0) ?? 0;
  const completed = !!order && order.status !== 'NEW' && !sourceBlocked;
  const checkedCount = completed ? itemCount : checked.length;
  const allChecked = itemCount > 0 && checked.length === itemCount;
  const progress = itemCount ? Math.round(checkedCount / itemCount * 100) : 0;

  async function completePicking() {
    if (!order || !editable || !allChecked || saving || !userId.current) return;
    const serial = ++requestSerial.current;
    const requestUser = userId.current;
    const isCurrent = () => mounted.current && serial === requestSerial.current && requestUser === userId.current;
    const submittedOrder = order;
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const result = await api<{ order: Order }>(`/api/picking/${encodeURIComponent(submittedOrder.tracking)}/complete`, {
        method: 'POST', body: json({ checked, version: submittedOrder.version }),
      });
      if (!isCurrent()) return;
      setOrder(result.order);
      setNotice('Pemeriksaan tersimpan. Pesanan siap diteruskan ke meja packing.');
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiError && err.status === 409) {
        setChecked([]);
        setOrder(null);
        try {
          const latest = await api<{ order: Order }>(`/api/orders/${encodeURIComponent(submittedOrder.tracking)}`);
          if (!isCurrent()) return;
          setOrder(latest.order);
          setError('Data atau status pesanan telah berubah. Tinjau pesanan terbaru dan periksa barang kembali jika masih menunggu picking.');
        } catch (refreshError) {
          if (isCurrent()) setError(errorMessage(refreshError, 'Pesanan berubah dan belum dapat dimuat ulang. Cari nomor resi kembali.'));
        }
      } else setError(errorMessage(err, 'Pemeriksaan belum tersimpan. Coba lagi.'));
    } finally {
      if (isCurrent()) setSaving(false);
    }
  }

  function search(event: FormEvent) {
    event.preventDefault();
    if (!saving) void lookup(tracking);
  }

  function nextOrder() {
    requestSerial.current += 1;
    searchAbort.current?.abort();
    setOrder(null);
    setChecked([]);
    setTracking('');
    setError('');
    setNotice('');
    input.current?.focus();
  }

  if (!user) return null;

  return <main className="picker-page">
    <section className="picker-heading" aria-labelledby="picker-title">
      <div>
        <p className="picker-eyebrow"><span /> PICKING STATION</p>
        <h1 id="picker-title">Pesanan tepat.<br className="picker-mobile-break" /> Barang lengkap.</h1>
        <p className="picker-subtitle">Scan resi, cocokkan barang, teruskan ke packing.</p>
      </div>
      <div className="picker-identity"><span className="picker-identity-icon"><UserRound size={20} /></span><div><small>Picker bertugas</small><strong>{user.name}</strong></div></div>
    </section>

    <ol className="picker-steps" aria-label="Tahapan picking">
      <li className={!order ? 'current' : 'done'}><span>{order ? <Check size={14} /> : '01'}</span><b>Scan resi</b></li>
      <li className={order && !completed ? 'current' : completed ? 'done' : ''}><span>{completed ? <Check size={14} /> : '02'}</span><b>Periksa barang</b></li>
      <li className={completed ? 'current' : ''}><span>03</span><b>Siap dikemas</b></li>
    </ol>

    <div className="picker-workspace">
      <section className="picker-search-card" aria-labelledby="picker-search-title">
        <div className="picker-section-head"><span className="picker-icon-tile"><ScanLine size={23} /></span><div><h2 id="picker-search-title">Mulai dari resi</h2><p>Gunakan kamera atau ketik nomor resi.</p></div></div>
        <form onSubmit={search}>
          <label className="picker-label" htmlFor="picker-tracking">Nomor resi</label>
          <div className="picker-input-wrap"><Search size={19} aria-hidden="true" /><input ref={input} id="picker-tracking" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Contoh: SPXID…" value={tracking} onChange={event => setTracking(event.target.value)} disabled={saving} /></div>
          <div className="picker-search-actions">
            <button className="picker-button picker-button-primary" type="submit" disabled={loading || saving}>{loading ? <LoaderCircle className="picker-spin" size={18} /> : <Search size={18} />}{loading ? 'Mencari…' : 'Cari pesanan'}</button>
            <button className="picker-button picker-button-camera" type="button" disabled={loading || saving} onClick={() => setScannerOpen(true)}><ScanLine size={20} /> Scan kamera</button>
          </div>
        </form>
        <div className="picker-search-tip"><ShieldCheck size={17} /><p>Pesanan harus sudah diimpor admin. Scanner USB atau Bluetooth juga bisa langsung digunakan di kolom resi.</p></div>
      </section>

      <section className="picker-result" aria-label="Hasil pemeriksaan pesanan" aria-busy={loading || saving}>
        {error && <div className="picker-message picker-message-error" role="alert"><AlertCircle size={20} /><p>{error}</p></div>}
        {notice && <div className="picker-message picker-message-success" role="status"><CheckCircle2 size={20} /><p>{notice}</p></div>}
        {!order && <div className="picker-empty">
          <div className="picker-empty-art"><span className="picker-art-bracket picker-art-top" /><span className="picker-art-bracket picker-art-bottom" />{loading ? <LoaderCircle size={46} strokeWidth={1.4} className="picker-spin" /> : <Package size={50} strokeWidth={1.25} />}</div>
          <h2>{loading ? 'Mencari pesanan…' : 'Satu scan untuk mulai.'}</h2>
          <p>{loading ? 'Mencocokkan resi dengan data pesanan.' : 'Detail pesanan dan daftar barang akan muncul di sini setelah resi ditemukan.'}</p>
          {!loading && <span className="picker-empty-note"><ClipboardCheck size={15} /> Periksa setiap barang sebelum dikemas</span>}
        </div>}

        {order && <article className="picker-order" aria-labelledby="picker-order-title">
          <header className="picker-order-header"><div><p className="picker-eyebrow">DETAIL PESANAN</p><h2 id="picker-order-title">{order.tracking}</h2></div><span className={`picker-status picker-status-${order.status.toLowerCase()}`}>{completed && <CheckCircle2 size={14} />}{statusNames[order.status]}</span></header>
          <dl className="picker-order-meta"><div><dt>Penerima</dt><dd>{order.recipient || order.buyer || 'Tidak tercantum'}</dd></div><div><dt>No. pesanan</dt><dd>{order.orderNumber || 'Tidak tercantum'}</dd></div><div><dt>Status Shopee</dt><dd>{order.sourceStatus || 'Tidak tercantum'}</dd></div></dl>

          {sourceBlocked && <div className="picker-message picker-message-error" role="alert"><AlertCircle size={19} /><p>Pesanan dibatalkan atau belum dibayar. Picking tidak dapat dilanjutkan. Hubungi admin untuk memeriksa status pesanan.</p></div>}
          {completed && <div className="picker-readonly"><CheckCircle2 size={19} /><p>{order.status === 'READY' ? 'Pesanan ini sudah diperiksa dan siap dikemas.' : order.status === 'PACKING' ? 'Pesanan sedang ditangani packer. Daftar barang hanya dapat dilihat.' : 'Pesanan sudah selesai dikemas. Daftar barang hanya dapat dilihat.'}</p></div>}

          <div className="picker-items-heading"><div><h3>Checklist barang <span>{itemCount}</span></h3><p>{unitCount} unit · Cocokkan produk, varian, dan jumlah.</p></div><span className="picker-progress-label">{checkedCount}/{itemCount}</span></div>
          <div className="picker-progress-track" role="progressbar" aria-label="Barang diperiksa" aria-valuemin={0} aria-valuemax={itemCount || 1} aria-valuenow={checkedCount}><span style={{ width: `${progress}%` }} /></div>

          <ul className="picker-items">{order.items.map((item, index) => {
            const isChecked = completed || checked.includes(index);
            return <li key={`${order.id}-${order.version}-${index}`} className={isChecked ? 'is-checked' : ''}>
              <label className={`picker-item ${!editable ? 'picker-item-readonly' : ''}`}>
                <input type="checkbox" checked={isChecked} disabled={!editable || saving} onChange={event => setChecked(previous => event.target.checked ? [...previous.filter(value => value !== index), index] : previous.filter(value => value !== index))} aria-label={`Periksa ${item.name}, ${item.variant || 'tanpa varian'}, ${item.quantity} unit`} />
                <span className="picker-checkbox" aria-hidden="true">{isChecked && <Check size={16} strokeWidth={3} />}</span>
                <span className="picker-item-info"><strong>{item.name}</strong><span>{item.variant || 'Tanpa varian'}</span><small>SKU: {item.sku || 'Tidak tercantum'}</small></span>
                <span className="picker-quantity"><strong>{item.quantity}×</strong><small>unit</small></span>
              </label>
            </li>;
          })}</ul>

          {editable && <footer className="picker-order-footer"><p>{allChecked ? 'Semua barang sudah diperiksa.' : `${itemCount - checked.length} jenis barang belum diperiksa.`}</p><button className="picker-button picker-button-primary picker-complete" type="button" disabled={!allChecked || saving} onClick={() => { void completePicking(); }}>{saving ? <LoaderCircle size={19} className="picker-spin" /> : <CheckCircle2 size={19} />}{saving ? 'Menyimpan…' : 'Selesai picking'}{!saving && <ArrowRight size={18} />}</button></footer>}
          {!editable && <footer className="picker-order-footer"><p>{sourceBlocked ? 'Periksa pesanan lain sambil menunggu admin.' : 'Lanjutkan ke pesanan berikutnya.'}</p><button className="picker-button picker-button-primary" type="button" onClick={nextOrder}>Scan resi berikutnya <ArrowRight size={18} /></button></footer>}
        </article>}
      </section>
    </div>
    <div className="picker-bottom-note"><span /> Satu per satu, pastikan lengkap.</div>

    {scannerOpen && <div className="picker-scanner-backdrop"><div ref={scannerDialog} className="picker-scanner-dialog" role="dialog" aria-modal="true" aria-labelledby="picker-camera-title" aria-describedby="picker-camera-description">
      <header><div><p className="picker-eyebrow">SCAN RESI</p><h2 id="picker-camera-title">Arahkan ke barcode</h2></div><button ref={closeScannerButton} className="picker-close" type="button" aria-label="Tutup pemindai" onClick={closeScanner}><X size={22} /></button></header>
      <p id="picker-camera-description">Posisikan barcode resi di depan kamera. Pesanan akan dicari otomatis.</p>
      {!scannerError && <div className="picker-camera-view"><video ref={video} playsInline muted autoPlay aria-label="Pratinjau kamera pemindai" /><div className="picker-camera-guide" aria-hidden="true" />{!cameraReady && <span className="picker-camera-loading"><Camera size={28} /> Menyiapkan kamera…</span>}</div>}
      {scannerError && <div className="picker-message picker-message-error" role="alert"><AlertCircle size={21} /><p>{scannerError}</p></div>}
      <button className="picker-button picker-button-camera picker-camera-manual" type="button" onClick={() => { closeScanner(); setTimeout(() => input.current?.focus(), 0); }}>Masukkan resi manual</button>
      <small className="picker-camera-privacy">Kamera ini hanya membaca barcode. Tidak ada foto atau video yang disimpan.</small>
    </div></div>}
  </main>;
}
