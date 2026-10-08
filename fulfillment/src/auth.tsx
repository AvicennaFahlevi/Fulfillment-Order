import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import type { User } from './types';
interface AuthValue { user: User | null; loading: boolean; error: string; refresh: () => Promise<void>; logout: () => Promise<void> }
const AuthContext = createContext<AuthValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { const data = await api<{ user: User | null }>('/api/auth/me'); setUser(data.user); setError(''); }
    catch (err) { setError(err instanceof Error ? err.message : 'Gagal memuat sesi.'); throw err; }
    finally { setLoading(false); }
  }, []);
  const logout = useCallback(async () => {
    const beforeLogout = new CustomEvent('fulfill:before-logout', { cancelable: true });
    if (!window.dispatchEvent(beforeLogout)) throw new Error('Selesaikan rekaman dan simpan cadangan sebelum keluar.');
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  }, []);
  useEffect(() => { void refresh().catch(() => {}); }, [refresh]);
  return <AuthContext.Provider value={{ user, loading, error, refresh, logout }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('AuthProvider is required'); return context; }
