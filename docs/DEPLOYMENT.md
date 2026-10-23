# Deployment, operations and recovery

## The production stack

`docker-compose.prod.yml` runs everything behind a single origin:

```
 browser ──HTTPS──▶ your TLS proxy ──▶ web (nginx :80)
                                         ├─ /            static React app (SPA fallback)
                                         ├─ /graphql     ─▶ server:4000  (HTTP + graphql-ws)
                                         └─ /collab      ─▶ server:1234  (Yjs WebSocket)
                                       server ──▶ postgres:5432   (durable state)
                                              ──▶ redis:6379      (cross-instance fan-out)
```

```bash
cp .env.prod.example .env.prod
```

Edit `.env.prod` (see below), then start it:

```bash
npm run prod:up
```

Open `http://localhost:8080` (or `WEB_PORT`). Migrations run automatically when the server starts.
Only the web container publishes a port; PostgreSQL and Redis stay on the internal network.

### Configuration

| Variable | Required | Notes |
|---|---|---|
| `POSTGRES_PASSWORD` | yes | Database password |
| `JWT_SECRET` | yes | 32+ random bytes. Rotating it signs everyone out |
| `PUBLIC_URL` | yes | The URL users open. Used for CORS and invitation links |
| `SMTP_URL` | for email | e.g. `smtps://user:pass@smtp.example.com:465`. Without it, no invitation emails are sent |
| `MAIL_FROM` | no | Sender address for invitations |
| `WEB_PORT` | no | Host port for the web container (default 8080) |

Every server variable from `apps/server/.env.example` (flush interval, rate limits, snapshot
threshold…) can be added to the `server.environment` block.

### HTTPS and secure WebSockets

The PRD requires HTTPS/WSS in production. Terminate TLS in front of the web container, for example
with Caddy:

```
collab.example.com {
  reverse_proxy localhost:8080
}
```

Caddy (and most proxies) forward WebSocket upgrades automatically. The app uses relative URLs
(`/graphql`, `/collab`), so the browser upgrades to `wss://` on its own. Set `PUBLIC_URL` to the
`https://` address.

### Scaling out

Redis is already wired in. Run more server replicas:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --scale server=2
```

nginx resolves `server` to every replica. Edits, presence, subscriptions and access revocations
reach clients on any instance (see ARCHITECTURE.md). Load-test before relying on it (docs/PERFORMANCE.md).

## Health and monitoring

| Endpoint | Use |
|---|---|
| `GET /health` (server :4000) | `200` with `status: ok` when PostgreSQL (and Redis, if configured) are reachable; `503` otherwise. Used by the container healthcheck |
| `GET /metrics` (server :4000) | Prometheus text format |
| `GET /healthz` (web) | nginx liveness |

Alerts worth setting on `/metrics`:

| Metric | Alert when | Meaning |
|---|---|---|
| `persistence_flush_failures_total` | increasing | Database writes failing. Edits are held in memory and clients see "Save failing — retrying" |
| `persistence_queue_depth` | stays > 0 for minutes | Persistence is falling behind or blocked |
| `collab_rejected_messages_total` | sudden spike | Clients hitting rate or size limits (abuse or a misbehaving client) |
| `collab_rejected_connections_total` | sudden spike | Auth failures (expired tokens after a secret rotation, or probing) |

Logs are structured single lines (`document=… user=…`). Document content and tokens are never logged.

## Backup and recovery procedures

**PostgreSQL is the only state that matters.** Redis holds nothing durable, and the containers are
stateless.

### Back up

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres pg_dump -U collab -Fc collab > collab-$(date +%F).dump
```

Run it on a schedule and copy dumps off the host. Document content lives in `document_snapshots`
and `document_updates` as binary Yjs data, so a normal `pg_dump` captures it consistently.

### Restore into a fresh stack

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d postgres
```

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec -T postgres pg_restore -U collab -d collab --clean --if-exists < collab-2026-10-23.dump
```

```bash
npm run prod:up
```

### What happens on a crash

| Failure | Effect | Recovery |
|---|---|---|
| Server process restarts | Clients show "Offline — reconnecting", then reconnect automatically. Documents reload from PostgreSQL | Automatic. Edits acknowledged as saved are never lost. Unacknowledged edits (at most ~`PERSIST_FLUSH_MS`) are re-sent by connected clients during the Yjs sync handshake |
| PostgreSQL unavailable | New document joins fail (rather than serving an empty document). Open documents keep syncing; saves retry and clients see "Save failing — retrying" | Automatic once the database is back. Queued edits are written on the next flush |
| Redis unavailable (multi-instance) | `/health` reports degraded. Clients on different instances stop seeing each other's edits live. Each instance still persists its own edits | Automatic on reconnect. Clients converge on the next sync, since PostgreSQL has all updates |
| Bad edit or accidental deletion | — | Restore a named version in the editor's **Versions** panel. The restore is itself saved as a version first, so it can be undone |

### Verifying a recovery

1. `GET /health` returns `ok`.
2. Open a document that was being edited before the incident and check its content.
3. `persistence_queue_depth` is back to 0 and `persistence_flush_failures_total` has stopped growing.
