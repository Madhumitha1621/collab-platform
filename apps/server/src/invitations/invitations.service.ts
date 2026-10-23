import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash, randomBytes } from 'node:crypto';
import { DataSource, IsNull, MoreThan, Repository } from 'typeorm';
import { ActivityService } from '../activity/activity.service';
import type { AuthUser } from '../common/gql-context';
import { assertUuid } from '../common/ids';
import { Role } from '../common/roles';
import { appConfig } from '../config';
import { WorkspaceEventType } from '../events/workspace-event.model';
import { MailerService } from '../mail/mailer.service';
import { User } from '../users/user.entity';
import { AccessService } from '../workspaces/access.service';
import { WorkspaceMember } from '../workspaces/workspace-member.entity';
import { Workspace } from '../workspaces/workspace.entity';
import { WorkspaceInvitation } from './workspace-invitation.entity';

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export function invitationStatus(invitation: WorkspaceInvitation): InvitationStatus {
  if (invitation.acceptedAt) return 'ACCEPTED';
  if (invitation.revokedAt) return 'REVOKED';
  if (invitation.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  return 'PENDING';
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Email invitations. The emailed link carries a random token (only its hash is stored), and
 * accepting requires both the token and a signed-in account with the invited address. The
 * token proves access to the mailbox, because registration does not verify email ownership.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(WorkspaceInvitation) private readonly invitations: Repository<WorkspaceInvitation>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly access: AccessService,
    private readonly activity: ActivityService,
    private readonly mailer: MailerService,
  ) {}

  async send(actor: AuthUser, workspaceId: string, rawEmail: string, role: Role) {
    const { workspace } = await this.access.requireWorkspace(actor.id, workspaceId, Role.OWNER);
    const email = rawEmail.trim().toLowerCase();
    const existing = await this.users.findOne({ where: { email } });
    if (existing && (await this.members.exist({ where: { workspaceId, userId: existing.id } }))) {
      throw new BadRequestException('That person is already a member of this workspace');
    }

    const token = randomBytes(32).toString('base64url');
    const invitation = await this.dataSource.transaction(async (tx) => {
      // Re-inviting replaces the previous open invitation (and invalidates its link).
      await tx.update(
        WorkspaceInvitation,
        { workspaceId, email, acceptedAt: IsNull(), revokedAt: IsNull() },
        { revokedAt: new Date() },
      );
      return tx.save(
        tx.create(WorkspaceInvitation, {
          workspaceId,
          email,
          role,
          tokenHash: hashToken(token),
          invitedBy: actor.id,
          expiresAt: new Date(Date.now() + appConfig().invitationTtlHours * 3600_000),
        }),
      );
    });

    const link = `${appConfig().webUrl}/invite/${token}`;
    await this.mailer.send({
      to: email,
      subject: `${actor.name} invited you to ${workspace.name}`,
      text:
        `${actor.name} invited you to collaborate on "${workspace.name}" as ${role.toLowerCase()}.\n\n` +
        `Accept the invitation: ${link}\n\n` +
        `Sign in (or create an account) with ${email} to accept. The link expires on ${invitation.expiresAt.toUTCString()}.`,
    });
    await this.activity.record({
      type: WorkspaceEventType.INVITATION_SENT,
      workspaceId,
      actorId: actor.id,
      metadata: { detail: `${email} (${role})` },
    });
    return { invitation, token };
  }

  async listPending(actorId: string, workspaceId: string): Promise<WorkspaceInvitation[]> {
    await this.access.requireWorkspace(actorId, workspaceId, Role.OWNER);
    return this.invitations.find({
      where: { workspaceId, acceptedAt: IsNull(), revokedAt: IsNull(), expiresAt: MoreThan(new Date()) },
      order: { createdAt: 'DESC' },
    });
  }

  async revoke(actorId: string, invitationId: string): Promise<boolean> {
    assertUuid(invitationId, 'invitationId');
    const invitation = await this.invitations.findOne({ where: { id: invitationId } });
    if (!invitation) throw new NotFoundException('Invitation not found');
    await this.access.requireWorkspace(actorId, invitation.workspaceId, Role.OWNER);
    if (invitationStatus(invitation) !== 'PENDING') throw new BadRequestException('Invitation is no longer pending');
    await this.invitations.update({ id: invitationId }, { revokedAt: new Date() });
    await this.activity.record({
      type: WorkspaceEventType.INVITATION_REVOKED,
      workspaceId: invitation.workspaceId,
      actorId,
      metadata: { detail: invitation.email },
    });
    return true;
  }

  /** What the invite page shows before the user accepts. */
  async preview(token: string) {
    const invitation = await this.findByToken(token);
    const [workspace, inviter] = await Promise.all([
      this.dataSource.getRepository(Workspace).findOneByOrFail({ id: invitation.workspaceId }),
      this.users.findOneBy({ id: invitation.invitedBy }),
    ]);
    return { invitation, workspaceName: workspace.name, invitedByName: inviter?.name ?? 'Someone' };
  }

  async accept(user: AuthUser, token: string): Promise<Workspace> {
    const invitation = await this.findByToken(token);
    const status = invitationStatus(invitation);
    if (status !== 'PENDING') throw new BadRequestException(`This invitation is ${status.toLowerCase()}`);
    if (invitation.email !== user.email.toLowerCase()) {
      throw new ForbiddenException(`This invitation was sent to ${invitation.email}. Sign in with that address to accept it.`);
    }
    await this.dataSource.transaction(async (tx) => {
      const claimed = await tx.update(
        WorkspaceInvitation,
        { id: invitation.id, acceptedAt: IsNull(), revokedAt: IsNull() },
        { acceptedAt: new Date(), acceptedBy: user.id },
      );
      if (!claimed.affected) throw new BadRequestException('This invitation is no longer pending');
      // Already a member (e.g. added directly meanwhile): keep the existing role.
      await tx
        .createQueryBuilder()
        .insert()
        .into(WorkspaceMember)
        .values({ workspaceId: invitation.workspaceId, userId: user.id, role: invitation.role })
        .orIgnore()
        .execute();
    });
    await this.activity.record({
      type: WorkspaceEventType.INVITATION_ACCEPTED,
      workspaceId: invitation.workspaceId,
      actorId: user.id,
      userId: user.id,
      metadata: { detail: invitation.role },
    });
    return this.dataSource.getRepository(Workspace).findOneByOrFail({ id: invitation.workspaceId });
  }

  private async findByToken(token: string): Promise<WorkspaceInvitation> {
    const invitation = /^[A-Za-z0-9_-]{20,100}$/.test(token)
      ? await this.invitations.findOne({ where: { tokenHash: hashToken(token) } })
      : null;
    if (!invitation) throw new NotFoundException('Invitation not found');
    return invitation;
  }
}
