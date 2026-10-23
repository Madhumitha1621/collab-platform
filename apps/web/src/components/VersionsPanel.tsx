import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { gql } from '../api';

interface Version {
  id: string;
  label: string;
  createdAt: string;
  createdByName: string | null;
}

/** Named versions of a document: save the current state, or restore an earlier one. */
export function VersionsPanel({ documentId, canEdit }: { documentId: string; canEdit: boolean }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      gql<{ documentSnapshots: Version[] }>(
        `query($id: ID!) { documentSnapshots(documentId: $id) { id label createdAt createdByName } }`,
        { id: documentId },
      ).then((d) => setVersions(d.documentSnapshots)),
    [documentId],
  );

  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await gql(`mutation($input: CreateDocumentSnapshotInput!) { createDocumentSnapshot(input: $input) { id } }`, {
        input: { documentId, label: label.trim() || undefined },
      });
      setLabel('');
    });
  };

  return (
    <aside className="card versions">
      <h2>Versions</h2>
      {canEdit && (
        <form className="inline-form" onSubmit={save}>
          <input placeholder="Name this version" value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} />
          <button type="submit" disabled={busy}>
            Save
          </button>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
      {versions.length === 0 ? (
        <p className="muted small">No saved versions yet.</p>
      ) : (
        <ol className="version-list">
          {versions.map((v) => (
            <li key={v.id}>
              <div>
                <strong>{v.label}</strong>
                <div className="muted small">
                  {new Date(v.createdAt).toLocaleString()}
                  {v.createdByName && ` · ${v.createdByName}`}
                </div>
              </div>
              {canEdit && (
                <button
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Restore “${v.label}”? The current content is saved as a version first.`)) {
                      void run(() => gql(`mutation($id: ID!) { restoreDocumentSnapshot(snapshotId: $id) { id } }`, { id: v.id }));
                    }
                  }}
                >
                  Restore
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}
