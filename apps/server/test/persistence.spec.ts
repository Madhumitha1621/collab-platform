process.env.SNAPSHOT_UPDATE_THRESHOLD = '5';
process.env.PERSIST_MAX_RETRIES = '2';

import { DataSource } from 'typeorm';
import * as Y from 'yjs';
import { resetDatabase, setupWorkspace, startApp, type TestApp } from './helpers';
import { PersistenceService, type PersistenceStatus } from '../src/persistence/persistence.service';

describe('PersistenceService (PostgreSQL)', () => {
  let t: TestApp;
  let persistence: PersistenceService;
  let db: DataSource;

  beforeAll(async () => {
    t = await startApp();
    await resetDatabase(t.app);
    persistence = t.app.get(PersistenceService);
    db = t.app.get(DataSource);
  });
  afterAll(() => t.close());

  const counts = async (documentId: string) => {
    const [row] = await db.query(
      `SELECT (SELECT count(*) FROM document_updates WHERE document_id = $1)::int AS updates,
              (SELECT count(*) FROM document_snapshots WHERE document_id = $1)::int AS snapshots`,
      [documentId],
    );
    return row as { updates: number; snapshots: number };
  };

  const textOf = (state: Uint8Array | null) => {
    const doc = new Y.Doc();
    if (state) Y.applyUpdate(doc, state);
    return doc.getText('content').toString();
  };

  /** Writes `n` separate flushes so each lands as its own update row. */
  async function writeEdits(documentId: string, doc: Y.Doc, edits: string[]) {
    for (const edit of edits) {
      let captured: Uint8Array | null = null;
      const capture = (u: Uint8Array) => (captured = u);
      doc.on('update', capture);
      doc.getText('content').insert(doc.getText('content').length, edit);
      doc.off('update', capture);
      persistence.enqueue(documentId, captured!);
      await persistence.flush(documentId);
    }
  }

  it('returns null for a document with no stored state', async () => {
    const { documentId } = await setupWorkspace(t.app);
    expect(await persistence.loadState(documentId)).toBeNull();
  });

  it('reconstructs state from the update log', async () => {
    const { documentId } = await setupWorkspace(t.app);
    const doc = new Y.Doc();
    await writeEdits(documentId, doc, ['a', 'b', 'c']);
    expect(await counts(documentId)).toEqual({ updates: 3, snapshots: 0 });
    expect(textOf(await persistence.loadState(documentId))).toBe('abc');
  });

  it('compacts at the threshold without changing the visible content', async () => {
    const { documentId } = await setupWorkspace(t.app);
    const doc = new Y.Doc();
    await writeEdits(documentId, doc, ['1', '2', '3', '4', '5']);
    expect(await counts(documentId)).toEqual({ updates: 0, snapshots: 1 });
    expect(textOf(await persistence.loadState(documentId))).toBe('12345');

    // Snapshot + later updates are combined on load.
    await writeEdits(documentId, doc, ['6', '7']);
    expect(await counts(documentId)).toEqual({ updates: 2, snapshots: 1 });
    const loaded = await persistence.loadState(documentId);
    expect(textOf(loaded)).toBe('1234567');
    expect(Buffer.from(Y.encodeStateVector(doc))).toEqual(Buffer.from(Y.encodeStateVectorFromUpdate(loaded!)));
  });

  it('keeps labelled snapshots as restore points through later compactions', async () => {
    const { documentId } = await setupWorkspace(t.app);
    const doc = new Y.Doc();
    await writeEdits(documentId, doc, ['x']);
    const named = await persistence.createSnapshot(documentId, { label: 'v1' });
    expect(named.label).toBe('v1');
    await writeEdits(documentId, doc, ['1', '2', '3', '4', '5']);

    const labels: Array<{ label: string | null }> = await db.query(
      'SELECT label FROM document_snapshots WHERE document_id = $1 ORDER BY created_at',
      [documentId],
    );
    expect(labels.map((l) => l.label)).toEqual(['v1', null]);
    expect(textOf(await persistence.loadState(documentId))).toBe('x12345');
  });

  it('keeps updates in memory and reports an error when the database is unavailable, then recovers', async () => {
    const { documentId } = await setupWorkspace(t.app);
    const statuses: PersistenceStatus['status'][] = [];
    const stop = persistence.onStatus((id, s) => id === documentId && statuses.push(s.status));
    persistence.setStateVectorProvider(() => new Uint8Array([0]));

    const spy = jest.spyOn(db, 'query').mockRejectedValue(new Error('connection refused'));
    const doc = new Y.Doc();
    doc.on('update', (u: Uint8Array) => persistence.enqueue(documentId, u));
    doc.getText('content').insert(0, 'precious');
    await persistence.flush(documentId);
    expect(statuses).toContain('error');
    expect(persistence.queueDepth).toBeGreaterThan(0);

    spy.mockRestore();
    await persistence.flush(documentId);
    stop();
    expect(statuses[statuses.length - 1]).toBe('saved');
    expect(persistence.queueDepth).toBe(0);
    expect(textOf(await persistence.loadState(documentId))).toBe('precious');
  });
});
