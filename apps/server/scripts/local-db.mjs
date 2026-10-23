// Runs a local PostgreSQL 16 without Docker (binaries come from the embedded-postgres npm package).
// Same credentials and port as docker-compose.yml, so DATABASE_URL works unchanged.
// Usage: npm run db:local  (Ctrl+C to stop; data persists in apps/server/.pgdata)
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '.pgdata');
const port = Number(process.env.LOCAL_DB_PORT ?? 5433);

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'collab',
  password: 'collab',
  port,
  persistent: true,
  onLog: () => undefined,
});

if (!existsSync(join(dataDir, 'PG_VERSION'))) await server.initialise();
await server.start();

const client = new pg.Client({ host: 'localhost', port, user: 'collab', password: 'collab', database: 'postgres' });
await client.connect();
for (const name of ['collab', 'collab_test']) {
  const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
  if (!rowCount) await client.query(`CREATE DATABASE ${name}`);
}
await client.end();
console.log(`PostgreSQL ready on localhost:${port} (databases: collab, collab_test)`);

const shutdown = async () => {
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
