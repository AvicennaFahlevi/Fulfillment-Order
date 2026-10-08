import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth';
import Brand from './components/Brand';
import Login from './pages/Login';
import Admin from './pages/Admin';
import Picker from './pages/Picker';
import Packer from './pages/Packer';
import type { Role } from './types';
function Protected({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading, error, refresh, logout } = useAuth();
  const [logoutError, setLogoutError] = useState('');
  const [leaving, setLeaving] = useState(false);
  if (loading) return <div className="full-state"><Brand /><span className="spinner" /><p>Menyiapkan ruang kerja…</p></div>;
  if (error) return <div className="full-state"><Brand /><p className="alert alert-error">{error}</p><button className="btn btn-primary" onClick={() => void refresh().catch(() => {})}>Coba lagi</button></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={`/${user.role}`} replace />;
  if (role === 'admin') return children;
  return <><header className="station-header"><Brand /><span className="station-role">{role === 'picker' ? 'Picking station' : 'Packing station'}</span><div className="station-user"><span><strong>{user.name}</strong><small>{role === 'picker' ? 'Picker' : 'Packer'}</small></span><button className="icon-button" title="Keluar" aria-label="Keluar" disabled={leaving} onClick={async () => { setLeaving(true); try { await logout(); } catch (err) { setLogoutError(err instanceof Error ? err.message : 'Gagal keluar'); } finally { setLeaving(false); } }}><LogOut size={19} /></button></div></header>{logoutError && <div className="alert alert-error station-error">{logoutError}</div>}{children}</>;
}
function Home() { const { user, loading } = useAuth(); if (loading) return <div className="full-state"><span className="spinner" /></div>; return <Navigate to={user ? `/${user.role}` : '/login'} replace />; }
export default function App() { return <BrowserRouter><AuthProvider><Routes><Route path="/login" element={<Login />} /><Route path="/admin" element={<Protected role="admin"><Admin /></Protected>} /><Route path="/picker" element={<Protected role="picker"><Picker /></Protected>} /><Route path="/packer" element={<Protected role="packer"><Packer /></Protected>} /><Route path="*" element={<Home />} /></Routes></AuthProvider></BrowserRouter>; }
