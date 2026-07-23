import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { Sent } from './pages/Sent';
import { Inbox } from './pages/Inbox';
import { Documents } from './pages/Documents';
import { BulkCompose } from './pages/BulkCompose';
import { ShareView } from './pages/ShareView';

const ProtectedRoute = ({ children }: { children: React.ReactNode; }) => {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#ffffff] flex items-center justify-center font-mono text-xs text-[#64748b]">
        Loading workspace…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
};

const Shell = ({ children }: { children: React.ReactNode; }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) return <>{children}</>;

  return (
    <div className="flex h-screen bg-[#ffffff] text-[#0f172a] font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 bg-[#f8fafc] border-r border-[#eaedf1] flex flex-col justify-between">
        <div>
          {/* Brand Header */}
          <div className="px-6 py-5 border-b border-[#eaedf1] flex items-center gap-3">
            <div className="flex items-center justify-center size-8 rounded-lg border border-[#eaedf1] bg-[#ffffff] text-[#0f172a] shadow-sm">
              <svg width="16" height="20" viewBox="0 0 20 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M0 4.5C0 3.11929 1.11929 2 2.5 2H7.5C8.88071 2 10 3.11929 10 4.5V9.40959C10.0001 9.4396 10.0002 9.46975 10.0002 9.50001C10.0002 10.8787 11.1162 11.9968 12.4942 12C12.4961 12 12.4981 12 12.5 12H17.5C18.8807 12 20 13.1193 20 14.5V19.5C20 20.8807 18.8807 22 17.5 22H12.5C11.1193 22 10 20.8807 10 19.5V14.5C10 14.4931 10 14.4861 10.0001 14.4792C9.98891 13.1081 8.87394 12 7.50017 12C7.4937 12 7.48725 12 7.48079 12H2.5C1.11929 12 0 10.8807 0 9.5V4.5Z" fill="currentColor" />
              </svg>
            </div>
            <div className="flex flex-col text-left leading-none">
              <span className="text-[8px] font-mono font-bold tracking-[0.22em] text-[#F17463] uppercase">
                MXDUB
              </span>
              <span className="text-base font-semibold tracking-tight text-[#0f172a] mt-0.5">
                MailTrack
              </span>
            </div>
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1">
            <NavLink
              to="/sent"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive
                  ? 'bg-[#ffffff] text-[#0f172a] border border-[#eaedf1] shadow-sm'
                  : 'text-[#64748b] hover:text-[#0f172a] hover:bg-[#f1f5f9]'
                }`
              }
            >
              <svg className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
              Sent Feeds
            </NavLink>

            <NavLink
              to="/inbox"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive
                  ? 'bg-[#ffffff] text-[#0f172a] border border-[#eaedf1] shadow-sm'
                  : 'text-[#64748b] hover:text-[#0f172a] hover:bg-[#f1f5f9]'
                }`
              }
            >
              <svg className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
              </svg>
              Inbox
            </NavLink>

            <NavLink
              to="/documents"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive
                  ? 'bg-[#ffffff] text-[#0f172a] border border-[#eaedf1] shadow-sm'
                  : 'text-[#64748b] hover:text-[#0f172a] hover:bg-[#f1f5f9]'
                }`
              }
            >
              <svg className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Documents
            </NavLink>

            <NavLink
              to="/bulk"
              className={({ isActive }) =>
                `flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${isActive
                  ? 'bg-[#ffffff] text-[#0f172a] border border-[#eaedf1] shadow-sm'
                  : 'text-[#64748b] hover:text-[#0f172a] hover:bg-[#f1f5f9]'
                }`
              }
            >
              <svg className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Mass Dispatch
            </NavLink>
          </nav>
        </div>

        {/* User Footer */}
        <div className="p-4 border-t border-[#eaedf1] bg-[#ffffff] flex items-center gap-3">
          <div className="size-8 rounded-full bg-[#F17463]/10 text-[#F17463] border border-[#F17463]/20 flex items-center justify-center font-bold text-xs shrink-0">
            {user.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-xs font-semibold text-[#0f172a] truncate">{user.name}</div>
            <div className="text-[11px] text-[#64748b] truncate">{user.emailAddress}</div>
          </div>
          <button
            onClick={() => {
              logout();
              navigate('/login');
            }}
            title="Sign out"
            className="p-1.5 rounded-md text-[#64748b] hover:text-[#0f172a] hover:bg-[#f1f5f9] transition-colors"
          >
            <svg className="size-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 overflow-auto bg-[#ffffff] flex flex-col">{children}</main>
    </div>
  );
};

const AppRoutes = () => (
  <Routes>
    {/* Public share page — no sidebar */}
    <Route path="/share/:token" element={<ShareView />} />

    {/* Everything else gets the Shell wrapper */}
    <Route
      path="*"
      element={
        <Shell>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />
            <Route
              path="/sent"
              element={
                <ProtectedRoute>
                  <Sent />
                </ProtectedRoute>
              }
            />
            <Route
              path="/inbox"
              element={
                <ProtectedRoute>
                  <Inbox />
                </ProtectedRoute>
              }
            />
            <Route
              path="/documents"
              element={
                <ProtectedRoute>
                  <Documents />
                </ProtectedRoute>
              }
            />
            <Route
              path="/bulk"
              element={
                <ProtectedRoute>
                  <BulkCompose />
                </ProtectedRoute>
              }
            />
            <Route path="*" element={<Navigate to="/sent" replace />} />
          </Routes>
        </Shell>
      }
    />
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