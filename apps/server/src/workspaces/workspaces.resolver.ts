import { UseGuards } from '@nestjs/common';
import { Args, Field, ID, InputType, Mutation, Parent, Query, ResolveField, Resolver, Subscription } from '@nestjs/graphql';
import { IsEmail, IsEnum, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { GqlAuthGuard } from '../auth/gql-auth.guard';
import type { AuthUser, GqlContext } from '../common/gql-context';
import { Role } from '../common/roles';
import { EventsService } from '../events/events.service';
import { WorkspaceEvent } from '../events/workspace-event.model';
import { AccessService } from './access.service';
import { WorkspaceMember } from './workspace-member.entity';
import { Workspace } from './workspace.entity';
import { WorkspacesService } from './workspaces.service';

@InputType()
export class CreateWorkspaceInput {
  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

@InputType()
export class UpdateWorkspaceInput {
  @Field(() => ID)
  @IsUUID()
  id: string;

  @Field()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;
}

@InputType()
export class InviteWorkspaceMemberInput {
  @Field(() => ID)
  @IsUUID()
  workspaceId: string;

  @Field()
  @IsEmail()
  email: string;

  @Field(() => Role)
  @IsEnum(Role)
  role: Role;
}

@InputType()
export class UpdateMemberRoleInput {
  @Field(() => ID)
  @IsUUID()
  workspaceId: string;

  @Field(() => ID)
  @IsUUID()
  userId: string;

  @Field(() => Role)
  @IsEnum(Role)
  role: Role;
}

@InputType()
export class RemoveWorkspaceMemberInput {
  @Field(() => ID)
  @IsUUID()
  workspaceId: string;

  @Field(() => ID)
  @IsUUID()
  userId: string;
}

@Resolver(() => Workspace)
@UseGuards(GqlAuthGuard)
export class WorkspacesResolver {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly access: AccessService,
    private readonly events: EventsService,
  ) {}

  @Query(() => [Workspace])
  myWorkspaces(@CurrentUser() user: AuthUser) {
    return this.workspaces.listForUser(user.id);
  }

  @Query(() => Workspace)
  workspace(@CurrentUser() user: AuthUser, @Args('id', { type: () => ID }) id: string) {
    return this.workspaces.get(user.id, id);
  }

  @ResolveField(() => Role)
  async myRole(@Parent() workspace: Workspace, @CurrentUser() user: AuthUser) {
    return (await this.access.requireWorkspace(user.id, workspace.id, Role.VIEWER)).role;
  }

  @ResolveField(() => [WorkspaceMember])
  members(@Parent() workspace: Workspace, @CurrentUser() user: AuthUser) {
    return this.workspaces.listMembers(user.id, workspace.id);
  }

  @Mutation(() => Workspace)
  createWorkspace(@CurrentUser() user: AuthUser, @Args('input') input: CreateWorkspaceInput) {
    return this.workspaces.create(user.id, input.name);
  }

  @Mutation(() => Workspace)
  updateWorkspace(@CurrentUser() user: AuthUser, @Args('input') input: UpdateWorkspaceInput) {
    return this.workspaces.update(user.id, input.id, input.name);
  }

  @Mutation(() => WorkspaceMember)
  inviteWorkspaceMember(@CurrentUser() user: AuthUser, @Args('input') input: InviteWorkspaceMemberInput) {
    return this.workspaces.addMember(user.id, input.workspaceId, input.email, input.role);
  }

  @Mutation(() => WorkspaceMember)
  updateMemberRole(@CurrentUser() user: AuthUser, @Args('input') input: UpdateMemberRoleInput) {
    return this.workspaces.updateRole(user.id, input.workspaceId, input.userId, input.role);
  }

  @Mutation(() => Boolean)
  removeWorkspaceMember(@CurrentUser() user: AuthUser, @Args('input') input: RemoveWorkspaceMemberInput) {
    return this.workspaces.removeMember(user.id, input.workspaceId, input.userId);
  }

  @Subscription(() => WorkspaceEvent, {
    // Re-check membership per event so removed members stop receiving activity immediately.
    filter: async function (this: WorkspacesResolver, payload, variables, context: GqlContext) {
      return (await this.access.findRole(context.user!.id, variables.workspaceId)) !== null;
    },
  })
  async workspaceActivity(@CurrentUser() user: AuthUser, @Args('workspaceId', { type: () => ID }) workspaceId: string) {
    await this.access.requireWorkspace(user.id, workspaceId, Role.VIEWER);
    return this.events.pubSub.asyncIterableIterator(EventsService.workspaceTopic(workspaceId));
  }
}
