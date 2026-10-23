import { HocuspocusProvider } from '@hocuspocus/provider';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import * as Y from 'yjs';
import { COLLAB_URL, gql, subscribe, type DocumentMeta, type User } from '../api';
import { useAuth } from '../auth';
import { VersionsPanel } from '../components/VersionsPanel';

const COLORS = ['#d9480f', '#2b8a3e', '#1971c2', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5f3dc4'];

function colorFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

export function DocumentPage() {
  const { documentId = '' } = useParams();
  const { user, token } = useAuth();
  const [meta, setMeta] = useState<DocumentMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    gql<{ document: DocumentMeta }>(
      `query($id: ID!) { document(id: $id) { id workspaceId title updatedAt archivedAt myRole } }`,
      { id: documentId },
    )
      .then((d) => setMeta(d.document))
      .catch((e) => setError(e.message));
    return subscribe<{ documentMetadataChanged: DocumentMeta }>(
      `subscription($id: ID!) { documentMetadataChanged(documentId: $id) { id workspaceId title updatedAt archivedAt } }`,
      { id: documentId },
      (d) => setMeta((prev) => (prev ? { ...prev, ...d.documentMetadataChanged } : prev)),
    );
  }, [documentId]);

  if (error) return <p className="error pad">{error}</p>;
  if (!meta || !user || !token) return <p className="muted pad">Loading…</p>;

  return (
    <section className="doc-page">
      <p className="crumbs">
        <Link to={`/w/${meta.workspaceId}`}>← Back to workspace</Link>
      </p>
      <h1>{meta.title}</h1>
      {meta.archivedAt ? (
        <p className="banner">This document is archived and can no longer be edited.</p>
      ) : (
        <div className="doc-layout">
          <CollaborationSession documentId={documentId} user={user} token={token} />
          <VersionsPanel documentId={documentId} canEdit={meta.myRole !== 'VIEWER'} />
        </div>
      )}
    </section>
  );
}

interface Session {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
}

/** Owns the Yjs document and provider for one open document. */
function CollaborationSession({ documentId, user, token }: { documentId: string; user: User; token: string }) {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    const ydoc = new Y.Doc();
    const provider = new HocuspocusProvider({ url: COLLAB_URL, name: documentId, document: ydoc, token });
    setSession({ ydoc, provider });
    return () => {
      provider.destroy();
      ydoc.destroy();
    };
  }, [documentId, token]);

  if (!session) return null;
  return <CollaborativeEditor key={session.ydoc.guid} session={session} user={user} />;
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';
type SaveStatus = 'saved' | 'saving' | 'error';

interface Peer {
  clientId: number;
  name: string;
  color: string;
}

function CollaborativeEditor({ session, user }: { session: Session; user: User }) {
  const { ydoc, provider } = session;
  const [connection, setConnection] = useState<ConnectionStatus>('connecting');
  const [synced, setSynced] = useState(false);
  const [scope, setScope] = useState<'read-write' | 'readonly' | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved');
  const [peers, setPeers] = useState<Peer[]>([]);
  const persisted = useRef<Map<number, number>>(new Map());
  const saveFailing = useRef(false);

  const editor = useEditor(
    {
      extensions: [
        // Yjs provides collaborative undo/redo; the built-in history would undo other people's edits.
        StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
        Collaboration.configure({ document: ydoc }),
        CollaborationCaret.configure({ provider, user: { name: user.name, color: colorFor(user.id) } }),
      ],
      // Never seed content: the server state is the source of truth and arrives on sync.
      editable: false,
    },
    [ydoc, provider],
  );

  useEffect(() => {
    // A save is acknowledged when the server's persisted state vector covers our own clock.
    const recompute = () => {
      const ours = Y.decodeStateVector(Y.encodeStateVector(ydoc)).get(ydoc.clientID) ?? 0;
      const stored = persisted.current.get(ydoc.clientID) ?? 0;
      setSaveStatus(ours <= stored ? 'saved' : saveFailing.current ? 'error' : 'saving');
    };
    const onStatus = ({ status }: { status: ConnectionStatus }) => setConnection(status);
    const onSynced = ({ state }: { state: boolean }) => setSynced(state);
    const onAuthenticated = ({ scope }: { scope: 'read-write' | 'readonly' }) => {
      setScope(scope);
      setAuthError(null);
    };
    const onAuthFailed = ({ reason }: { reason: string }) => setAuthError(reason);
    const onStateless = ({ payload }: { payload: string }) => {
      try {
        const message = JSON.parse(payload);
        if (message.type !== 'persistence') return;
        if (message.status === 'saved') {
          persisted.current = Y.decodeStateVector(fromBase64(message.stateVector));
          saveFailing.current = false;
        } else {
          saveFailing.current = true;
        }
        recompute();
      } catch {
        // Ignore malformed stateless messages.
      }
    };
    const onAwareness = () => {
      const list: Peer[] = [];
      provider.awareness?.getStates().forEach((state, clientId) => {
        if (state.user) list.push({ clientId, name: state.user.name, color: state.user.color });
      });
      setPeers(list);
    };

    provider.on('status', onStatus);
    provider.on('synced', onSynced);
    provider.on('authenticated', onAuthenticated);
    provider.on('authenticationFailed', onAuthFailed);
    provider.on('stateless', onStateless);
    provider.awareness?.on('change', onAwareness);
    ydoc.on('update', recompute);
    onAwareness();
    if (provider.isSynced) setSynced(true);
    return () => {
      provider.off('status', onStatus);
      provider.off('synced', onSynced);
      provider.off('authenticated', onAuthenticated);
      provider.off('authenticationFailed', onAuthFailed);
      provider.off('stateless', onStateless);
      provider.awareness?.off('change', onAwareness);
      ydoc.off('update', recompute);
    };
  }, [ydoc, provider]);

  const canEdit = scope === 'read-write' && synced && !authError;

  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  useEffect(() => {
    if (saveStatus === 'saved') return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveStatus]);

  if (authError) {
    return (
      <p className="banner error">
        {authError === 'forbidden'
          ? 'You no longer have access to this document.'
          : 'Your session is no longer valid. Please log in again.'}
      </p>
    );
  }

  return (
    <div className="editor-shell">
      <div className="editor-status">
        <StatusPill connection={connection} synced={synced} save={saveStatus} readOnly={scope === 'readonly'} />
        <ul className="presence" aria-label="Active collaborators">
          {peers.map((p) => (
            <li key={p.clientId} title={p.name} style={{ background: p.color }}>
              {p.name.slice(0, 1).toUpperCase()}
              {p.clientId === ydoc.clientID && <span className="sr-only"> (you)</span>}
            </li>
          ))}
        </ul>
      </div>
      {editor && canEdit && <Toolbar editor={editor} />}
      {!synced && <p className="muted">Loading document…</p>}
      <EditorContent editor={editor} className={`editor ${synced ? '' : 'hidden'}`} />
    </div>
  );
}

function StatusPill(props: { connection: ConnectionStatus; synced: boolean; save: SaveStatus; readOnly: boolean }) {
  let text: string;
  let tone: 'ok' | 'warn' | 'bad';
  if (props.connection !== 'connected') {
    text = props.connection === 'connecting' ? 'Connecting…' : 'Offline — reconnecting';
    tone = 'warn';
  } else if (!props.synced) {
    text = 'Syncing…';
    tone = 'warn';
  } else if (props.save === 'error') {
    text = 'Save failing — retrying';
    tone = 'bad';
  } else if (props.save === 'saving') {
    text = 'Saving…';
    tone = 'warn';
  } else {
    text = 'All changes saved';
    tone = 'ok';
  }
  return (
    <span className="status" data-tone={tone} role="status">
      <span className="dot" />
      {text}
      {props.readOnly && <span className="badge">view only</span>}
    </span>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
    }),
  });
  const chain = () => editor.chain().focus();
  const button = (label: string, active: boolean, run: () => void, disabled = false) => (
    <button
      type="button"
      className={active ? 'tool active' : 'tool'}
      aria-pressed={active}
      // Keep focus (and the selection) in the editor so the next keystroke isn't lost.
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
      disabled={disabled}
    >
      {label}
    </button>
  );
  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      {button('H1', state.h1, () => chain().toggleHeading({ level: 1 }).run())}
      {button('H2', state.h2, () => chain().toggleHeading({ level: 2 }).run())}
      {button('B', state.bold, () => chain().toggleBold().run())}
      {button('I', state.italic, () => chain().toggleItalic().run())}
      {button('• List', state.bullet, () => chain().toggleBulletList().run())}
      {button('1. List', state.ordered, () => chain().toggleOrderedList().run())}
      {button('Link', state.link, () => {
        if (state.link) return chain().unsetLink().run();
        const href = window.prompt('Link URL');
        if (href && /^(https?:|mailto:)/i.test(href)) chain().setLink({ href }).run();
      })}
      {button('Undo', false, () => chain().undo().run(), !state.canUndo)}
      {button('Redo', false, () => chain().redo().run(), !state.canRedo)}
    </div>
  );
}
