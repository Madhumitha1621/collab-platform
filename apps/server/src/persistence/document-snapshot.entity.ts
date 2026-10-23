import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Compacted Yjs state covering every update with id <= lastAppliedUpdateId. */
@ObjectType()
@Entity('document_snapshots')
export class DocumentSnapshot {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field(() => ID)
  @Column({ name: 'document_id', type: 'uuid' })
  documentId: string;

  @Column({ name: 'state_data', type: 'bytea' })
  stateData: Buffer;

  @Column({ name: 'last_applied_update_id', type: 'bigint' })
  lastAppliedUpdateId: string;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', nullable: true })
  label: string | null;

  @Field()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Field(() => ID, { nullable: true })
  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;
}
