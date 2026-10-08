export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.name = 'ApiError'; this.status = status; this.code = code; }
}
export const json = (data: unknown): string => JSON.stringify(data);
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (typeof options.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let response: Response;
  try { response = await fetch(path, { ...options, headers, credentials: 'same-origin' }); }
  catch (error) { if (error instanceof DOMException && error.name === 'AbortError') throw error; throw new ApiError('Tidak dapat terhubung ke server. Periksa koneksi lalu coba lagi.', 0); }
  const data = await response.json().catch(() => null) as { error?: string; code?: string } | null;
  if (!response.ok) throw new ApiError(data?.error || `Permintaan gagal (${response.status}). Silakan coba lagi.`, response.status, data?.code);
  return data as T;
}
