import { MigrationInterface, QueryRunner } from 'typeorm';

export class ActivityAndInvitations1761200000000 implements MigrationInterface {
  name = 'ActivityAndInvitations1761200000000';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE activity_logs (
        id bigserial PRIMARY KEY,
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        type varchar(40) NOT NULL,
        actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
        document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
        target_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await q.query(`CREATE INDEX idx_activity_logs_workspace ON activity_logs(workspace_id, id DESC)`);
    await q.query(`
      CREATE TABLE workspace_invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email varchar(320) NOT NULL,
        role varchar(10) NOT NULL CHECK (role IN ('OWNER', 'EDITOR', 'VIEWER')),
        token_hash char(64) NOT NULL UNIQUE,
        invited_by uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        accepted_by uuid REFERENCES users(id) ON DELETE SET NULL,
        revoked_at timestamptz
      )`);
    // At most one open invitation per address and workspace.
    await q.query(`
      CREATE UNIQUE INDEX idx_workspace_invitations_pending
        ON workspace_invitations(workspace_id, email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL`);
    await q.query(`CREATE INDEX idx_documents_workspace_title ON documents(workspace_id, lower(title))`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP INDEX IF EXISTS idx_documents_workspace_title`);
    await q.query(`DROP TABLE IF EXISTS workspace_invitations`);
    await q.query(`DROP TABLE IF EXISTS activity_logs`);
  }
}
