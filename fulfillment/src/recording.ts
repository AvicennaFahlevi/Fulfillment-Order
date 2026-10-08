/** Durable, user-scoped browser backups. Videos leave this store only after Drive + DB confirmation. */
export type CaptureState = 'capturing' | 'queued' | 'uploading' | 'failed';
export interface LocalRecording {
  id: string;
  userId: string;
  clientId: string;
  tracking: string;
  orderNumber: string;
  packerName: string;
  station: string;
  startedAt: string;
  duration: number;
  bytes: number;
  mimeType: string;
  interrupted: boolean;
  state: CaptureState;
  error?: string;
  cancelled?: boolean;
}
export interface StartIntent { userId: string; clientId: string; tracking: string; station: string }

let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('fulfill-video-backups-v1', 2);
    request.onupgradeneeded = () => {
      const instance = request.result;
      if (!instance.objectStoreNames.contains('jobs')) instance.createObjectStore('jobs', { keyPath: 'id' });
      if (!instance.objectStoreNames.contains('chunks')) {
        const chunks = instance.createObjectStore('chunks', { keyPath: ['jobId', 'sequence'] });
        chunks.createIndex('jobId', 'jobId');
      }
      if (!instance.objectStoreNames.contains('intents')) instance.createObjectStore('intents', { keyPath: 'userId' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => { request.result.close(); database = undefined; };
      resolve(request.result);
    };
    request.onerror = () => { database = undefined; reject(request.error || new Error('Penyimpanan browser tidak tersedia.')); };
  });
  return database;
}
export async function storeStartIntent(intent: StartIntent): Promise<void> {
  const transaction = (await db()).transaction('intents', 'readwrite');
  transaction.objectStore('intents').put(intent);
  await completed(transaction);
}
export async function getStartIntent(userId: string): Promise<StartIntent | undefined> {
  return requestValue((await db()).transaction('intents').objectStore('intents').get(userId));
}
export async function deleteStartIntent(userId: string): Promise<void> {
  const transaction = (await db()).transaction('intents', 'readwrite');
  transaction.objectStore('intents').delete(userId);
  await completed(transaction);
}
function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Penyimpanan browser gagal.'));
  });
}
function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Penyimpanan browser gagal.'));
    transaction.onabort = () => reject(transaction.error || new Error('Penyimpanan browser dibatalkan.'));
  });
}
export async function storeRecording(job: LocalRecording): Promise<void> {
  const instance = await db();
  const transaction = instance.transaction('jobs', 'readwrite');
  transaction.objectStore('jobs').put(job);
  await completed(transaction);
}
export async function addRecordingChunk(job: LocalRecording, sequence: number, blob: Blob): Promise<void> {
  const instance = await db();
  const transaction = instance.transaction(['jobs', 'chunks'], 'readwrite');
  transaction.objectStore('chunks').put({ jobId: job.id, sequence, blob });
  transaction.objectStore('jobs').put(job);
  await completed(transaction);
}
export async function listRecordings(userId: string): Promise<LocalRecording[]> {
  const instance = await db();
  const all = await requestValue(instance.transaction('jobs').objectStore('jobs').getAll()) as LocalRecording[];
  return all.filter(job => job.userId === userId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export async function recoverRecordings(userId: string): Promise<LocalRecording[]> {
  const jobs = await listRecordings(userId);
  for (const job of jobs) {
    if (job.state === 'capturing') {
      job.state = 'queued';
      job.interrupted = true;
      job.error = 'Rekaman terputus. Cadangan akan disimpan sebagai bukti terputus; pesanan perlu direkam ulang.';
      await storeRecording(job);
    } else if (job.state === 'uploading') {
      job.state = 'queued';
      await storeRecording(job);
    }
  }
  return jobs;
}
export async function recordingBlob(job: LocalRecording): Promise<Blob> {
  const instance = await db();
  const parts = await requestValue(instance.transaction('chunks').objectStore('chunks').index('jobId').getAll(job.id)) as {sequence: number; blob: Blob}[];
  parts.sort((a, b) => a.sequence - b.sequence);
  return new Blob(parts.map(part => part.blob), { type: job.mimeType });
}
export async function deleteRecording(job: LocalRecording): Promise<void> {
  const instance = await db();
  const transaction = instance.transaction(['jobs', 'chunks'], 'readwrite');
  transaction.objectStore('jobs').delete(job.id);
  const cursor = transaction.objectStore('chunks').index('jobId').openKeyCursor(IDBKeyRange.only(job.id));
  cursor.onsuccess = () => {
    if (cursor.result) {
      transaction.objectStore('chunks').delete(cursor.result.primaryKey);
      cursor.result.continue();
    }
  };
  await completed(transaction);
}
export function supportedRecordingMime(): string {
  if (typeof MediaRecorder === 'undefined') throw new Error('Browser belum mendukung perekaman. Gunakan Chrome atau Edge versi terbaru.');
  for (const mime of ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm', 'video/mp4']) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  throw new Error('Format rekaman tidak didukung. Gunakan Chrome atau Edge versi terbaru.');
}
export function durationLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}
