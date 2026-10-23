import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { assertUuid } from '../common/ids';
import { hasRole, Role } from '../common/roles';
import { Document } from '../documents/document.entity';
import { WorkspaceMember } from './workspace-member.entity';
import { Workspace } from './workspace.entity';

/**
 * Single source of truth for authorization decisions. Used by GraphQL resolvers
 * and by the collaboration server so both enforce identical rules.
 *
 * Non-members get "not found" rather than "forbidden" so resource existence is not leaked.
 */
@Injectable()
export class AccessService {
  constructor(
    @InjectRepository(Workspace) private readonly workspaces: Repository<Workspace>,
    @InjectRepository(WorkspaceMember) private readonly members: Repository<WorkspaceMember>,
    @InjectRepository(Document) private readonly documents: Repository<Document>,
  ) {}

  async findRole(userId: string, workspaceId: string): Promise<Role | null> {
    const member = await this.members
      .createQueryBuilder('m')
      .innerJoin(Workspace, 'w', 'w.id = m.workspace_id')
      .where('m.workspace_id = :workspaceId AND m.user_id = :userId AND w.archived_at IS NULL', { workspaceId, userId })
      .getOne();
    return member?.role ?? null;
  }

  async requireWorkspace(userId: string, workspaceId: string, minRole: Role): Promise<{ workspace: Workspace; role: Role }> {
    assertUuid(workspaceId, 'workspaceId');
    const workspace = await this.workspaces.findOne({ where: { id: workspaceId, archivedAt: IsNull() } });
    const role = workspace ? await this.findRole(userId, workspaceId) : null;
    if (!workspace || !role) throw new NotFoundException('Workspace not found');
    if (!hasRole(role, minRole)) throw new ForbiddenException(`Requires ${minRole} role`);
    return { workspace, role };
  }

  async requireDocument(
    userId: string,
    documentId: string,
    minRole: Role,
    options: { allowArchived?: boolean } = {},
  ): Promise<{ document: Document; role: Role }> {
    assertUuid(documentId, 'documentId');
    const document = await this.documents.findOne({ where: { id: documentId } });
    const role = document ? await this.findRole(userId, document.workspaceId) : null;
    if (!document || !role) throw new NotFoundException('Document not found');
    if (document.archivedAt && !options.allowArchived) throw new NotFoundException('Document is archived');
    if (!hasRole(role, minRole)) throw new ForbiddenException(`Requires ${minRole} role`);
    return { document, role };
  }
}
