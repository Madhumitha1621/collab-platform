// Load test for the collaboration server (PRD §9.1 targets).
//
// Measures, against a running API + collaboration server:
//   1. edit propagation latency  — N clients editing one document concurrently
//   2. persistence lag           — local edit -> server "saved" acknowledgement covering it
//   3. reconnect burst           — N clients reconnecting at once until all are synced
//   4. cold recovery             — loading a ~1 MB document from PostgreSQL after it was unloaded
//
// Usage: node scripts/load-test.mjs
// Env: API_URL, COLLAB_URL, CLIENTS (20), DURATION_S (20), EDITS_PER_SEC (2), RECOVERY_KB (1024)
//
// All clients run in this one Node process, so their own event-loop work is included in the
// numbers; treat results as an upper bound for same-region latency.
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { performance } from 'node:perf_hooks';
import * as Y from 'yjs';

const API_URL = process.env.API_URL ?? 'http://localhost:4000/graphql';
const COLLAB_URL = process.env.COLLAB_URL ?? 'ws://localhost:1234';
const CLIENTS = Number(process.env.CLIENTS ?? 20);
const DURATION_S = Number(process.env.DURATION_S ?? 20);
const EDITS_PER_SEC = Number(process.env.EDITS_PER_SEC ?? 2);
const RECOVERY_KB = Number(process.env.RECOVERY_KB ?? 1024);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables = {}, token) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

function percentiles(samples) {
  if (!samples.length) return { n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { n: sorted.length, p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] };
}

const fmt = (stats) =>
  stats.n ? `n=${stats.n}  p50=${stats.p50.toFixed(1)}ms  p95=${stats.p95.toFixed(1)}ms  p99=${stats.p99.toFixed(1)}ms  max=${stats.max.toFixed(1)}ms` : 'no samples';

function connect(documentId, token, hooks = {}) {
  const ydoc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({ url: COLLAB_URL });
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: documentId, document: ydoc, token, ...hooks });
  provider.attach();
  const synced = new Promise((resolve) => {
    if (provider.isSynced) resolve();
    provider.on('synced', ({ state }) => state && resolve());
  });
  return {
    ydoc,
    provider,
    synced,
    destroy() {
      provider.destroy();
      socket.destroy();
    },
  };
}

async function setup() {
  const email = `load+${Date.now().toString(36)}@load.test`;
  const { register } = await gql(`mutation($i: RegisterInput!) { register(input: $i) { token } }`, {
    i: { name: 'Load Tester', email, password: 'load-test-password' },
  });
  const token = register.token;
  const { createWorkspace } = await gql(`mutation { createWorkspace(input: { name: "Load test" }) { id } }`, {}, token);
  const doc = async (title) =>
    (await gql(`mutation($i: CreateDocumentInput!) { createDocument(input: $i) { id } }`, { i: { workspaceId: createWorkspace.id, title } }, token))
      .createDocument.id;
  return { token, liveDoc: await doc('Concurrent editing'), bigDoc: await doc('Recovery document') };
}

async function concurrentEditing(documentId, token) {
  const latency = [];
  const persistLag = [];
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const pending = []; // [clock, sentAt] of this client's own edits awaiting a save ack
    const client = connect(documentId, token, {
      onStateless: ({ payload }) => {
        const msg = JSON.parse(payload);
        if (msg.type !== 'persistence' || msg.status !== 'saved') return;
        const covered = Y.decodeStateVector(Buffer.from(msg.stateVector, 'base64')).get(client.ydoc.clientID) ?? 0;
        const now = performance.now();
        while (pending.length && pending[0][0] <= covered) persistLag.push(now - pending.shift()[1]);
      },
    });
    client.pending = pending;
    client.ydoc.getMap('probe').observe((event) => {
      if (event.transaction.local) return;
      const now = performance.now();
      for (const key of event.keysChanged) latency.push(now - event.target.get(key));
    });
    clients.push(client);
  }
  await Promise.all(clients.map((c) => c.synced));

  const text = (c) => c.ydoc.getText('body');
  const timers = clients.map((c) =>
    setInterval(() => {
      const sentAt = performance.now();
      c.ydoc.transact(() => {
        const t = text(c);
        t.insert(Math.floor(Math.random() * (t.length + 1)), 'x');
        c.ydoc.getMap('probe').set(String(c.ydoc.clientID), sentAt);
      });
      const clock = Y.decodeStateVector(Y.encodeStateVector(c.ydoc)).get(c.ydoc.clientID);
      c.pending.push([clock, sentAt]);
    }, 1000 / EDITS_PER_SEC),
  );
  await sleep(DURATION_S * 1000);
  timers.forEach(clearInterval);
  await sleep(2000); // let in-flight updates and acks arrive

  const reference = text(clients[0]).toString();
  const converged = clients.every((c) => text(c).toString() === reference);
  return { clients, latency: percentiles(latency), persistLag: percentiles(persistLag), converged, chars: reference.length };
}

async function reconnectBurst(clients, documentId, token) {
  clients.forEach((c) => c.destroy());
  await sleep(500);
  const started = performance.now();
  const fresh = Array.from({ length: CLIENTS }, () => connect(documentId, token));
  await Promise.all(fresh.map((c) => c.synced));
  const elapsed = performance.now() - started;
  fresh.forEach((c) => c.destroy());
  return elapsed;
}

async function coldRecovery(documentId, token) {
  const writer = connect(documentId, token, {});
  let saved = false;
  writer.provider.on('stateless', ({ payload }) => {
    if (JSON.parse(payload).status === 'saved') saved = true;
  });
  await writer.synced;
  const chunk = 'lorem ipsum dolor sit amet '.repeat(40).slice(0, 1024);
  const body = writer.ydoc.getText('body');
  // 64 KB per transaction, like pasting: one message each, well under the per-connection rate limit.
  for (let i = 0; i < RECOVERY_KB; i += 64) {
    writer.ydoc.transact(() => {
      for (let j = i; j < Math.min(i + 64, RECOVERY_KB); j++) body.insert(body.length, chunk);
    });
    await sleep(20);
  }
  const bytes = Y.encodeStateAsUpdate(writer.ydoc).byteLength;
  while (!saved) await sleep(50);
  saved = false;
  await sleep(1000);
  writer.destroy();
  // With no connections left, the server stores and unloads the document; the next join loads it from PostgreSQL.
  await sleep(4000);

  const started = performance.now();
  const reader = connect(documentId, token);
  await reader.synced;
  const elapsed = performance.now() - started;
  const ok = reader.ydoc.getText('body').length === body.length;
  reader.destroy();
  return { elapsed, bytes, ok };
}

const { token, liveDoc, bigDoc } = await setup();
console.log(`Load test: ${CLIENTS} clients x ${EDITS_PER_SEC} edits/s for ${DURATION_S}s against ${COLLAB_URL}\n`);

const editing = await concurrentEditing(liveDoc, token);
console.log(`Edit propagation      ${fmt(editing.latency)}`);
console.log(`Persistence lag       ${fmt(editing.persistLag)}`);
console.log(`Convergence           ${editing.converged ? 'all clients identical' : 'DIVERGED'} (${editing.chars} chars)`);

const burst = await reconnectBurst(editing.clients, liveDoc, token);
console.log(`Reconnect burst       ${CLIENTS} clients synced in ${burst.toFixed(0)}ms`);

const recovery = await coldRecovery(bigDoc, token);
console.log(
  `Cold recovery         ${(recovery.bytes / 1024).toFixed(0)} KB Yjs state loaded from PostgreSQL in ${recovery.elapsed.toFixed(0)}ms (${recovery.ok ? 'content intact' : 'CONTENT MISMATCH'})`,
);

const pass = editing.converged && recovery.ok;
process.exit(pass ? 0 : 1);
