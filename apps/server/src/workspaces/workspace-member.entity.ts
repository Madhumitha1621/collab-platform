import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Role } from '../common/roles';
import { User } from '../users/user.entity';

@ObjectType()
@Entity('workspace_members')
export class WorkspaceMember {
  @Field(() => ID)
  @PrimaryColumn({ name: 'workspace_id', type: 'uuid' })
  workspaceId: string;

  @Field(() => ID)
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Field(() => Role)
  @Column({ type: 'varchar' })
  role: Role;

  @Field()
  @CreateDateColumn({ name: 'joined_at', type: 'timestamptz' })
  joinedAt: Date;

  @Field(() => User)
  @ManyToOne(() => User, { eager: true })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
