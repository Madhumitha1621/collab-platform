import { Field, ID, ObjectType, registerEnumType } from '@nestjs/graphql';

export enum WorkspaceEventType {
  DOCUMENT_CREATED = 'DOCUMENT_CREATED',
  DOCUMENT_RENAMED = 'DOCUMENT_RENAMED',
  DOCUMENT_ARCHIVED = 'DOCUMENT_ARCHIVED',
  WORKSPACE_UPDATED = 'WORKSPACE_UPDATED',
  MEMBER_ADDED = 'MEMBER_ADDED',
  MEMBER_ROLE_UPDATED = 'MEMBER_ROLE_UPDATED',
  MEMBER_REMOVED = 'MEMBER_REMOVED',
}

registerEnumType(WorkspaceEventType, { name: 'WorkspaceEventType' });

@ObjectType()
export class WorkspaceEvent {
  @Field(() => WorkspaceEventType)
  type: WorkspaceEventType;

  @Field(() => ID)
  workspaceId: string;

  @Field(() => ID)
  actorId: string;

  @Field(() => ID, { nullable: true })
  documentId?: string;

  @Field(() => ID, { nullable: true })
  userId?: string;

  @Field()
  occurredAt: Date;
}
