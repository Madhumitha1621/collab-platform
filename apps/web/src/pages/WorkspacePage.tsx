import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { gql, subscribe, type DocumentMeta, type Member, type Role, type Workspace } from '../api';
import { useAuth } from '../auth';
import { ActivityFeed } from '../components/ActivityFeed';

interface WorkspaceDetail extends Workspace {
  members: Member[];
}

const ROLES: Role[] = ['OWNER', 'EDITOR', 'VIEWER'];

interface PendingInvitation {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export function WorkspacePage() {
  const { workspaceId = '' } = useParams();
  const { user } = useAuth();
  const [workspace, setWorkspace] = useState<WorkspaceDetail | null>(null);
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('EDITOR');
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [activityVersion, setActivityVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await gql<{ workspace: WorkspaceDetail; documents: DocumentMeta[] }>(
        `query($id: ID!) {
          workspace(id: $id) { id name ownerId myRole members { userId role user { id name email } } }
          documents(workspaceId: $id) { id workspaceId title updatedAt archivedAt myRole }
        }`,
        { id: workspaceId },
      );
      setWorkspace(data.workspace);
      setDocuments(data.documents);
      setError(null);
      if (data.workspace.myRole === 'OWNER') {
        const pending = await gql<{ workspaceInvitations: PendingInvitation[] }>(
          `query($id: ID!) { workspaceInvitations(workspaceId: $id) { id email role expiresAt } }`,
          { id: workspaceId },
        );
        setInvitations(pending.workspaceInvitations);
      }
    } catch (err) {
      setError((err as Error).message);
      setWorkspace(null);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
    // Any workspace activity (new docs, renames, membership changes) refreshes the view.
    return subscribe(
      `subscription($id: ID!) { workspaceActivity(workspaceId: $id) { type } }`,
      { id: workspaceId },
      () => {
        void load();
        setActivityVersion((v) => v + 1);
      },
    );
  }, [workspaceId, load]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      await load();
      setActivityVersion((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!workspace) return error ? <p className="error pad">{error}</p> : <p className="muted pad">Loading…</p>;

  const canEdit = workspace.myRole !== 'VIEWER';
  const isOwner = workspace.myRole === 'OWNER';

  return (
    <div className="workspace-layout">
      <section>
        <p className="crumbs">
          <Link to="/">Workspaces</Link> /
        </p>
        <h1>{workspace.name}</h1>
        {error && <p className="error">{error}</p>}
        {canEdit && (
          <form
            className="inline-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                await gql(`mutation($input: CreateDocumentInput!) { createDocument(input: $input) { id } }`, {
                  input: { workspaceId, title },
                });
                setTitle('');
              });
            }}
          >
            <input placeholder="New document title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} />
            <button type="submit">New document</button>
          </form>
        )}
        {documents.length === 0 ? (
          <p className="muted">No documents yet.</p>
        ) : (
          <ul className="list">
            {documents.map((d) => (
              <li key={d.id}>
                <Link to={`/d/${d.id}`}>{d.title}</Link>
                <span className="muted small">{new Date(d.updatedAt).toLocaleString()}</span>
                {canEdit && (
                  <span className="row-actions">
                    <button
                      className="ghost"
                      onClick={() => {
                        const next = window.prompt('Rename document', d.title);
                        if (next && next.trim() && next !== d.title) {
                          void run(() =>
                            gql(`mutation($input: RenameDocumentInput!) { renameDocument(input: $input) { id } }`, {
                              input: { id: d.id, title: next },
                            }),
                          );
                        }
                      }}
                    >
                      Rename
                    </button>
                    <button
                      className="ghost danger"
                      onClick={() => {
                        if (window.confirm(`Archive “${d.title}”?`)) {
                          void run(() => gql(`mutation($id: ID!) { archiveDocument(id: $id) { id } }`, { id: d.id }));
                        }
                      }}
                    >
                      Archive
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <aside className="card">
        <h2>Members</h2>
        <ul className="members">
          {workspace.members.map((m) => (
            <li key={m.userId}>
              <div>
                <strong>{m.user.name}</strong>
                {m.userId === user?.id && <span className="muted"> (you)</span>}
                <div className="muted small">{m.user.email}</div>
              </div>
              {isOwner && m.userId !== workspace.ownerId ? (
                <span className="row-actions">
                  <select
                    value={m.role}
                    aria-label={`Role for ${m.user.name}`}
                    onChange={(e) =>
                      void run(() =>
                        gql(`mutation($input: UpdateMemberRoleInput!) { updateMemberRole(input: $input) { userId } }`, {
                          input: { workspaceId, userId: m.userId, role: e.target.value },
                        }),
                      )
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r.toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <button
                    className="ghost danger"
                    onClick={() =>
                      window.confirm(`Remove ${m.user.name}?`) &&
                      void run(() =>
                        gql(`mutation($input: RemoveWorkspaceMemberInput!) { removeWorkspaceMember(input: $input) }`, {
                          input: { workspaceId, userId: m.userId },
                        }),
                      )
                    }
                  >
                    Remove
                  </button>
                </span>
              ) : (
                <span className="badge">{m.role.toLowerCase()}</span>
              )}
            </li>
          ))}
        </ul>
        {isOwner && (
          <form
            className="stack"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void run(async () => {
                await gql(`mutation($input: SendWorkspaceInvitationInput!) { sendWorkspaceInvitation(input: $input) { id } }`, {
                  input: { workspaceId, email: inviteEmail, role: inviteRole },
                });
                setNotice(`Invitation sent to ${inviteEmail}`);
                setInviteEmail('');
              });
            }}
          >
            <label>
              Invite by email
              <input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} required />
            </label>
            <div className="inline-form">
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as Role)} aria-label="Role">
                <option value="EDITOR">editor</option>
                <option value="VIEWER">viewer</option>
                <option value="OWNER">owner</option>
              </select>
              <button type="submit">Send invite</button>
            </div>
            {notice && <p className="success small">{notice}</p>}
          </form>
        )}
        {isOwner && invitations.length > 0 && (
          <>
            <h3>Pending invitations</h3>
            <ul className="members">
              {invitations.map((inv) => (
                <li key={inv.id}>
                  <div>
                    {inv.email}
                    <div className="muted small">
                      {inv.role.toLowerCase()} · expires {new Date(inv.expiresAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    className="ghost danger"
                    onClick={() =>
                      void run(() => gql(`mutation($id: ID!) { revokeWorkspaceInvitation(id: $id) }`, { id: inv.id }))
                    }
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
      <div className="workspace-activity">
        <ActivityFeed workspaceId={workspaceId} version={activityVersion} />
      </div>
    </div>
  );
}
