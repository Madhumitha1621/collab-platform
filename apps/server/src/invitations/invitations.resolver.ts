import { UseGuards } from '@nestjs/common';
import { Args, Field, ID, InputType, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';
import { IsEmail, IsEnum, IsUUID } from 'class-validator';
import { CurrentUser } from '../auth/current-user.decorator';
import { GqlAuthGuard } from '../auth/gql-auth.guard';
import type { AuthUser } from '../common/gql-context';
import { Role } from '../common/roles';
import { Workspace } from '../workspaces/workspace.entity';
import { invitationStatus, InvitationsService } from './invitations.service';
import type { WorkspaceInvitation } from './workspace-invitation.entity';

@ObjectType('WorkspaceInvitation')
export class InvitationModel {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  workspaceId: string;

  @Field()
  email: string;

  @Field(() => Role)
  role: Role;

  @Field({ description: 'PENDING, ACCEPTED, REVOKED or EXPIRED' })
  status: string;

  @Field()
  createdAt: Date;

  @Field()
  expiresAt: Date;
}

@ObjectType()
export class InvitationPreview extends InvitationModel {
  @Field()
  workspaceName: string;

  @Field()
  invitedByName: string;
}

@InputType()
export class SendWorkspaceInvitationInput {
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

const toModel = (invitation: WorkspaceInvitation): InvitationModel => ({
  id: invitation.id,
  workspaceId: invitation.workspaceId,
  email: invitation.email,
  role: invitation.role,
  status: invitationStatus(invitation),
  createdAt: invitation.createdAt,
  expiresAt: invitation.expiresAt,
});

@Resolver()
@UseGuards(GqlAuthGuard)
export class InvitationsResolver {
  constructor(private readonly invitations: InvitationsService) {}

  @Mutation(() => InvitationModel, { description: 'Emails an invitation link. Re-inviting replaces the previous link.' })
  async sendWorkspaceInvitation(@CurrentUser() user: AuthUser, @Args('input') input: SendWorkspaceInvitationInput) {
    const { invitation } = await this.invitations.send(user, input.workspaceId, input.email, input.role);
    return toModel(invitation);
  }

  @Query(() => [InvitationModel], { description: 'Open invitations of a workspace (owners only).' })
  async workspaceInvitations(@CurrentUser() user: AuthUser, @Args('workspaceId', { type: () => ID }) workspaceId: string) {
    return (await this.invitations.listPending(user.id, workspaceId)).map(toModel);
  }

  @Mutation(() => Boolean)
  revokeWorkspaceInvitation(@CurrentUser() user: AuthUser, @Args('id', { type: () => ID }) id: string) {
    return this.invitations.revoke(user.id, id);
  }

  @Query(() => InvitationPreview)
  async invitation(@Args('token') token: string): Promise<InvitationPreview> {
    const { invitation, workspaceName, invitedByName } = await this.invitations.preview(token);
    return { ...toModel(invitation), workspaceName, invitedByName };
  }

  @Mutation(() => Workspace)
  acceptWorkspaceInvitation(@CurrentUser() user: AuthUser, @Args('token') token: string) {
    return this.invitations.accept(user, token);
  }
}
