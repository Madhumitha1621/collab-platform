# Architecture

## Components

```
 Browser (React + TipTap + Yjs)
   │  GraphQL over HTTP  ── queries/mutations (workspaces, members, document metadata)
   │  GraphQL over WS    ── subscriptions (workspaceActivity, documentMetadataChanged)
   │  Yjs over WS        ── HocuspocusProvider: sync + awareness (cursors, presence)
   ▼
 NestJS process
   ├─ :4000  Express + Apollo  ── AuthResolver, WorkspacesResolver, DocumentsResolver, /health, /metrics
   └─ :1234  Hocuspocus server ── CollaborationService (auth hooks, rate limits, revocation)
                │
                ├─ AccessService       (one authorization policy for GraphQL and Yjs)
                └─ PersistenceService  (update log, snapshots, acknowledgements)
                        │
                        ▼
                   PostgreSQL (users, sessions, workspaces, workspace_members,
                               documents, document_updates, document_snapshots)

 Optional, when REDIS_URL is set: every instance also connects to Redis
   ├─ @hocuspocus/extension-redis  ── Yjs updates, awareness, stateless messages (per document)
   ├─ RedisPubSub (EventsService)  ── GraphQL subscription events
   └─ <prefix>:access channel      ── AccessEvents (revocation)
```

## Decision: Yjs provider (PRD §6.3)

**Chosen: Hocuspocus** (`@hocuspocus/server` + `@hocuspocus/provider`, v3), embedded in the NestJS
process on its own port. It is a maintained implementation of the standard y-protocols sync and
awareness messages and is TipTap's native collaboration backend. We did **not** write a custom
protocol handler or route editor updates through a NestJS Socket.IO gateway or GraphQL subscriptions.

NestJS keeps ownership of everything the PRD assigns to it, via Hocuspocus hooks:

| Hook | What it does |
|---|---|
| `onAuthenticate` | Validates the JWT and server-side session, validates the document UUID, checks workspace membership via `AccessService`. Viewers get `connectionConfig.readOnly = true`. |
| `beforeHandleMessage` | Per-connection rate limit and message-size check (ws `maxPayload` also caps frames). |
| `onLoadDocument` | Loads snapshot + update log from PostgreSQL. If loading fails the connection is refused, so an empty document is never served or saved over real content. |
| `onChange` | Queues the binary update for persistence. |
| `onStoreDocument` | Flushes the queue (Hocuspocus calls this when the last client leaves and on shutdown). |

**Read-only enforcement** happens on the server: for a read-only connection Hocuspocus does not apply
`SyncStep2` or `Update` messages. The test suite sends real protocol updates from a viewer and asserts
that they are neither applied nor persisted.

GraphQL subscriptions and Hocuspocus run on separate ports. That avoids two WebSocket servers
competing for HTTP upgrade requests on one port.

## Persistence and recovery guarantees (PRD FR-06, §9.2)

**Write path.** Every accepted update is added to an in-memory queue for its document. Every
`PERSIST_FLUSH_MS` (500 ms by default), the queue is merged with `Y.mergeUpdates` and written as **one
row** in `document_updates`. Writes for the same document run one at a time. Keystrokes never wait
on the database.

**Acknowledgement.** When a flush succeeds, the server broadcasts a stateless message:
`{type:"persistence", status:"saved", stateVector}`. The state vector describes the document at the
moment the queue was drained, and every update it covers is now durable. A client compares that vector
with its own clock (`stateVector[myClientId] >= myClock`) to show "All changes saved". The
`beforeunload` warning stays active until this holds.

**Failure handling.** A failed insert is retried with exponential backoff, up to
`PERSIST_MAX_RETRIES` attempts. If it still fails, the updates go back on the queue (they are never
dropped), `persistence_flush_failures_total` increments, and clients receive `status:"error"`. The UI
then shows "Save failing — retrying". The next tick retries.

**Recovery point objective.**
- After a clean shutdown, nothing is lost: Nest shutdown hooks flush every queue.
- After a crash, the loss window is the updates accepted since the last successful flush (normally
  ≤ `PERSIST_FLUSH_MS`, longer only while the database is failing). Clients never see those edits
  acknowledged. Connected clients still hold them, and the Yjs sync handshake re-sends them on
  reconnect, so in practice they are only lost if every client that had them is gone too.
- Redis is not part of the durability path. Losing Redis stops cross-instance fan-out, not saving.

**Read path.** The latest snapshot plus every update with `id > snapshot.last_applied_update_id`,
read in one `REPEATABLE READ` transaction so a concurrent compaction cannot hide rows.

**Compaction.** Once a document has `SNAPSHOT_UPDATE_THRESHOLD` update rows (200 by default), the
snapshot and updates are combined into a new snapshot. The new state is decoded and verified before
it is written. Covered updates and older *unlabelled* snapshots are then deleted, all in one
transaction under a per-document advisory lock. `createDocumentSnapshot(label)` creates labelled
snapshots, which are kept as restore points.

**Idempotence.** Yjs updates are commutative and idempotent. Duplicate or out-of-order delivery,
including duplicate rows in `document_updates`, converges to the same state. This is covered by tests.

## Authorization and revocation (FR-08)

- `AccessService` is the only place that decides access. Non-members get `NOT_FOUND`, not `FORBIDDEN`,
  so the API does not reveal whether a resource exists.
- Sessions live in a `sessions` table. A JWT carries `{sub, sid}`, and logout revokes the `sid`.
- Role changes, member removal, logout and document archival emit an internal `AccessEvent`.
  `CollaborationService` closes the affected sockets with code `4401`. The provider reconnects and
  authenticates again, so the user gets the new role (read-only) or is rejected (`forbidden`).
- GraphQL subscription filters check membership again for each event.

## Multiple instances through Redis (P1)

Setting `REDIS_URL` turns on cross-instance fan-out. Without it, nothing connects to Redis and the
server behaves as a single instance (PRD §9.5). All channels and keys use `REDIS_PREFIX`
(default `collab`), so several environments can share one Redis.

**Documents.** `CollaborationService` adds `@hocuspocus/extension-redis` (keys under
`<prefix>:yjs`). Each instance that has a document loaded subscribes to that document's channel and
relays sync messages, awareness and stateless messages to the others. A client on instance A and a
client on instance B therefore edit the same Yjs document, see each other's cursors, and get the
same save acknowledgements.

**Persistence with several instances.** Each instance still loads from PostgreSQL and writes its own
queue. Updates relayed from other instances also go into that queue. As a result, a `saved`
acknowledgement from any instance only covers updates that instance has written itself, so the
guarantee above still holds when acknowledgements cross instances. The cost is duplicate rows: up to
one per instance that has the document loaded. Yjs updates are idempotent, and compaction (under a
per-document advisory lock) folds the duplicates into the next snapshot. The Redis extension's
`onStoreDocument` takes a Redis lock and stops the hook chain on instances that don't hold it.
For that reason the application extension has a higher priority (1001 vs 1000), so its flush always
runs first. Hocuspocus then logs `Could not acquire lock…` on those instances. That message is
expected and harmless.

**Subscriptions.** `EventsService.pubSub` becomes a `RedisPubSub`. Payloads are JSON, and the Date
fields (`occurredAt`, `createdAt`, `updatedAt`, `archivedAt`) are revived on receipt. Subscription
filters still check membership again for each event on the receiving instance.

**Revocation.** `emitAccess` delivers the event to the local `access$` right away, then publishes it
on `<prefix>:access` with the instance's id. The other instances push it into their own `access$`
(skipping their own messages), and each closes its matching sockets with `4401`. Because local
delivery doesn't depend on Redis, revocation on the instance that handled the mutation still works
during a Redis outage. Remote instances miss the event while Redis is down. Those sessions are
still checked again on their next reconnect, and the subscriber reconnects automatically.

**Health.** `/health` reports `redis: up | down | disabled`. `down` returns 503, so a load balancer
takes the instance out of rotation.

**Still to do before production scale-out:** load-test reconnect bursts and queue saturation across
instances, and use sticky sessions or connection draining when deploying.
