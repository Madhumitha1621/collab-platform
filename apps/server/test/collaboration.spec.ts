import { DataSource } from 'typeorm';
import * as Y from 'yjs';
import {
  addMember,
  connect,
  gql,
  registerUser,
  resetDatabase,
  setupWorkspace,
  sleep,
  startApp,
  waitFor,
  waitSynced,
  type TestApp,
  type TestClient,
} from './helpers';

describe('Collaboration server (Yjs over Hocuspocus)', () => {
  let t: TestApp;
  const clients: TestClient[] = [];
  const open = (...args: Parameters<typeof connect>) => {
    const c = connect(...args);
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    t = await startApp();
    await resetDatabase(t.app);
  });
  afterEach(() => {
    while (clients.length) clients.pop()!.destroy();
  });
  afterAll(() => t?.close());

  async function storedText(documentId: string): Promise<string> {
    const rows: Array<{ data: Buffer }> = await t.app.get(DataSource).query(
      `SELECT state_data AS data FROM document_snapshots WHERE document_id = $1
       UNION ALL SELECT update_data FROM document_updates WHERE document_id = $1`,
      [documentId],
    );
    const doc = new Y.Doc();
    for (const row of rows) Y.applyUpdate(doc, new Uint8Array(row.data));
    return doc.getText('content').toString();
  }

  it('merges concurrent edits to the same paragraph and converges', async () => {
    const { owner, documentId } = await setupWorkspace(t.app);
    const a = open(t.collabUrl, documentId, owner.token);
    const b = open(t.collabUrl, documentId, owner.token);
    await Promise.all([waitSynced(a), waitSynced(b)]);

    a.text.insert(0, 'Hello world');
    await waitFor(() => b.text.toString() === 'Hello world', 5000, 'b receives a');

    // Concurrent edits at the same position, without waiting in between.
    a.text.insert(5, ' brave');
    b.text.insert(5, ' new');
    b.text.delete(0, 1);
    await waitFor(() => a.text.toString() === b.text.toString() && a.text.length > 11, 5000, 'convergence');
    expect(a.text.toString()).toContain('brave');
    expect(a.text.toString()).toContain('new');
    expect(a.text.toString().startsWith('ello')).toBe(true);
  });

  it('rejects unauthenticated, invalid and unauthorized connections', async () => {
    const { documentId } = await setupWorkspace(t.app);
    const outsider = await registerUser(t.app, 'outsider');

    const noToken = open(t.collabUrl, documentId, null);
    const badToken = open(t.collabUrl, documentId, 'garbage');
    const nonMember = open(t.collabUrl, documentId, outsider.token);
    const badDocument = open(t.collabUrl, 'not-a-uuid', outsider.token);
    await waitFor(() => [noToken, badToken, nonMember, badDocument].every((c) => c.authFailure), 5000, 'auth failures');

    expect(noToken.authFailure).toBe('unauthenticated');
    expect(badToken.authFailure).toBe('unauthenticated');
    expect(nonMember.authFailure).toBe('forbidden');
    expect(badDocument.authFailure).toBe('invalid-document');
    expect(nonMember.text.toString()).toBe('');
  });

  it('lets viewers read but rejects their writes, even via direct protocol messages', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(t.app);
    const viewer = await registerUser(t.app, 'viewer');
    await addMember(t.app, owner.token, workspaceId, viewer.user.email, 'VIEWER');

    const editor = open(t.collabUrl, documentId, owner.token);
    const reader = open(t.collabUrl, documentId, viewer.token);
    await Promise.all([waitSynced(editor), waitSynced(reader)]);
    expect(reader.scope).toBe('readonly');

    editor.text.insert(0, 'official');
    await waitFor(() => reader.text.toString() === 'official', 5000, 'viewer receives update');

    // The provider sends this as a normal Yjs update message; the server must drop it.
    reader.text.insert(0, 'HACKED ');
    await sleep(500);
    expect(editor.text.toString()).toBe('official');

    // A fresh client sees only the authoritative content, and nothing was persisted.
    const fresh = open(t.collabUrl, documentId, owner.token);
    await waitSynced(fresh);
    expect(fresh.text.toString()).toBe('official');
    await sleep(200);
    expect(await storedText(documentId)).toBe('official');
  });

  it('persists edits and acknowledges them with a state vector covering the client clock', async () => {
    const { owner, documentId } = await setupWorkspace(t.app);
    const a = open(t.collabUrl, documentId, owner.token);
    await waitSynced(a);
    a.text.insert(0, 'durable text');

    await waitFor(
      () =>
        a.stateless.some((raw) => {
          const msg = JSON.parse(raw);
          if (msg.type !== 'persistence' || msg.status !== 'saved') return false;
          const sv = Y.decodeStateVector(Buffer.from(msg.stateVector, 'base64'));
          return (sv.get(a.ydoc.clientID) ?? 0) >= a.text.length;
        }),
      5000,
      'save acknowledgement',
    );
    expect(await storedText(documentId)).toBe('durable text');
  });

  it('reconnects after a disconnect and synchronises missed and offline changes', async () => {
    const { owner, documentId } = await setupWorkspace(t.app);
    const a = open(t.collabUrl, documentId, owner.token);
    const b = open(t.collabUrl, documentId, owner.token);
    await Promise.all([waitSynced(a), waitSynced(b)]);
    a.text.insert(0, 'base.');
    await waitFor(() => b.text.toString() === 'base.', 5000, 'initial');

    a.socket.disconnect();
    await waitFor(() => a.socket.status === 'disconnected', 5000, 'a offline');
    b.text.insert(b.text.length, ' from-b');
    a.text.insert(a.text.length, ' offline-a');

    await a.socket.connect();
    await waitFor(
      () => a.text.toString() === b.text.toString() && a.text.toString().includes('from-b') && b.text.toString().includes('offline-a'),
      8000,
      'reconnect convergence',
    );
  });

  it('tolerates duplicated and out-of-order update delivery', async () => {
    const { owner, documentId } = await setupWorkspace(t.app);
    const a = open(t.collabUrl, documentId, owner.token);
    await waitSynced(a);

    const source = new Y.Doc();
    const updates: Uint8Array[] = [];
    source.on('update', (u: Uint8Array) => updates.push(u));
    source.getText('content').insert(0, 'one ');
    source.getText('content').insert(4, 'two ');
    source.getText('content').insert(8, 'three');

    // Replay out of order and twice.
    for (const u of [updates[2], updates[0], updates[2], updates[1], updates[0]]) Y.applyUpdate(a.ydoc, u);
    const b = open(t.collabUrl, documentId, owner.token);
    await waitSynced(b);
    await waitFor(() => b.text.toString() === 'one two three', 5000, 'dedupe');
    await sleep(200);
    expect(await storedText(documentId)).toBe('one two three');
  });

  it('closes live sessions when a member is removed', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(t.app);
    const member = await registerUser(t.app, 'member');
    await addMember(t.app, owner.token, workspaceId, member.user.email, 'EDITOR');
    const c = open(t.collabUrl, documentId, member.token);
    await waitSynced(c);

    await gql(
      t.app,
      `mutation($input: RemoveWorkspaceMemberInput!) { removeWorkspaceMember(input: $input) }`,
      { input: { workspaceId, userId: member.user.id } },
      owner.token,
    );
    await waitFor(() => c.authFailure === 'forbidden', 5000, 're-auth rejection');
    expect(c.closeCodes).toContain(4401);

    // Writes after revocation never reach the server.
    c.text.insert(0, 'too late');
    await sleep(300);
    expect(await storedText(documentId)).toBe('');
  });

  it('downgrades a live editor to read-only when their role changes', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(t.app);
    const member = await registerUser(t.app, 'member');
    await addMember(t.app, owner.token, workspaceId, member.user.email, 'EDITOR');
    const c = open(t.collabUrl, documentId, member.token);
    await waitSynced(c);
    expect(c.scope).toBe('read-write');

    await gql(
      t.app,
      `mutation($input: UpdateMemberRoleInput!) { updateMemberRole(input: $input) { role } }`,
      { input: { workspaceId, userId: member.user.id, role: 'VIEWER' } },
      owner.token,
    );
    await waitFor(() => c.scope === 'readonly', 5000, 'readonly scope after reconnect');
  });

  it('ends collaboration sessions on logout and on document archive', async () => {
    const { owner, documentId } = await setupWorkspace(t.app);
    const c = open(t.collabUrl, documentId, owner.token);
    await waitSynced(c);
    await gql(t.app, `mutation($id: ID!) { archiveDocument(id: $id) { id } }`, { id: documentId }, owner.token);
    await waitFor(() => c.authFailure === 'forbidden', 5000, 'archived document closes session');

    const second = await setupWorkspace(t.app);
    const d = open(t.collabUrl, second.documentId, second.owner.token);
    await waitSynced(d);
    await gql(t.app, `mutation { logout }`, {}, second.owner.token);
    await waitFor(() => d.authFailure === 'unauthenticated', 5000, 'logout closes session');
  });
});

describe('Restart recovery', () => {
  it('restores persisted content after the application restarts', async () => {
    let t = await startApp();
    await resetDatabase(t.app);
    const { owner, documentId } = await setupWorkspace(t.app);

    const a = connect(t.collabUrl, documentId, owner.token);
    await waitSynced(a);
    a.text.insert(0, 'survives restarts');
    await waitFor(() => a.stateless.some((s) => s.includes('"saved"')), 5000, 'saved');
    a.destroy();
    await t.close();

    t = await startApp();
    try {
      const b = connect(t.collabUrl, documentId, owner.token);
      await waitSynced(b);
      expect(b.text.toString()).toBe('survives restarts');
      b.destroy();
    } finally {
      await t.close();
    }
  });
});
