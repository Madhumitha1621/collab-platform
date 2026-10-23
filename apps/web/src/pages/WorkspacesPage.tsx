import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { gql, type Workspace } from '../api';

export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    gql<{ myWorkspaces: Workspace[] }>(`query { myWorkspaces { id name ownerId myRole } }`)
      .then((d) => setWorkspaces(d.myWorkspaces))
      .catch((e) => setError(e.message));

  useEffect(() => {
    void load();
  }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    setError(null);
    try {
      await gql(`mutation($input: CreateWorkspaceInput!) { createWorkspace(input: $input) { id } }`, { input: { name } });
      setName('');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <section>
      <h1>Workspaces</h1>
      <form className="inline-form" onSubmit={create}>
        <input placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        <button type="submit">Create</button>
      </form>
      {error && <p className="error">{error}</p>}
      {workspaces === null ? (
        <p className="muted">Loading…</p>
      ) : workspaces.length === 0 ? (
        <p className="muted">No workspaces yet. Create one to get started.</p>
      ) : (
        <ul className="list">
          {workspaces.map((w) => (
            <li key={w.id}>
              <Link to={`/w/${w.id}`}>{w.name}</Link>
              <span className="badge">{w.myRole.toLowerCase()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
