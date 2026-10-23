import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1760500000000 implements MigrationInterface {
  name = 'InitialSchema1760500000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(100) NOT NULL,
        email varchar(320) NOT NULL UNIQUE,
        password_hash varchar(100) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      )`);
    await q.query(`CREATE INDEX idx_sessions_user ON sessions(user_id)`);
    await q.query(`
      CREATE TABLE workspaces (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name varchar(100) NOT NULL,
        owner_id uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz
      )`);
    await q.query(`
      CREATE TABLE workspace_members (
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role varchar(10) NOT NULL CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER')),
        joined_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (workspace_id, user_id)
      )`);
    await q.query(`CREATE INDEX idx_workspace_members_user ON workspace_members(user_id)`);
    await q.query(`
      CREATE TABLE documents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title varchar(200) NOT NULL,
        created_by uuid NOT NULL REFERENCES users(id),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz
      )`);
    await q.query(`CREATE INDEX idx_documents_workspace ON documents(workspace_id)`);
    await q.query(`
      CREATE TABLE document_updates (
        id bigserial PRIMARY KEY,
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        update_data bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_document_updates_doc_id ON document_updates(document_id, id)`);
    await q.query(`
      CREATE TABLE document_snapshots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        state_data bytea NOT NULL,
        last_applied_update_id bigint NOT NULL DEFAULT 0,
        label varchar(200),
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by uuid REFERENCES users(id) ON DELETE SET NULL
      )`);
    await q.query(
      `CREATE INDEX idx_document_snapshots_doc ON document_snapshots(document_id, last_applied_update_id DESC, created_at DESC)`,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    const tables = ['document_snapshots', 'document_updates', 'documents', 'workspace_members', 'workspaces', 'sessions', 'users'];
    for (const table of tables) {
      await q.query(`DROP TABLE IF EXISTS ${table}`);
    }
  }
}
