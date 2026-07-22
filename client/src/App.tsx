import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Sent } from './pages/Sent';
import { Inbox } from './pages/Inbox';
import { Documents } from './pages/Documents';
import { BulkCompose } from './pages/BulkCompose';
import { ShareView } from './pages/ShareView';

const ProtectedRoute = ({ children }: { children: React.ReactNode }) => {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div style={{ padding: 60, textAlign: 'center', color: '#94a3b8' }}>Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

const Shell = ({ children }: { children: React.ReactNode }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return <>{children}</>;

  return (
    <div style={s.shell}>
      {/* Sidebar */}
      <aside style={s.sidebar}>
        <div style={s.brand}>
          <span style={s.brandIcon}>✉</span>
          <span style={s.brandName}>MailTrack</span>
        </div>

        <nav style={s.nav}>
          <NavLink to="/sent" style={({ isActive }) => ({ ...s.navItem, ...(isActive ? s.navActive : {}) })}>
            <span style={s.navIcon}>📤</span> Sent
          </NavLink>
          <NavLink to="/inbox" style={({ isActive }) => ({ ...s.navItem, ...(isActive ? s.navActive : {}) })}>
            <span style={s.navIcon}>📥</span> Inbox
          </NavLink>
          <NavLink to="/documents" style={({ isActive }) => ({ ...s.navItem, ...(isActive ? s.navActive : {}) })}>
            <span style={s.navIcon}>📄</span> Documents
          </NavLink>
          <NavLink to="/bulk" style={({ isActive }) => ({ ...s.navItem, ...(isActive ? s.navActive : {}) })}>
            <span style={s.navIcon}>📨</span> Mass Email
          </NavLink>
        </nav>

        <div style={s.userSection}>
          <div style={s.userAvatar}>{user.name.charAt(0).toUpperCase()}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={s.userName}>{user.name}</div>
            <div style={s.userEmail}>{user.emailAddress}</div>
          </div>
          <button style={s.logoutBtn} title="Sign out" onClick={() => { logout(); navigate('/login'); }}>
            ↩
          </button>
        </div>
      </aside>

      {/* Main */}
      <main style={s.main}>{children}</main>
    </div>
  );
};

const AppRoutes = () => (
  <Routes>
    {/* Public share page — no sidebar */}
    <Route path="/share/:token" element={<ShareView />} />

    {/* Everything else gets the Shell wrapper */}
    <Route path="*" element={
      <Shell>
        <Routes>
          <Route path="/login"    element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/sent"     element={<ProtectedRoute><Sent /></ProtectedRoute>} />
          <Route path="/inbox"    element={<ProtectedRoute><Inbox /></ProtectedRoute>} />
          <Route path="/documents" element={<ProtectedRoute><Documents /></ProtectedRoute>} />
          <Route path="/bulk"     element={<ProtectedRoute><BulkCompose /></ProtectedRoute>} />
          <Route path="*"         element={<Navigate to="/sent" replace />} />
        </Routes>
      </Shell>
    } />
  </Routes>
);

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}

const s: Record<string, React.CSSProperties> = {
  shell: { display: 'flex', height: '100vh', overflow: 'hidden' },

  sidebar: {
    width: 220, flexShrink: 0,
    background: '#0f172a',
    display: 'flex', flexDirection: 'column',
    borderRight: '1px solid rgba(255,255,255,0.05)',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10, padding: '20px 16px 16px' },
  brandIcon: { fontSize: '1.2rem' },
  brandName: { color: '#f1f5f9', fontWeight: 700, fontSize: '1rem', letterSpacing: '-0.02em' },

  nav: { flex: 1, padding: '4px 8px', display: 'flex', flexDirection: 'column', gap: 2 },
  navItem: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '9px 12px', borderRadius: 8,
    color: '#94a3b8', fontSize: '0.875rem', fontWeight: 500,
    transition: 'background 0.15s, color 0.15s',
    textDecoration: 'none',
  },
  navActive: { background: 'rgba(255,255,255,0.08)', color: '#f1f5f9' },
  navIcon: { fontSize: '0.9rem' },

  userSection: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: '12px 14px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
  },
  userAvatar: {
    width: 32, height: 32, borderRadius: '50%',
    background: '#1e40af', color: '#93c5fd',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 700, fontSize: '0.8rem', flexShrink: 0,
  },
  userName: { fontSize: '0.8rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  userEmail: { fontSize: '0.7rem', color: '#475569', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  logoutBtn: { background: 'none', border: 'none', color: '#475569', fontSize: '1rem', padding: '4px 6px', borderRadius: 6, flexShrink: 0 },

  main: { flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', background: '#fff' },
};
