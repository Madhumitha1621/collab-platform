import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { gql } from '../api';

export interface ActivityEntry {
  id: string;
  type: string;
  documentId: string | null;
  documentTitle: string | null;
  detail: string | null;
  actorName: string | null;
  targetUserName: string | null;
  createdAt: string;
}

const FIELDS = 'id type documentId documentTitle detail actorName targetUserName createdAt';

function describe(entry: ActivityEntry): string {
  const who = entry.targetUserName ?? 'a member';
  const role = entry.detail?.toLowerCase();
  switch (entry.type) {
    case 'DOCUMENT_CREATED':
      return 'created';
    case 'DOCUMENT_RENAMED':
      return `renamed “${entry.detail}” to`;
    case 'DOCUMENT_ARCHIVED':
      return 'archived';
    case 'WORKSPACE_UPDATED':
      return `renamed the workspace to “${entry.detail}”`;
    case 'MEMBER_ADDED':
      return `added ${who} as ${role}`;
    case 'MEMBER_ROLE_UPDATED':
      return `made ${who} ${role}`;
    case 'MEMBER_REMOVED':
      return `removed ${who}`;
    case 'INVITATION_SENT':
      return `invited ${entry.detail}`;
    case 'INVITATION_REVOKED':
      return `revoked the invitation for ${entry.detail}`;
    case 'INVITATION_ACCEPTED':
      return `joined as ${role}`;
    case 'SNAPSHOT_CREATED':
      return `saved version “${entry.detail}” of`;
    case 'SNAPSHOT_RESTORED':
      return `restored version “${entry.detail}” of`;
    default:
      return entry.type.toLowerCase().replace(/_/g, ' ');
  }
}

function timeAgo(iso: string): string {
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Workspace history; `version` changes whenever a live workspace event arrives. */
export function ActivityFeed({ workspaceId, version }: { workspaceId: string; version: number }) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);

  const load = useCallback(
    async (before?: string) => {
      const data = await gql<{ activityLog: ActivityEntry[] }>(
        `query($id: ID!, $before: ID) { activityLog(workspaceId: $id, limit: 15, before: $before) { ${FIELDS} } }`,
        { id: workspaceId, before },
      );
      setHasMore(data.activityLog.length === 15);
      setEntries((prev) => (before ? [...prev, ...data.activityLog] : data.activityLog));
    },
    [workspaceId],
  );

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load, version]);

  return (
    <section className="card">
      <h2>Activity</h2>
      {entries.length === 0 ? (
        <p className="muted small">Nothing has happened yet.</p>
      ) : (
        <ol className="activity">
          {entries.map((entry) => (
            <li key={entry.id}>
              <span>
                <strong>{entry.actorName ?? 'Someone'}</strong> {describe(entry)}{' '}
                {entry.documentId && entry.documentTitle && entry.type !== 'DOCUMENT_ARCHIVED' ? (
                  <Link to={`/d/${entry.documentId}`}>{entry.documentTitle}</Link>
                ) : (
                  entry.documentTitle && <em>{entry.documentTitle}</em>
                )}
              </span>
              <time className="muted small" dateTime={entry.createdAt} title={new Date(entry.createdAt).toLocaleString()}>
                {timeAgo(entry.createdAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
      {hasMore && (
        <button className="ghost" onClick={() => void load(entries[entries.length - 1]?.id)}>
          Show older
        </button>
      )}
    </section>
  );
}
