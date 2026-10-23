import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { assertUuid } from '../common/ids';
import { Role } from '../common/roles';
import { EventsService } from '../events/events.service';
import { WorkspaceEventType } from '../events/workspace-event.model';
import { User } from '../users/user.entity';
import { AccessService } from './access.service';
import { WorkspaceMember } from './workspace-member.entity';
import { Workspace } from './workspace.entity';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly access: AccessService,
    private readonly events: EventsService,
  ) {}

  listForUser(userId: string): Promise<Workspace[]> {
    return this.workspaces
      .createQueryBuilder('w')
      .innerJoin(WorkspaceMember, 'm', 'm.workspace_id = w.id AND m.user_id = :userId', { userId })
      .where('w.archived_at IS NULL')
      .orderBy('w.created_at', 'DESC')
      .getMany();
  }

  async get(userId: string, workspaceId: string): Promise<Workspace> {
    return (await this.access.requireWorkspace(userId, workspaceId, Role.VIEWER)).workspace;
  }

  async create(userId: string, name: string): Promise<Workspace> {
    return this.dataSource.transaction(async (tx) => {
      const workspace = await tx.save(tx.create(Workspace, { name: name.trim(), ownerId: userId }));
      await tx.insert(WorkspaceMember, { workspaceId: workspace.id, userId, role: Role.OWNER });
      return workspace;
    });
  }

  async update(userId: string, workspaceId: string, name: string): Promise<Workspace> {
    const { workspace } = await this.access.requireWorkspace(userId, workspaceId, Role.OWNER);
    workspace.name = name.trim();
    const saved = await this.workspaces.save(workspace);
    this.events.publishWorkspaceEvent({ type: WorkspaceEventType.WORKSPACE_UPDATED, workspaceId, actorId: userId });
    return saved;
  }

  async listMembers(userId: string, workspaceId: string): Promise<WorkspaceMember[]> {
    await this.access.requireWorkspace(userId, workspaceId, Role.VIEWER);
    return this.members.find({ where: { workspaceId }, order: { joinedAt: 'ASC' } });
  }

  /** P0 adds existing users directly; email invitations for unknown addresses are a P1 feature. */
  async addMember(actorId: string, workspaceId: string, email: string, role: Role): Promise<WorkspaceMember> {
    await this.access.requireWorkspace(actorId, workspaceId, Role.OWNER);
    const user = await this.users.findOne({ where: { email: email.trim().toLowerCase() } });
    if (!user) throw new NotFoundException('No registered user has that email address');
    if (await this.members.exist({ where: { workspaceId, userId: user.id } })) {
      throw new BadRequestException('User is already a member of this workspace');
    }
    await this.members.insert({ workspaceId, userId: user.id, role });
    this.events.publishWorkspaceEvent({ type: WorkspaceEventType.MEMBER_ADDED, workspaceId, actorId, userId: user.id });
    return this.members.findOneOrFail({ where: { workspaceId, userId: user.id } });
  }

  async updateRole(actorId: string, workspaceId: string, userId: string, role: Role): Promise<WorkspaceMember> {
    const member = await this.requireManageableMember(actorId, workspaceId, userId);
    member.role = role;
    await this.members.update({ workspaceId, userId }, { role });
    this.events.publishWorkspaceEvent({ type: WorkspaceEventType.MEMBER_ROLE_UPDATED, workspaceId, actorId, userId });
    // Live sessions must pick up the new role (e.g. an editor downgraded to viewer).
    this.events.emitAccess({ type: 'membership-changed', workspaceId, userId });
    return member;
  }

  async removeMember(actorId: string, workspaceId: string, userId: string): Promise<boolean> {
    await this.requireManageableMember(actorId, workspaceId, userId);
    await this.members.delete({ workspaceId, userId });
    this.events.publishWorkspaceEvent({ type: WorkspaceEventType.MEMBER_REMOVED, workspaceId, actorId, userId });
    this.events.emitAccess({ type: 'membership-changed', workspaceId, userId });
    return true;
  }

  private async requireManageableMember(actorId: string, workspaceId: string, userId: string) {
    assertUuid(userId, 'userId');
    const { workspace } = await this.access.requireWorkspace(actorId, workspaceId, Role.OWNER);
    if (workspace.ownerId === userId) throw new BadRequestException('The workspace owner cannot be changed or removed');
    const member = await this.members.findOne({ where: { workspaceId, userId } });
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }
}
