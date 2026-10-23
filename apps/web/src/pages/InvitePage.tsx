import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { gql } from '../api';
import { useAuth } from '../auth';

interface Preview {
  email: string;
  role: string;
  status: string;
  workspaceName: string;
  invitedByName: string;
  expiresAt: string;
}

export function InvitePage() {
  const { token = '' } = useParams();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    gql<{ invitation: Preview }>(
      `query($t: String!) { invitation(token: $t) { email role status workspaceName invitedByName expiresAt } }`,
      { t: token },
    )
      .then((d) => setPreview(d.invitation))
      .catch((e) => setError(e.message));
  }, [token]);

  async function accept() {
    setBusy(true);
    setError(null);
    try {
      const d = await gql<{ acceptWorkspaceInvitation: { id: string } }>(
        `mutation($t: String!) { acceptWorkspaceInvitation(token: $t) { id } }`,
        { t: token },
      );
      navigate(`/w/${d.acceptWorkspaceInvitation.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!preview) return <p className={error ? 'error pad' : 'muted pad'}>{error ?? 'Loading invitation…'}</p>;

  const wrongAccount = user && user.email.toLowerCase() !== preview.email;
  return (
    <div className="card auth-card">
      <p className="eyebrow">Invitation</p>
      <h1>Join {preview.workspaceName}</h1>
      <p>
        {preview.invitedByName} invited <strong>{preview.email}</strong> to collaborate as{' '}
        <span className="badge">{preview.role.toLowerCase()}</span>.
      </p>
      {preview.status !== 'PENDING' ? (
        <p className="banner">This invitation is {preview.status.toLowerCase()}. Ask for a new one if you still need access.</p>
      ) : wrongAccount ? (
        <>
          <p className="banner">
            You're signed in as {user.email}. Sign in as {preview.email} to accept.
          </p>
          <button className="ghost" onClick={() => void logout()}>
            Switch account
          </button>
        </>
      ) : (
        <button onClick={() => void accept()} disabled={busy}>
          Accept invitation
        </button>
      )}
      {error && <p className="error">{error}</p>}
      <p className="muted small">
        <Link to="/">Back to your workspaces</Link>
      </p>
    </div>
  );
}
