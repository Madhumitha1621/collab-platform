import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { DataSource, EntityManager, IsNull, Not } from 'typeorm';
import * as Y from 'yjs';
import { appConfig } from '../config';
import { DocumentSnapshot } from './document-snapshot.entity';

export type PersistenceStatus =
  | { status: 'saved'; stateVector: Uint8Array }
  | { status: 'error'; message: string };

type StatusListener = (documentId: string, status: PersistenceStatus) => void;
type StateVectorProvider = (documentId: string) => Uint8Array | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Durable storage of Yjs document state in PostgreSQL.
 *
 * Write path: accepted updates are queued in memory per document and flushed every
 * PERSIST_FLUSH_MS as one merged row in `document_updates`. Writes for the same document are
 * serialized. A failed flush is retried with backoff; if it still fails the updates are put
 * back on the queue (never dropped) and an `error` status is reported.
 *
 * Acknowledgement: after a successful flush listeners receive the state vector of the document
 * at the moment the queue was drained. Every update covered by that state vector is durable, so
 * a client can compare it to its own clock to know its edits are saved.
 *
 * Read path: latest snapshot + all later updates, read in one REPEATABLE READ transaction so a
 * concurrent compaction cannot hide rows from the reader.
 */
@Injectable()
export class PersistenceService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PersistenceService.name);
  private readonly config = appConfig().persistence;
  private readonly queues = new Map<string, Uint8Array[]>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly listeners = new Set<StatusListener>();
  private stateVectorProvider: StateVectorProvider = () => undefined;
  private timer?: NodeJS.Timeout;

  readonly stats = {
    updatesPersisted: 0,
    flushes: 0,
    flushFailures: 0,
    compactions: 0,
    lastFlushDurationMs: 0,
  };

  constructor(private readonly dataSource: DataSource) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.flushAll(), this.config.flushMs);
    this.timer.unref();
  }

  async onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.flushAll();
  }

  onStatus(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setStateVectorProvider(provider: StateVectorProvider) {
    this.stateVectorProvider = provider;
  }

  enqueue(documentId: string, update: Uint8Array) {
    const queue = this.queues.get(documentId);
    if (queue) queue.push(update);
    else this.queues.set(documentId, [update]);
  }

  /** Number of updates accepted but not yet durably written. */
  get queueDepth(): number {
    let depth = 0;
    for (const queue of this.queues.values()) depth += queue.length;
    return depth;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.queues.keys()].map((id) => this.flush(id)));
  }

  /** Flushes pending updates for one document. Resolves once they are durable (or rejects). */
  flush(documentId: string): Promise<void> {
    return this.serialize(documentId, () => this.flushNow(documentId));
  }

  async loadState(documentId: string): Promise<Uint8Array | null> {
    return this.dataSource.transaction('REPEATABLE READ', async (tx) => {
      const { snapshot, updates } = await this.readStoredState(tx, documentId);
      const parts = [...(snapshot ? [snapshot.stateData] : []), ...updates.map((u) => u.update_data)];
      return parts.length ? Y.mergeUpdates(parts.map((p) => new Uint8Array(p))) : null;
    });
  }

  /** Compacts snapshot + update log into a new snapshot. Labelled snapshots are kept as restore points. */
  createSnapshot(documentId: string, options: { label?: string | null; createdBy?: string | null } = {}) {
    return this.serialize(documentId, async () => {
      await this.flushNow(documentId, { throwOnError: true });
      return this.compact(documentId, options);
    });
  }

  /** Labelled snapshots (named versions) of a document, newest first. */
  listNamedSnapshots(documentId: string): Promise<DocumentSnapshot[]> {
    return this.dataSource.getRepository(DocumentSnapshot).find({
      where: { documentId, label: Not(IsNull()) },
      order: { createdAt: 'DESC' },
      select: ['id', 'documentId', 'label', 'createdAt', 'createdBy', 'lastAppliedUpdateId'],
    });
  }

  findSnapshot(snapshotId: string): Promise<DocumentSnapshot | null> {
    return this.dataSource.getRepository(DocumentSnapshot).findOne({ where: { id: snapshotId } });
  }

  private serialize<T>(documentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(documentId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(documentId, tail);
    void tail.then(() => {
      if (this.chains.get(documentId) === tail) this.chains.delete(documentId);
    });
    return run;
  }

  private async flushNow(documentId: string, { throwOnError = false } = {}): Promise<void> {
    const pending = this.queues.get(documentId);
    if (!pending?.length) {
      this.queues.delete(documentId);
      return;
    }
    this.queues.delete(documentId);
    // Every update applied to the live document so far is in `pending` or already stored.
    const stateVector = this.stateVectorProvider(documentId);
    const started = Date.now();
    const merged = Y.mergeUpdates(pending);
    try {
      const count = await this.withRetry(() => this.insertUpdate(documentId, merged));
      this.stats.flushes++;
      this.stats.updatesPersisted += pending.length;
      this.stats.lastFlushDurationMs = Date.now() - started;
      if (stateVector) this.emit(documentId, { status: 'saved', stateVector });
      if (count >= this.config.snapshotThreshold) {
        await this.compact(documentId).catch((err) =>
          this.logger.error(`compaction failed document=${documentId}: ${err.message}`),
        );
      }
    } catch (err) {
      this.stats.flushFailures++;
      // Keep the data: re-queue ahead of anything that arrived meanwhile (Yjs merges are order-independent).
      this.queues.set(documentId, [...pending, ...(this.queues.get(documentId) ?? [])]);
      this.logger.error(`persist failed document=${documentId} updates=${pending.length}: ${err.message}`);
      this.emit(documentId, { status: 'error', message: 'Saving is failing; changes are kept and will be retried' });
      if (throwOnError) throw err;
    }
  }

  /**
   * Inserts one merged update, marks the document as modified, and returns how many
   * un-compacted updates the document now has.
   */
  private async insertUpdate(documentId: string, update: Uint8Array): Promise<number> {
    const rows: Array<{ count: string }> = await this.dataSource.query(
      `WITH inserted AS (
         INSERT INTO document_updates (document_id, update_data) VALUES ($1, $2) RETURNING id
       ), touched AS (
         UPDATE documents SET updated_at = now() WHERE id = $1
       )
       SELECT (SELECT count(*) FROM document_updates WHERE document_id = $1) + 1 AS count`,
      [documentId, Buffer.from(update)],
    );
    return Number(rows[0].count);
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await operation();
      } catch (err) {
        attempt++;
        if (attempt >= this.config.maxRetries) throw err;
        await sleep(Math.min(100 * 2 ** attempt, 2000));
      }
    }
  }

  private async compact(documentId: string, options: { label?: string | null; createdBy?: string | null } = {}) {
    const snapshot = await this.dataSource.transaction(async (tx) => {
      // Guards against concurrent compaction of the same document from another instance.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [documentId]);
      const { snapshot: previous, updates } = await this.readStoredState(tx, documentId);
      const parts = [...(previous ? [previous.stateData] : []), ...updates.map((u) => u.update_data)];
      const doc = new Y.Doc();
      for (const part of parts) Y.applyUpdate(doc, new Uint8Array(part));
      const state = Y.encodeStateAsUpdate(doc);
      verifyEquivalent(doc, state);

      const lastAppliedUpdateId = updates.length ? updates[updates.length - 1].id : (previous?.lastAppliedUpdateId ?? '0');
      const created = await tx.save(
        tx.create(DocumentSnapshot, {
          documentId,
          stateData: Buffer.from(state),
          lastAppliedUpdateId,
          label: options.label ?? null,
          createdBy: options.createdBy ?? null,
        }),
      );
      await tx.query('DELETE FROM document_updates WHERE document_id = $1 AND id <= $2', [documentId, lastAppliedUpdateId]);
      await tx.query('DELETE FROM document_snapshots WHERE document_id = $1 AND label IS NULL AND id <> $2', [
        documentId,
        created.id,
      ]);
      return created;
    });
    this.stats.compactions++;
    this.logger.log(`compacted document=${documentId} upTo=${snapshot.lastAppliedUpdateId}`);
    return snapshot;
  }

  private async readStoredState(tx: EntityManager, documentId: string) {
    const snapshot = await tx.findOne(DocumentSnapshot, {
      where: { documentId },
      order: { lastAppliedUpdateId: 'DESC', createdAt: 'DESC' },
    });
    const updates: Array<{ id: string; update_data: Buffer }> = await tx.query(
      'SELECT id, update_data FROM document_updates WHERE document_id = $1 AND id > $2 ORDER BY id',
      [documentId, snapshot?.lastAppliedUpdateId ?? '0'],
    );
    return { snapshot, updates };
  }

  private emit(documentId: string, status: PersistenceStatus) {
    for (const listener of this.listeners) {
      try {
        listener(documentId, status);
      } catch (err) {
        this.logger.warn(`status listener failed: ${err.message}`);
      }
    }
  }
}

/** Refuses to write a snapshot whose decoded content differs from the source document. */
function verifyEquivalent(source: Y.Doc, encoded: Uint8Array) {
  const check = new Y.Doc();
  Y.applyUpdate(check, encoded);
  const sameVector = Buffer.from(Y.encodeStateVector(source)).equals(Buffer.from(Y.encodeStateVector(check)));
  const sameDeletes = Buffer.from(Y.encodeStateAsUpdate(source)).equals(Buffer.from(Y.encodeStateAsUpdate(check)));
  if (!sameVector || !sameDeletes) throw new Error('snapshot verification failed: compacted state differs from source');
}
