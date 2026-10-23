# Performance

PRD §9.1 sets initial engineering targets and asks for a repeatable load test to validate them.
That load test is [`apps/server/scripts/load-test.mjs`](../apps/server/scripts/load-test.mjs).

## Results

Measured on 2026-10-23 against the **production build** (`NODE_ENV=production node dist/main.js`),
single instance, PostgreSQL 16 on the same machine. Hardware: Intel Core i5-13420H, 16 GB RAM,
Windows 11. All clients ran in one Node process on the same machine, so their own event-loop work is
included. Treat these as upper bounds for same-region latency.

### Target workload: 20 users editing one document

20 clients × 2 edits/s for 20 s; every edit also writes a timestamp probe that the other 19 clients
time on arrival.

| Metric | PRD target | Measured | |
|---|---|---|---|
| Edit propagation p95 | ≤ 250 ms | **28.5 ms** (p50 7.5, p99 39.0, max 49.1; n = 14,820) | ✅ |
| Persistence lag (edit → durable "saved" ack) | ≤ 1 s | **p95 512 ms** (max 531 ms; n = 780) | ✅ |
| Recovery of a 1 MB document | ≤ 3 s | **98 ms**: cold load from PostgreSQL after the server unloaded it | ✅ |
| Convergence | all clients identical | identical (780 chars) | ✅ |
| Reconnect burst | — | 20 clients re-synced in 381 ms | |
| Rejected messages | — | 0 | |

### Stress: 50 users, 5 edits/s each (6× the edit rate of the target workload)

| Metric | Measured |
|---|---|
| Edit propagation | p50 66 ms · **p95 156 ms** · p99 204 ms · max 448 ms (n = 194,236) |
| Persistence lag | p50 348 ms · **p95 598 ms** · max 708 ms |
| Convergence | all 50 clients identical (3,964 chars) |
| Reconnect burst | 50 clients re-synced in 1.3 s |
| Recovery of a 1 MB document | 70 ms |

Even at this load, every PRD target holds.

### Reading the numbers

- **Persistence lag** is dominated by `PERSIST_FLUSH_MS` (500 ms). An edit waits for the next flush
  tick, then one batched insert (~20 ms). Lower the interval for a smaller loss window, at the cost of
  more, smaller rows.
- **Cold recovery** reads one compacted snapshot plus the update log in a single `REPEATABLE READ`
  transaction. Compaction (`SNAPSHOT_UPDATE_THRESHOLD`) keeps the log short, so load time tracks
  document size, not edit history.
- **Rate limiting**: the server allows 200 messages/s per connection (`COLLAB_MAX_MESSAGES_PER_SECOND`).
  Typing never gets close. An early version of the test fired 1,024 separate 1 KB inserts in under a
  second and was correctly throttled (the client reconnected and lost nothing). The script now
  inserts in paste-sized transactions.

## Run it yourself

Start an API (ideally a production build) and run:

```bash
npm run build -w apps/server
```

```bash
npm run load-test -w apps/server
```

| Env var | Default | Meaning |
|---|---|---|
| `API_URL` | `http://localhost:4000/graphql` | GraphQL endpoint (used to create the test user and documents) |
| `COLLAB_URL` | `ws://localhost:1234` | Collaboration WebSocket |
| `CLIENTS` | 20 | Concurrent editors on one document |
| `EDITS_PER_SEC` | 2 | Edits per client per second |
| `DURATION_S` | 20 | Length of the editing phase |
| `RECOVERY_KB` | 1024 | Size of the document used for the cold-recovery measurement |

The script exits non-zero if clients diverge or recovered content doesn't match.
