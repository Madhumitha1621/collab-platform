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
- Redis is not part of the durability path.

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

## Scaling path (P1)

The system currently runs as a single instance (PRD §9.5). To scale out:
1. Add `@hocuspocus/extension-redis` so document updates and awareness reach every instance.
2. Replace the in-memory `PubSub` in `EventsService` with a Redis-backed PubSub. The internal
   `access$` subject also has to cross instances.
3. Compaction is already safe across instances (advisory lock). Insert batching is per instance, which
   is fine because updates are idempotent.
4. Load-test reconnect bursts and queue saturation before enabling it.
