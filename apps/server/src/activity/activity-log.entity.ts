import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { WorkspaceEventType } from '../events/workspace-event.model';

/** Durable audit trail of document and membership changes in a workspace. */
@Entity('activity_logs')
export class ActivityLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @Column({ type: 'varchar' })
  type: WorkspaceEventType;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'document_id', type: 'uuid', nullable: true })
  documentId: string | null;

  @Column({ name: 'target_user_id', type: 'uuid', nullable: true })
  targetUserId: string | null;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, string>;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
