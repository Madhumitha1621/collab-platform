import type { ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { SearchBox } from './components/SearchBox';
import { AuthPage } from './pages/AuthPage';
import { DocumentPage } from './pages/DocumentPage';
import { InvitePage } from './pages/InvitePage';
import { WorkspacePage } from './pages/WorkspacePage';
import { WorkspacesPage } from './pages/WorkspacesPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted pad">Loading…</p>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          Collab
        </Link>
        {user && <SearchBox />}
        {user && (
          <div className="topbar-user">
            <span className="muted">{user.name}</span>
            <button className="ghost" onClick={() => void logout()}>
              Log out
            </button>
          </div>
        )}
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/login" element={<AuthPage mode="login" />} />
            <Route path="/register" element={<AuthPage mode="register" />} />
            <Route path="/" element={<RequireAuth><WorkspacesPage /></RequireAuth>} />
            <Route path="/w/:workspaceId" element={<RequireAuth><WorkspacePage /></RequireAuth>} />
            <Route path="/invite/:token" element={<RequireAuth><InvitePage /></RequireAuth>} />
            <Route path="/d/:documentId" element={<RequireAuth><DocumentPage /></RequireAuth>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AuthProvider>
  );
}
