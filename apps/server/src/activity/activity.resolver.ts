import { UseGuards } from '@nestjs/common';
import { Args, Field, ID, Int, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { CurrentUser } from '../auth/current-user.decorator';
import { GqlAuthGuard } from '../auth/gql-auth.guard';
import type { AuthUser } from '../common/gql-context';
import { WorkspaceEventType } from '../events/workspace-event.model';
import { ActivityService } from './activity.service';

@ObjectType()
export class ActivityEntry {
  @Field(() => ID)
  id: string;

  @Field(() => WorkspaceEventType)
  type: WorkspaceEventType;

  @Field(() => ID)
  workspaceId: string;

  @Field(() => ID, { nullable: true })
  documentId: string | null;

  @Field(() => String, { nullable: true, description: 'Document title at the time of the change' })
  documentTitle: string | null;

  @Field(() => String, { nullable: true, description: 'Role, email, previous title or snapshot label' })
  detail: string | null;

  @Field(() => ID, { nullable: true })
  actorId: string | null;

  @Field(() => String, { nullable: true })
  actorName: string | null;

  @Field(() => ID, { nullable: true })
  targetUserId: string | null;

  @Field(() => String, { nullable: true })
  targetUserName: string | null;

  @Field()
  createdAt: Date;
}

@Resolver(() => ActivityEntry)
@UseGuards(GqlAuthGuard)
export class ActivityResolver {
  constructor(private readonly activity: ActivityService) {}

  @Query(() => [ActivityEntry], { description: 'Newest first. Pass the last id as `before` to page back.' })
  async activityLog(
    @CurrentUser() user: AuthUser,
    @Args('workspaceId', { type: () => ID }) workspaceId: string,
    @Args('limit', { type: () => Int, defaultValue: 30 }) limit: number,
    @Args('before', { type: () => ID, nullable: true }) before?: string,
  ): Promise<ActivityEntry[]> {
    const rows = await this.activity.list(user.id, workspaceId, limit, before);
    return rows.map(({ metadata, ...row }) => ({
      ...row,
      id: String(row.id),
      documentTitle: metadata?.title ?? null,
      detail: metadata?.detail ?? null,
    }));
  }
}
