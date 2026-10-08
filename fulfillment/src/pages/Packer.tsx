import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowRight, Camera, Check, CheckCircle2, CloudUpload, Download, HardDrive, LoaderCircle, Package, RefreshCw, ScanLine, ShieldCheck, Square, Video, X } from 'lucide-react';
import { api, ApiError, json } from '../api';
import { useAuth } from '../auth';
import type { DriveStatus, Order, Recording } from '../types';
import { addRecordingChunk, deleteRecording, deleteStartIntent, durationLabel, getStartIntent, recordingBlob, recoverRecordings, storeRecording, storeStartIntent, supportedRecordingMime, type LocalRecording, type StartIntent } from '../recording';
import './packer.css';

type Phase = 'idle' | 'starting' | 'recording' | 'finishing' | 'uploading';
type Capture = {
  recorder: MediaRecorder; stream: MediaStream; job: LocalRecording; chunks: Blob[]; sequence: number;
  started: number; writes: Promise<void>; timer: ReturnType<typeof setInterval>; drawing: ReturnType<typeof setInterval>;
  interrupted: boolean; reason: string; persistenceError: string;
};
const message = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;
const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('id-ID', { maximumFractionDigits: 1 })} MB`;
const statusLabels: Record<Order['status'], string> = { NEW: 'Menunggu picking', READY: 'Siap dikemas', PACKING: 'Sedang dikemas', PACKED: 'Selesai dikemas' };

export default function Packer() {
  const { user } = useAuth();
  const [phase, setPhase] = useState<Phase>('idle');
  const [initialized, setInitialized] = useState(false);
  const [tracking, setTracking] = useState('');
  const [station, setStation] = useState(() => { try { return localStorage.getItem('fulfill-packing-station') || 'Meja packing 01'; } catch { return 'Meja packing 01'; } });
  const [order, setOrder] = useState<Order | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [jobs, setJobs] = useState<LocalRecording[]>([]);
  const [intent, setIntent] = useState<StartIntent | null>(null);
  const [drive, setDrive] = useState<DriveStatus | null>(null);
  const [driveError, setDriveError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [savedCount, setSavedCount] = useState(0);
  const mounted = useRef(false);
  const ownsTab = useRef(false);
  const busy = useRef(false);
  const guard = useRef(false);
  const camera = useRef<MediaStream | null>(null);
  const capture = useRef<Capture | null>(null);
  const memoryBackups = useRef(new Map<string, Blob[]>());
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const stopRef = useRef<(interrupted: boolean, reason?: string) => void>(() => {});
  guard.current = phase !== 'idle' || jobs.length > 0 || intent !== null;

  useEffect(() => {
    if (!user?.id) return;
    let active = true;
    let unlock: (() => void) | undefined;
    mounted.current = true;
    const initialize = async () => {
      if (!navigator.locks) throw new Error('Gunakan Chrome atau Edge terbaru melalui HTTPS agar rekaman terlindungi antar-tab.');
      await navigator.locks.request(`fulfill-packer-${user.id}`, { ifAvailable: true }, async lock => {
        if (!active) return;
        if (!lock) { setError('Stasiun packing sudah terbuka di tab lain. Tutup tab tersebut, lalu muat ulang halaman ini.'); return; }
        ownsTab.current = true;
        try {
          const recovered = await recoverRecordings(user.id);
          let pending = await getStartIntent(user.id);
          if (pending && recovered.some(job => job.clientId === pending?.clientId)) { await deleteStartIntent(user.id); pending = undefined; }
          if (!active) return;
          setJobs(recovered); setIntent(pending || null); setInitialized(true);
        } catch (err) { if (active) setError(message(err, 'Cadangan browser tidak tersedia.')); }
        if (active) await new Promise<void>(resolve => { unlock = resolve; });
        ownsTab.current = false;
      });
    };
    void initialize().catch(err => { if (active) setError(message(err, 'Stasiun belum dapat disiapkan.')); });
    void refreshDrive();
    const beforeUnload = (event: BeforeUnloadEvent) => { if (guard.current) { event.preventDefault(); event.returnValue = ''; } };
    const beforeLogout = (event: Event) => { if (guard.current) { event.preventDefault(); setError('Selesaikan rekaman dan simpan cadangan ke Drive sebelum keluar.'); } };
    const visibility = () => { if (document.hidden && capture.current) stopRef.current(true, 'Tab tidak lagi terlihat. Rekaman dihentikan untuk mencegah bukti video yang terlewat.'); };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('fulfill:before-logout', beforeLogout);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false; mounted.current = false; ownsTab.current = false;
      stopRef.current(true, 'Halaman ditutup sebelum packing selesai.');
      camera.current?.getTracks().forEach(track => track.stop());
      camera.current = null; unlock?.();
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('fulfill:before-logout', beforeLogout);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [user?.id]);

  async function refreshDrive() {
    try { const status = await api<DriveStatus>('/api/integrations/drive/status'); if (mounted.current) { setDrive(status); setDriveError(''); } }
    catch (err) { if (mounted.current) setDriveError(message(err, 'Status Google Drive belum tersedia.')); }
  }

  function updateJob(job: LocalRecording) { if (mounted.current) setJobs(current => [job, ...current.filter(item => item.id !== job.id)]); }

  async function enableCamera(selected = deviceId) {
    if (busy.current || !initialized) return;
    setCameraLoading(true); setError('');
    camera.current?.getTracks().forEach(track => track.stop());
    camera.current = null; setCameraReady(false);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Kamera memerlukan HTTPS atau localhost. Buka aplikasi melalui alamat yang aman.');
      supportedRecordingMime();
      void navigator.storage?.persist?.().catch(() => false);
      const stream = await navigator.mediaDevices.getUserMedia({ video: { ...(selected ? { deviceId: { exact: selected } } : {}), width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }, audio: false });
      if (!mounted.current || !ownsTab.current) { stream.getTracks().forEach(track => track.stop()); return; }
      camera.current = stream;
      if (!video.current) throw new Error('Pratinjau kamera belum tersedia.');
      video.current.srcObject = stream;
      await video.current.play();
      stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
        setCameraReady(false); stopRef.current(true, 'Kamera terputus. Sambungkan kembali dan ulangi packing setelah bukti ini disimpan.');
      }));
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput'));
      setDeviceId(stream.getVideoTracks()[0]?.getSettings().deviceId || selected);
      setCameraReady(true); input.current?.focus();
    } catch (err) {
      camera.current?.getTracks().forEach(track => track.stop()); camera.current = null;
      const denied = err instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(err.name);
      setError(denied ? 'Izin kamera ditolak. Izinkan kamera melalui ikon di bilah alamat browser, lalu coba lagi.' : message(err, 'Kamera tidak dapat diaktifkan.'));
    } finally { if (mounted.current) setCameraLoading(false); }
  }

  function drawOverlay(job: LocalRecording) {
    const element = canvas.current; const source = video.current;
    if (!element || !source) return;
    const context = element.getContext('2d');
    if (!context) throw new Error('Browser tidak mendukung video dengan penanda bukti.');
    const w = element.width; const h = element.height;
    context.fillStyle = '#161d1b'; context.fillRect(0, 0, w, h);
    if (source.readyState >= 2) {
      const scale = Math.max(w / source.videoWidth, h / source.videoHeight);
      const dw = source.videoWidth * scale; const dh = source.videoHeight * scale;
      context.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    context.fillStyle = 'rgba(11,20,17,.84)'; context.fillRect(0, h - 94, w, 94);
    context.fillStyle = '#ffffff'; context.font = 'bold 25px sans-serif';
    context.fillText(`RESI ${job.tracking}`, 26, h - 54, w - 410);
    context.font = '18px sans-serif'; context.fillText(`${job.packerName}  •  ${job.station}`, 26, h - 23, w - 430);
    context.textAlign = 'right'; context.font = '18px sans-serif';
    context.fillText(new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false }) + ' WIB', w - 26, h - 54);
    context.fillStyle = '#b6d9c7'; context.fillText(`FULFILL  •  ${job.orderNumber}`, w - 26, h - 23, 400);
    context.textAlign = 'left';
  }

  function stopCapture(interrupted: boolean, reason = '') {
    const current = capture.current;
    if (!current) return;
    if (interrupted) { current.interrupted = true; current.reason = reason || 'Rekaman terputus.'; }
    if (current.recorder.state !== 'inactive') {
      if (mounted.current) setPhase('finishing');
      current.recorder.stop();
    }
  }
  stopRef.current = stopCapture;

  async function finalizeCapture(current: Capture) {
    clearInterval(current.timer); clearInterval(current.drawing);
    current.stream.getTracks().forEach(track => track.stop());
    await current.writes;
    const job: LocalRecording = {
      ...current.job, duration: Math.max(0.1, (performance.now() - current.started) / 1000),
      interrupted: current.interrupted || Boolean(current.persistenceError), state: 'queued',
      error: current.persistenceError || current.reason || undefined,
    };
    if (!job.bytes) { job.interrupted = true; job.state = 'failed'; job.error = 'Kamera tidak menghasilkan video. Batalkan sesi untuk membuka pesanan kembali.'; }
    try { await storeRecording(job); }
    catch (err) { job.state = 'failed'; job.error = `Cadangan browser gagal: ${message(err, 'penyimpanan penuh')}. Jangan tutup halaman; unduh video atau coba unggah ke Drive.`; }
    capture.current = null; busy.current = false;
    updateJob(job);
    if (mounted.current) {
      setPhase('idle');
      if (job.interrupted) setError(job.error || 'Rekaman terputus. Simpan buktinya, lalu ulangi packing.');
      if (job.bytes && !job.interrupted) await upload(job);
    }
  }

  async function startPacking(event: FormEvent) {
    event.preventDefault();
    if (capture.current?.recorder.state === 'recording') {
      const scanned = tracking.trim();
      if (scanned.toUpperCase() === 'STOP' || scanned === capture.current.job.tracking) { setError(''); setTracking(''); stopCapture(false); }
      else setError(`Sedang merekam resi ${capture.current.job.tracking}. Pindai STOP, resi yang sama, atau tekan Selesai & simpan sebelum memulai paket berikutnya.`);
      return;
    }
    if (busy.current || !initialized || !user || !ownsTab.current) return;
    if (!cameraReady || !camera.current?.getVideoTracks().some(track => track.readyState === 'live')) { setError('Aktifkan kamera sebelum memindai resi.'); return; }
    if (jobs.length || intent) { setError('Selesaikan cadangan atau sesi tertunda di bawah sebelum memindai resi berikutnya.'); return; }
    const resi = tracking.trim();
    if (!resi || !station.trim()) { setError('Isi nomor resi dan nama meja packing.'); return; }
    busy.current = true; setPhase('starting'); setError(''); setNotice(''); setOrder(null);
    let pending: StartIntent | null = null;
    let activeJob: LocalRecording | null = null;
    let recordStream: MediaStream | null = null;
    try {
      const preview = await api<{ order: Order }>(`/api/orders/${encodeURIComponent(resi)}`);
      setOrder(preview.order);
      if (preview.order.status !== 'READY') throw new Error(`Pesanan ${statusLabels[preview.order.status].toLowerCase()}. Hanya pesanan yang telah diperiksa picker yang dapat direkam.`);
      const mimeType = supportedRecordingMime();
      pending = { userId: user.id, clientId: crypto.randomUUID(), tracking: resi, station: station.trim() };
      await storeStartIntent(pending); setIntent(pending);
      const result = await api<{ recording: Recording; order: Order }>('/api/recordings/start', { method: 'POST', body: json(pending) });
      if (result.recording.status !== 'RECORDING') throw new Error('Sesi ini telah selesai. Pulihkan sesi tertunda sebelum mencoba lagi.');
      activeJob = { id: result.recording.id, userId: user.id, clientId: pending.clientId, tracking: resi, orderNumber: result.order.orderNumber, packerName: user.name, station: station.trim(), startedAt: result.recording.startedAt, duration: 0, bytes: 0, mimeType, interrupted: false, state: 'capturing' };
      await storeRecording(activeJob);
      await deleteStartIntent(user.id); setIntent(null); pending = null;
      if (!mounted.current || document.hidden || !camera.current?.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('Kamera atau halaman tidak lagi aktif. Batalkan sesi tertunda dan coba lagi.');
      const element = canvas.current;
      if (!element?.captureStream) throw new Error('Browser belum mendukung perekaman video. Gunakan Chrome atau Edge terbaru.');
      drawOverlay(activeJob); recordStream = element.captureStream(15);
      const recorder = new MediaRecorder(recordStream, { mimeType, videoBitsPerSecond: 2_000_000 });
      activeJob.mimeType = recorder.mimeType || mimeType;
      const current: Capture = { recorder, stream: recordStream, job: activeJob, chunks: [], sequence: 0, started: performance.now(), writes: Promise.resolve(), interrupted: false, reason: '', persistenceError: '', timer: 0 as unknown as ReturnType<typeof setInterval>, drawing: 0 as unknown as ReturnType<typeof setInterval> };
      capture.current = current; memoryBackups.current.set(activeJob.id, current.chunks);
      recorder.addEventListener('dataavailable', event => {
        if (!event.data.size) return;
        current.chunks.push(event.data);
        current.job = { ...current.job, bytes: current.job.bytes + event.data.size, duration: Math.max(0.1, (performance.now() - current.started) / 1000) };
        const snapshot = { ...current.job }; const sequence = current.sequence++;
        current.writes = current.writes.then(() => addRecordingChunk(snapshot, sequence, event.data)).catch(err => {
          current.persistenceError = message(err, 'Penyimpanan browser penuh.');
          stopRef.current(true, 'Cadangan browser gagal ditulis.');
        });
        if (current.job.bytes > 180 * 1024 * 1024) stopRef.current(true, 'Rekaman mendekati batas ukuran 200 MB. Simpan bukti dan ulangi packing.');
      });
      recorder.addEventListener('error', () => stopRef.current(true, 'Browser mengalami kegagalan perekaman. Simpan cadangan yang tersedia.'));
      recorder.addEventListener('stop', () => { void finalizeCapture(current); }, { once: true });
      current.drawing = setInterval(() => drawOverlay(current.job), 100);
      current.timer = setInterval(() => {
        const seconds = (performance.now() - current.started) / 1000;
        if (mounted.current) setElapsed(seconds);
        if (seconds >= 12 * 60) stopRef.current(true, 'Batas durasi 12 menit tercapai. Simpan bukti terputus lalu ulangi packing.');
        if (camera.current?.getVideoTracks().some(track => track.muted || track.readyState !== 'live')) stopRef.current(true, 'Gambar kamera terhenti. Simpan bukti terputus lalu periksa kamera.');
      }, 250);
      recorder.start(1000); setOrder(result.order); setElapsed(0); setPhase('recording'); setTracking('');
      requestAnimationFrame(() => input.current?.focus());
    } catch (err) {
      const errorText = message(err, 'Rekaman belum dapat dimulai.');
      recordStream?.getTracks().forEach(track => track.stop());
      if (capture.current) { clearInterval(capture.current.timer); clearInterval(capture.current.drawing); capture.current = null; }
      if (activeJob) {
        activeJob = { ...activeJob, state: 'failed', interrupted: true, error: errorText };
        await storeRecording(activeJob).catch(() => {}); updateJob(activeJob);
      } else if (pending && err instanceof ApiError && err.status >= 400 && err.status < 500) {
        await deleteStartIntent(user.id).then(() => setIntent(null)).catch(() => {});
      }
      if (mounted.current) { setError(errorText); setPhase('idle'); }
      busy.current = false;
    }
  }

  async function blobFor(job: LocalRecording) {
    const parts = memoryBackups.current.get(job.id);
    return parts?.length ? new Blob(parts, { type: job.mimeType }) : recordingBlob(job);
  }

  async function upload(job: LocalRecording) {
    if (busy.current || !ownsTab.current || job.cancelled) return;
    busy.current = true; setPhase('uploading'); setError(''); setNotice('');
    let current: LocalRecording = { ...job, state: 'uploading', error: undefined };
    updateJob(current);
    try {
      const blob = await blobFor(job);
      if (!blob.size) throw new Error('Tidak ada video untuk diunggah. Batalkan sesi untuk membuka kembali pesanan.');
      if (blob.size > 200 * 1024 * 1024) throw new Error('Video lebih dari 200 MB. Unduh cadangan dan hubungi admin sebelum membatalkan sesi.');
      await storeRecording(current).catch(() => {});
      const body = new FormData();
      body.append('video', blob, `${job.tracking}.${job.mimeType.includes('mp4') ? 'mp4' : 'webm'}`);
      body.append('duration', String(Math.max(0.1, job.duration))); body.append('interrupted', String(job.interrupted));
      const result = await api<{ recording: Recording; order: Order }>(`/api/recordings/${encodeURIComponent(job.id)}/upload`, { method: 'POST', body });
      if (!result.recording.driveFileId || !['SAVED', 'INTERRUPTED'].includes(result.recording.status)) throw new Error('Google Drive belum mengonfirmasi penyimpanan. Cadangan tetap tersedia untuk dicoba ulang.');
      await deleteRecording(job);
      memoryBackups.current.delete(job.id);
      if (mounted.current) {
        setJobs(previous => previous.filter(item => item.id !== job.id));
        setOrder(result.order); setTracking('');
        if (result.recording.status === 'SAVED') {
          setSavedCount(count => count + 1); setNotice(`Resi ${job.tracking} selesai dikemas. Video tersimpan di Google Drive.`);
        } else { setNotice(`Bukti terputus untuk ${job.tracking} tersimpan di Google Drive. Pesanan siap untuk direkam ulang; packing belum selesai.`); }
        input.current?.focus();
      }
      void refreshDrive();
    } catch (err) {
      current = { ...job, state: 'failed', error: message(err, 'Unggah gagal. Cadangan tetap tersedia.') };
      await storeRecording(current).catch(() => {}); updateJob(current);
      if (mounted.current) setError(`${current.error} Jangan hapus data browser sebelum bukti tersimpan.`);
    } finally { busy.current = false; if (mounted.current) setPhase('idle'); }
  }

  async function download(job: LocalRecording) {
    try {
      const blob = await blobFor(job);
      if (!blob.size) throw new Error('Belum ada bagian video yang dapat diunduh.');
      const url = URL.createObjectURL(blob); const link = document.createElement('a');
      link.href = url; link.download = `${job.tracking}_${job.id}.${job.mimeType.includes('mp4') ? 'mp4' : 'webm'}`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
      setNotice('Unduhan cadangan dimulai. Pastikan file sudah tersimpan sebelum menghapus cadangan browser.');
    } catch (err) { setError(message(err, 'Cadangan belum dapat diunduh.')); }
  }

  async function cancelJob(job: LocalRecording) {
    if (busy.current || !window.confirm(job.bytes ? 'Batalkan sesi ini? Pesanan akan kembali siap dikemas. Video tetap dapat diunduh dari cadangan browser, tetapi tidak dapat diunggah melalui sesi ini lagi.' : 'Batalkan sesi tanpa video ini agar pesanan siap dikemas kembali?')) return;
    busy.current = true; setPhase('finishing'); setError('');
    try {
      await api(`/api/recordings/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: json({ reason: job.error || 'Packer membatalkan sesi yang terputus.' }) });
      if (job.bytes) {
        const cancelled = { ...job, cancelled: true, state: 'failed' as const, interrupted: true, error: 'Sesi dibatalkan. Unduh cadangan sebelum menghapusnya.' };
        updateJob(cancelled); await storeRecording(cancelled).catch(() => {});
      } else {
        await deleteRecording(job); memoryBackups.current.delete(job.id); setJobs(current => current.filter(item => item.id !== job.id));
      }
      setOrder(null); setNotice('Sesi dibatalkan. Pesanan dapat dikemas ulang.');
    } catch (err) { setError(message(err, 'Sesi belum dapat dibatalkan.')); }
    finally { busy.current = false; setPhase('idle'); }
  }

  async function removeCancelled(job: LocalRecording) {
    if (busy.current || !job.cancelled || !window.confirm('Hapus cadangan video di browser secara permanen? Pastikan file unduhan sudah aman.')) return;
    try { await deleteRecording(job); memoryBackups.current.delete(job.id); setJobs(current => current.filter(item => item.id !== job.id)); }
    catch (err) { setError(message(err, 'Cadangan belum dapat dihapus.')); }
  }

  async function recoverIntent() {
    if (busy.current || !intent) return;
    busy.current = true; setPhase('finishing'); setError('');
    try {
      const result = await api<{ recording: Recording; order: Order }>('/api/recordings/start', { method: 'POST', body: json(intent) });
      if (result.recording.status === 'RECORDING') await api(`/api/recordings/${encodeURIComponent(result.recording.id)}/cancel`, { method: 'POST', body: json({ reason: 'Sesi mulai terputus sebelum video tersimpan di browser.' }) });
      await deleteStartIntent(intent.userId); setIntent(null); setOrder(null); setNotice('Sesi tertunda berhasil dipulihkan. Pindai kembali resi untuk memulai video baru.');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await deleteStartIntent(intent.userId).then(() => setIntent(null)).catch(() => {});
      }
      setError(message(err, 'Sesi tertunda belum dapat dipulihkan.'));
    } finally { busy.current = false; setPhase('idle'); }
  }

  const active = phase !== 'idle';
  const isRecording = phase === 'recording' || phase === 'finishing' && capture.current !== null;
  const itemCount = order?.items.reduce((total, item) => total + item.quantity, 0) || 0;
  const canScan = initialized && cameraReady && (phase === 'recording' || !active && !jobs.length && !intent);
  return <main className="packer-workspace">
    <section className="packer-heading"><div><div className="packer-eyebrow"><span /> FULFILLMENT WORKSPACE</div><h1>Setiap paket, ada buktinya<span>.</span></h1><p>Pindai resi, kemas dengan teliti, simpan rekamannya.</p></div><div className="packer-session-count"><Package size={20} /><strong>{savedCount}</strong><span>paket selesai<br />di sesi ini</span></div></section>
    <div className="packer-step-strip" aria-label="Alur packing"><span className={cameraReady ? 'done' : 'current'}><b>{cameraReady ? <Check size={14} /> : '01'}</b> Siapkan kamera</span><i /><span className={isRecording ? 'current' : ''}><b>02</b> Pindai & kemas</span><i /><span className={phase === 'uploading' ? 'current' : ''}><b>03</b> Simpan ke Drive</span><div><ShieldCheck size={16} /> Bukti terhubung ke resi</div></div>
    {error && <div className="packer-message error" role="alert"><AlertCircle size={19} /><span>{error}</span><button onClick={() => setError('')} aria-label="Tutup pesan kesalahan"><X size={17} /></button></div>}
    {notice && <div className="packer-message success" role="status"><CheckCircle2 size={19} /><span>{notice}</span></div>}
    <div className="packer-grid">
      <section className="packer-camera-card">
        <div className="packer-card-top"><div><Video size={19} /><h2>Kamera packing</h2></div><span className={`packer-camera-status ${isRecording ? 'recording' : cameraReady ? 'ready' : ''}`}><i />{isRecording ? 'MEREKAM' : cameraReady ? 'KAMERA SIAP' : 'BELUM AKTIF'}</span></div>
        <div className={`packer-viewfinder ${cameraReady ? 'has-camera' : ''}`}>
          <video ref={video} autoPlay playsInline muted className={isRecording ? 'camera-underlay' : ''} aria-label="Pratinjau kamera packing" />
          <canvas ref={canvas} width={1280} height={720} className={isRecording ? 'visible' : ''} aria-label="Video packing dengan resi dan waktu" />
          {!cameraReady && <div className="packer-camera-empty"><div className="packer-camera-icon"><Camera size={34} strokeWidth={1.4} /></div><h3>Meja packing siap. Kameranya?</h3><p>Arahkan kamera ke seluruh area paket.<br />Rekaman dimulai otomatis saat resi dipindai.</p><button className="packer-button orange" disabled={!initialized || cameraLoading || active} onClick={() => void enableCamera()}>{cameraLoading ? <LoaderCircle className="packer-spin" size={18} /> : <Camera size={18} />}{cameraLoading ? 'Menghubungkan…' : 'Aktifkan kamera'}</button><small>Izinkan akses kamera saat browser meminta.</small></div>}
          {cameraReady && <><span className="packer-frame-corner top-left" /><span className="packer-frame-corner top-right" /><span className="packer-frame-corner bottom-left" /><span className="packer-frame-corner bottom-right" /><div className="packer-live-label"><span /> {isRecording ? 'REC' : 'LIVE PREVIEW'}<b>{durationLabel(elapsed)}</b></div>{!isRecording && <span className="packer-preview-note">Pastikan label resi dan semua barang terlihat jelas</span>}</>}
        </div>
        <div className="packer-camera-settings"><label>MEJA PACKING<input value={station} maxLength={100} disabled={active} onChange={event => { setStation(event.target.value); try { localStorage.setItem('fulfill-packing-station', event.target.value); } catch { /* Optional preference. */ } }} /></label><label>SUMBER KAMERA<select aria-label="Sumber kamera" value={deviceId} disabled={!cameraReady || active || cameraLoading} onChange={event => { setDeviceId(event.target.value); void enableCamera(event.target.value); }}>{devices.length ? devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Kamera ${index + 1}`}</option>) : <option value="">Kamera perangkat</option>}</select></label></div>
        {isRecording ? <div className="packer-recording-action"><div><span className="packer-red-dot" /><strong>Rekaman sedang berjalan</strong><small>Selesaikan isi paket sebelum menyimpan.</small></div><button className="packer-button dark" disabled={phase !== 'recording'} onClick={() => stopCapture(false)}>{phase === 'finishing' ? <LoaderCircle size={17} className="packer-spin" /> : <Square size={15} fill="currentColor" />} Selesai & simpan</button></div> : phase === 'uploading' ? <div className="packer-upload-progress" role="status"><LoaderCircle size={20} className="packer-spin" /><div><strong>Menyimpan video ke Google Drive…</strong><span>Biarkan halaman terbuka sampai penyimpanan dikonfirmasi.</span></div></div> : <div className="packer-camera-footnote"><ShieldCheck size={17} /><p>Resi, nama packer, dan waktu otomatis tercantum pada video. Tanpa audio. Jaga tab tetap terlihat selama merekam.</p></div>}
      </section>
      <aside className="packer-order-column">
        <section className="packer-scan-card"><div className="packer-scan-title"><ScanLine size={22} /><h2>Mulai dari resi</h2><span>AUTO RECORD</span></div><p>Pakai scanner USB atau ketik resi, lalu tekan Enter.</p><form onSubmit={event => void startPacking(event)}><label htmlFor="packer-tracking" className="packer-sr-only">Nomor resi</label><div className="packer-scan-input"><ScanLine size={20} /><input id="packer-tracking" ref={input} placeholder="Pindai atau masukkan resi" value={tracking} onChange={event => setTracking(event.target.value)} autoComplete="off" disabled={!canScan} maxLength={120} /><button aria-label="Pindai dan mulai packing" disabled={!canScan || !tracking.trim()}>{phase === 'starting' ? <LoaderCircle className="packer-spin" size={20} /> : <ArrowRight size={20} />}</button></div></form><div className="packer-scan-hint"><span className={canScan ? 'ready' : ''} />{active ? (isRecording ? 'Packing berlangsung · jangan tutup halaman' : 'Sedang memproses sesi packing') : jobs.length || intent ? 'Selesaikan cadangan tertunda untuk melanjutkan' : cameraReady ? 'Kamera siap · menunggu resi' : 'Aktifkan kamera untuk mulai'}</div></section>
        <section className={`packer-order-card ${order ? 'has-order' : ''}`}><div className="packer-card-top"><div><Package size={18} /><h2>Isi paket</h2></div>{order && <span className="packer-items-count">{itemCount} barang</span>}</div>{order ? <><div className="packer-order-identity"><span className={`packer-order-badge ${order.status.toLowerCase()}`}>{statusLabels[order.status]}</span><h3>{order.tracking}</h3><p>{order.orderNumber}</p><div><span>Penerima</span><strong>{order.recipient || order.buyer || '—'}</strong></div>{order.pickedAt && <small><CheckCircle2 size={13} /> Sudah diperiksa picker</small>}</div><div className="packer-item-list">{order.items.map((item, index) => <div className="packer-item" key={`${item.sku}-${index}`}><span className="packer-item-number">{String(index + 1).padStart(2, '0')}</span><div><strong>{item.name}</strong>{item.variant && <span>{item.variant}</span>}<small>SKU: {item.sku || '—'}</small></div><b>×{item.quantity}</b></div>)}</div><div className="packer-order-total"><span>Total barang</span><strong>{itemCount} pcs</strong></div></> : <div className="packer-order-empty"><div><Package size={30} strokeWidth={1.4} /></div><h3>Paket berikutnya menunggu</h3><p>Daftar barang akan muncul setelah<br />Anda memindai resi pesanan.</p><span>01&nbsp; Pindai &nbsp;→&nbsp; 02&nbsp; Cek &nbsp;→&nbsp; 03&nbsp; Kemas</span></div>}</section>
        <div className={`packer-drive-card ${drive?.connected ? 'connected' : ''}`}><div className="packer-drive-icon"><CloudUpload size={21} /></div><div><strong>{drive?.connected ? 'Terhubung ke Google Drive' : drive ? 'Google Drive belum terhubung' : 'Memeriksa Google Drive'}</strong><p>{driveError || (drive?.connected ? 'Video selesai disimpan ke Drive milik toko.' : 'Minta admin menghubungkan Drive. Video tetap memiliki cadangan sementara di browser.')}</p></div><button aria-label="Periksa kembali Google Drive" onClick={() => void refreshDrive()}><RefreshCw size={16} /></button></div>
      </aside>
    </div>
    {(jobs.length > 0 || intent) && <section className="packer-backups"><div className="packer-backup-heading"><div><HardDrive size={21} /><h2>Cadangan yang perlu diselesaikan</h2></div><span>{jobs.length + (intent ? 1 : 0)} tertunda</span></div><p>Cadangan tersimpan di browser perangkat ini. Jangan hapus data situs sampai video terkonfirmasi di Drive atau sudah diunduh.</p>{intent && <article className="packer-backup"><div><strong>{intent.tracking}</strong><span>Respons mulai rekaman terputus. Pulihkan sesi untuk membuka pesanan kembali.</span></div><button className="packer-button outline" disabled={active} onClick={() => void recoverIntent()}><RefreshCw size={16} /> Pulihkan sesi</button></article>}{jobs.map(job => <article className="packer-backup" key={job.id}><div className="packer-backup-file"><Video size={22} /></div><div className="packer-backup-details"><strong>{job.tracking}<span>{job.cancelled ? 'DIBATALKAN' : job.interrupted ? 'TERPUTUS' : job.state === 'uploading' ? 'MENGUNGGAH' : 'BELUM TERSIMPAN DI DRIVE'}</span></strong><small>{durationLabel(job.duration)} · {sizeLabel(job.bytes)} · {job.station}</small>{job.error && <p>{job.error}</p>}</div><div className="packer-backup-actions"><button className="packer-button outline" disabled={!job.bytes || active} onClick={() => void download(job)}><Download size={16} /> Unduh</button>{!job.cancelled && job.bytes > 0 && <button className="packer-button orange" disabled={active} onClick={() => void upload(job)}><CloudUpload size={16} /> {job.interrupted ? 'Simpan bukti terputus' : 'Coba unggah'}</button>}<button className="packer-text-button" disabled={active} onClick={() => void (job.cancelled ? removeCancelled(job) : cancelJob(job))}>{job.cancelled ? 'Hapus cadangan' : 'Batalkan sesi'}</button></div></article>)}</section>}
    <footer className="packer-footer"><span><ShieldCheck size={15} /> Bukti tersimpan untuk setiap cerita di balik paket.</span><span>Maks. 12 menit / 200 MB per video · HTTPS diperlukan</span></footer>
  </main>;
}
