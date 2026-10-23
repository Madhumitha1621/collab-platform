import { createClient, type Client } from 'graphql-ws';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { DataSource } from 'typeorm';
import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  addMember,
  connect,
  gql,
  registerUser,
  resetDatabase,
  setupWorkspace,
  startApp,
  waitFor,
  waitSynced,
  type TestApp,
  type TestClient,
} from './helpers';

/**
 * Two application instances on the same PostgreSQL and Redis, as behind a load balancer.
 * Requires Redis at TEST_REDIS_URL (default redis://localhost:6379), e.g. `npm run redis:up`.
 */
describe('Cross-instance collaboration through Redis', () => {
  let a: TestApp;
  let b: TestApp;
  const clients: TestClient[] = [];
  const wsClients: Client[] = [];
  const open = (...args: Parameters<typeof connect>) => {
    const c = connect(...args);
    clients.push(c);
    return c;
  };

  beforeAll(async () => {
    process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
    // A fresh namespace per run, so stale messages from other runs cannot interfere.
    process.env.REDIS_PREFIX = `collab-test-${randomUUID()}`;
    // Sequential: both instances run migrations on boot.
    a = await startApp();
    b = await startApp();
    await resetDatabase(a.app);
  });
  afterEach(async () => {
    while (clients.length) clients.pop()!.destroy();
    while (wsClients.length) await wsClients.pop()!.dispose();
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_PREFIX;
  });

  it('reports Redis as up on both instances', async () => {
    for (const t of [a, b]) {
      const health = (await (await fetch(`${httpUrl(t)}/health`)).json()) as { redis: string };
      expect(health.redis).toBe('up');
    }
  });

  it('converges edits and presence from clients on different instances', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(a.app);
    const member = await registerUser(b.app, 'member');
    await addMember(a.app, owner.token, workspaceId, member.user.email, 'EDITOR');

    const onA = open(a.collabUrl, documentId, owner.token);
    const onB = open(b.collabUrl, documentId, member.token);
    await Promise.all([waitSynced(onA, 'sync on A'), waitSynced(onB, 'sync on B')]);

    onA.text.insert(0, 'Hello world');
    await waitFor(() => onB.text.toString() === 'Hello world', 5000, 'B receives edit made on A');

    // Concurrent edits at the same position on both instances.
    onA.text.insert(5, ' brave');
    onB.text.insert(5, ' new');
    onB.text.delete(0, 1);
    await waitFor(
      () => onA.text.toString() === onB.text.toString() && onA.text.toString().includes('brave') && onA.text.toString().includes('new'),
      5000,
      'cross-instance convergence',
    );
    expect(onA.text.toString().startsWith('ello')).toBe(true);

    // Awareness (cursors/presence) crosses instances too.
    onA.provider.setAwarenessField('user', { name: 'owner-on-a' });
    await waitFor(
      () => [...onB.provider.awareness!.getStates().values()].some((s) => s.user?.name === 'owner-on-a'),
      5000,
      'presence from A visible on B',
    );

    // A client that joins later, on either instance, gets the converged state.
    const late = open(b.collabUrl, documentId, owner.token);
    await waitSynced(late, 'late joiner');
    await waitFor(() => late.text.toString() === onA.text.toString(), 5000, 'late joiner converges');

    // Both instances write the updates they hold; the duplicates decode to the same content.
    const expected = onA.text.toString();
    await waitFor(async () => (await storedText(documentId)) === expected, 5000, 'persisted state matches');
  });

  it('closes a removed member’s session on the other instance', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(a.app);
    const member = await registerUser(a.app, 'member');
    await addMember(a.app, owner.token, workspaceId, member.user.email, 'EDITOR');

    const ownerOnA = open(a.collabUrl, documentId, owner.token);
    const memberOnB = open(b.collabUrl, documentId, member.token);
    await Promise.all([waitSynced(ownerOnA), waitSynced(memberOnB)]);
    expect(memberOnB.scope).toBe('read-write');

    // The mutation is handled by instance A; the session lives on instance B.
    const res = await gql(
      a.app,
      `mutation($input: RemoveWorkspaceMemberInput!) { removeWorkspaceMember(input: $input) }`,
      { input: { workspaceId, userId: member.user.id } },
      owner.token,
    );
    expect(res.errors).toBeUndefined();
    await waitFor(() => memberOnB.authFailure === 'forbidden', 5000, 're-auth rejected on B');
    expect(memberOnB.closeCodes).toContain(4401);

    // Writes after revocation never reach the other instance.
    memberOnB.text.insert(0, 'too late');
    ownerOnA.text.insert(0, 'kept');
    await waitFor(() => ownerOnA.text.toString() === 'kept', 2000, 'owner edit');
    await new Promise((r) => setTimeout(r, 300));
    expect(ownerOnA.text.toString()).toBe('kept');
  });

  it('ends sessions on every instance at logout', async () => {
    const { owner, documentId } = await setupWorkspace(a.app);
    const onB = open(b.collabUrl, documentId, owner.token);
    await waitSynced(onB);
    await gql(a.app, `mutation { logout }`, {}, owner.token);
    await waitFor(() => onB.authFailure === 'unauthenticated', 5000, 'logout on A closes session on B');
  });

  it('delivers GraphQL subscription events published by another instance', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(a.app);
    const client = createClient({
      url: `${httpUrl(b).replace('http', 'ws')}/graphql`,
      webSocketImpl: WebSocket,
      connectionParams: { authorization: `Bearer ${owner.token}` },
      retryAttempts: 0,
    });
    wsClients.push(client);

    const received: Array<{ type: string; documentId?: string; occurredAt: string }> = [];
    const errors: unknown[] = [];
    let ready = false;
    client.subscribe(
      { query: `subscription($id: ID!) { workspaceActivity(workspaceId: $id) { type documentId occurredAt } }`, variables: { id: workspaceId } },
      { next: (msg) => received.push((msg.data as any).workspaceActivity), error: (e) => errors.push(e), complete: () => undefined },
    );
    client.on('connected', () => (ready = true));
    await waitFor(() => ready, 5000, 'subscription connected');
    // Give the server time to register the Redis subscription.
    await new Promise((r) => setTimeout(r, 300));

    await gql(a.app, `mutation($input: RenameDocumentInput!) { renameDocument(input: $input) { id } }`, { input: { id: documentId, title: 'Renamed' } }, owner.token);
    await waitFor(() => received.length > 0, 5000, 'subscription event from A on B');
    expect(errors).toEqual([]);
    expect(received[0]).toMatchObject({ type: 'DOCUMENT_RENAMED', documentId });
    expect(Number.isNaN(Date.parse(received[0].occurredAt))).toBe(false);
  });

  async function storedText(documentId: string): Promise<string> {
    const rows: Array<{ data: Buffer }> = await a.app.get(DataSource).query(
      `SELECT state_data AS data FROM document_snapshots WHERE document_id = $1
       UNION ALL SELECT update_data FROM document_updates WHERE document_id = $1`,
      [documentId],
    );
    const doc = new Y.Doc();
    for (const row of rows) Y.applyUpdate(doc, new Uint8Array(row.data));
    return doc.getText('content').toString();
  }
});

function httpUrl(t: TestApp) {
  const { port } = t.app.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
