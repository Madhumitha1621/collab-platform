import 'reflect-metadata';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { DataSource } from 'typeorm';
import * as Y from 'yjs';

process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://collab:collab@localhost:5433/collab_test';
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.COLLAB_PORT = '0';
process.env.PERSIST_FLUSH_MS = '50';
process.env.SNAPSHOT_UPDATE_THRESHOLD = process.env.SNAPSHOT_UPDATE_THRESHOLD ?? '200';

// Imported after env is set because config is read when modules initialise.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require('../src/main') as typeof import('../src/main');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CollaborationService } = require('../src/collaboration/collaboration.service') as typeof import('../src/collaboration/collaboration.service');

export interface TestApp {
  app: INestApplication;
  collabUrl: string;
  close(): Promise<void>;
}

export async function startApp(): Promise<TestApp> {
  const app = await createApp({ logger: false });
  await app.listen(0);
  const port = app.get(CollaborationService).port;
  return { app, collabUrl: `ws://127.0.0.1:${port}`, close: () => app.close() };
}

export async function resetDatabase(app: INestApplication) {
  await app
    .get(DataSource)
    .query(
      'TRUNCATE document_snapshots, document_updates, documents, workspace_members, workspaces, sessions, users RESTART IDENTITY CASCADE',
    );
}

export async function gql<T = any>(app: INestApplication, query: string, variables: object = {}, token?: string) {
  const req = request(app.getHttpServer()).post('/graphql').send({ query, variables });
  if (token) req.set('Authorization', `Bearer ${token}`);
  const res = await req;
  return res.body as { data: T; errors?: Array<{ message: string; extensions: { code: string } }> };
}

let counter = 0;
export async function registerUser(app: INestApplication, name = 'user') {
  counter++;
  const email = `${name}-${counter}-${Date.now()}@example.com`;
  const res = await gql(
    app,
    `mutation($input: RegisterInput!) { register(input: $input) { token user { id name email } } }`,
    { input: { name, email, password: 'password123' } },
  );
  if (res.errors) throw new Error(res.errors[0].message);
  return res.data.register as { token: string; user: { id: string; name: string; email: string } };
}

/** Owner with a workspace and one document. */
export async function setupWorkspace(app: INestApplication) {
  const owner = await registerUser(app, 'owner');
  const ws = await gql(app, `mutation { createWorkspace(input: { name: "Team" }) { id } }`, {}, owner.token);
  const workspaceId = ws.data.createWorkspace.id as string;
  const doc = await gql(
    app,
    `mutation($input: CreateDocumentInput!) { createDocument(input: $input) { id } }`,
    { input: { workspaceId, title: 'Spec' } },
    owner.token,
  );
  return { owner, workspaceId, documentId: doc.data.createDocument.id as string };
}

export async function addMember(app: INestApplication, ownerToken: string, workspaceId: string, email: string, role: string) {
  const res = await gql(
    app,
    `mutation($input: InviteWorkspaceMemberInput!) { inviteWorkspaceMember(input: $input) { userId role } }`,
    { input: { workspaceId, email, role } },
    ownerToken,
  );
  if (res.errors) throw new Error(res.errors[0].message);
}

export interface TestClient {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  text: Y.Text;
  scope?: string;
  authFailure?: string;
  stateless: string[];
  closeCodes: number[];
  destroy(): void;
}

export function connect(url: string, documentId: string, token: string | null): TestClient {
  const ydoc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url, delay: 50, minDelay: 50, maxDelay: 200, factor: 1 });
  const client: TestClient = {
    ydoc,
    socket,
    text: ydoc.getText('content'),
    stateless: [],
    closeCodes: [],
    provider: null as unknown as HocuspocusProvider,
    destroy: () => {
      client.provider.destroy();
      socket.destroy();
    },
  };
  client.provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: documentId,
    document: ydoc,
    token,
    onAuthenticated: ({ scope }) => (client.scope = scope),
    onAuthenticationFailed: ({ reason }) => (client.authFailure = reason),
    onStateless: ({ payload }) => client.stateless.push(payload),
    onClose: ({ event }) => client.closeCodes.push(event.code),
  });
  // Shared sockets are only attached explicitly.
  client.provider.attach();
  return client;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export const waitSynced = (c: TestClient, label = 'sync') => waitFor(() => c.provider.isSynced, 5000, label);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
