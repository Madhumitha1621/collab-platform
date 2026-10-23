import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Append-only log of binary Yjs updates written since the latest snapshot. */
@Entity('document_updates')
export class DocumentUpdate {
  // bigint comes back from pg as a string to avoid precision loss.
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @Column({ name: 'update_data', type: 'bytea' })
  updateData: Buffer;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
