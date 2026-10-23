# Collab — real-time collaborative documents

MVP of the Real-Time Collaboration Platform PRD (v1.0). Several people can edit a rich-text
document at the same time, with live cursors and presence. Every edit is saved to PostgreSQL, and
work survives disconnects and server restarts.

| Layer | Tech |
|---|---|
| API | NestJS 11, GraphQL (Apollo, code-first), TypeORM + migrations, JWT + server-side sessions |
| Collaboration | Yjs, Hocuspocus 3 (standard y-protocols sync + awareness) embedded in the Nest process |
| Storage | PostgreSQL 16: binary update log (`BYTEA`) + compacted snapshots |
| Web | React 19, Vite, TipTap 3 (Collaboration + CollaborationCaret) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the provider decision, persistence and
acknowledgement guarantees, recovery point, and revocation design.

## Run locally

Requires Node 20+.

```bash
npm install
```

Start PostgreSQL on `localhost:5433`, using **either** Docker:

```bash
npm run db:up
```

or the Docker-free embedded PostgreSQL (keep it running in its own terminal):

```bash
npm run db:local -w apps/server
```

Configure and start the API. Migrations run automatically on boot. Set `JWT_SECRET` in `.env` to a
long random string.

```bash
cp apps/server/.env.example apps/server/.env
```

```bash
npm run dev:server
```

In another terminal, start the web app (http://localhost:5173):

```bash
npm run dev:web
```

Optional demo data (three accounts, a workspace and a document; it prints the logins):

```bash
npm run seed:demo -w apps/server
```

To see collaboration, open the printed document link as two different users: use two browser
profiles, or one normal and one private window.

| Endpoint | Purpose |
|---|---|
| `http://localhost:4000/graphql` | GraphQL API + GraphiQL (non-production) |
| `ws://localhost:4000/graphql` | GraphQL subscriptions (`graphql-ws`) |
| `ws://localhost:1234` | Yjs collaboration (Hocuspocus) |
| `GET /health` | DB status, active documents/connections, persistence queue |
| `GET /metrics` | Prometheus metrics (queue depth, flush failures, rejected messages…) |

The full GraphQL schema is generated to `apps/server/schema.gql` on boot.

## Tests

The tests run against the `collab_test` database, which both the Docker and the embedded setup create.

```bash
npm test
```

| Suite | Covers |
|---|---|
| `graphql.spec.ts` | Register/login/logout (token revoked), invalid tokens, validation, workspace isolation, role enforcement, archive, owner protection |
| `collaboration.spec.ts` | Concurrent same-paragraph edits converge; unauthenticated/forbidden/invalid joins rejected; **viewer writes rejected at protocol level and never persisted**; save acknowledgement; disconnect/offline edits/reconnect; duplicate + out-of-order updates; live revocation on member removal, role downgrade, logout and archive; **restart recovery** |
| `persistence.spec.ts` | Snapshot + log reconstruction, threshold compaction preserves content, labelled snapshots kept, **DB outage keeps updates queued, reports error, then recovers** |

## Configuration (`apps/server/.env`)

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `JWT_SECRET` | — | Signing secret (required) |
| `JWT_EXPIRES_IN_SECONDS` | 86400 | Session lifetime |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allowed origins |
| `COLLAB_PORT` | 1234 | Hocuspocus port |
| `COLLAB_MAX_MESSAGE_BYTES` | 1048576 | Max collaboration message size |
| `COLLAB_MAX_MESSAGES_PER_SECOND` | 200 | Per-connection rate limit |
| `PERSIST_FLUSH_MS` | 500 | Batch window for writing updates |
| `PERSIST_MAX_RETRIES` | 5 | Retries per flush before reporting an error |
| `SNAPSHOT_UPDATE_THRESHOLD` | 200 | Update rows before compaction |

Web: `VITE_API_URL` (default `http://localhost:4000/graphql`) and `VITE_COLLAB_URL` (default `ws://localhost:1234`).

## Scope status vs. PRD

**Done (P0):** auth (register/login/logout, revocable sessions); workspaces and roles; document
create/list/rename/archive; rich text (paragraphs, H1/H2, bold, italic, bullet and numbered lists,
links, collaborative undo/redo); Yjs sync; cursors and presence; PostgreSQL persistence with
batching, retries, compaction and acknowledgements; reconnection and restart recovery; server-side
authorization, including live revocation; input validation; message size and rate limits;
structured GraphQL errors; health and metrics; automated tests. Also done: `createDocumentSnapshot`
(named restore points), and GraphQL subscriptions for application events.

**Not yet (P1):** email invitations (P0 adds *existing* users by email), title search, snapshot
restore UI, activity history table, Redis cross-instance fan-out (see the scaling path in
ARCHITECTURE.md), load tests, production deployment, frontend automated tests.
