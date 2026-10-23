import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ActivityService } from '../activity/activity.service';
import { assertUuid } from '../common/ids';
import { Role } from '../common/roles';
import { EventsService } from '../events/events.service';
import { WorkspaceEventType } from '../events/workspace-event.model';
import { AccessService } from '../workspaces/access.service';
import { WorkspaceMember } from '../workspaces/workspace-member.entity';
import { Workspace } from '../workspaces/workspace.entity';
import { Document } from './document.entity';

/** Escapes LIKE wildcards so user input is matched literally. */
function likePattern(query: string): string {
  return `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    private readonly access: AccessService,
    private readonly events: EventsService,
    private readonly activity: ActivityService,
  ) {}

  async list(userId: string, workspaceId: string, includeArchived: boolean): Promise<Document[]> {
    await this.access.requireWorkspace(userId, workspaceId, Role.VIEWER);
    return this.documents.find({
      where: includeArchived ? { workspaceId } : { workspaceId, archivedAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
  }

  /**
   * Case-insensitive title search over active documents in every workspace the user belongs to
   * (or one workspace). Prefix matches rank first, then most recently edited.
   */
  async search(userId: string, query: string, options: { workspaceId?: string; limit?: number } = {}): Promise<Document[]> {
    const text = query.trim();
    if (text.length < 1 || text.length > 100) throw new BadRequestException('query must be 1-100 characters');
    const qb = this.documents
      .createQueryBuilder('d')
      .innerJoin(WorkspaceMember, 'm', 'm.workspace_id = d.workspace_id AND m.user_id = :userId', { userId })
      .innerJoin(Workspace, 'w', 'w.id = d.workspace_id AND w.archived_at IS NULL')
      .where('d.archived_at IS NULL')
      .andWhere(`d.title ILIKE :pattern ESCAPE '\\'`, { pattern: likePattern(text) })
      .orderBy(`CASE WHEN lower(d.title) LIKE lower(:prefix) ESCAPE '\\' THEN 0 ELSE 1 END`, 'ASC')
      .addOrderBy('d.updated_at', 'DESC')
      .setParameter('prefix', `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      .limit(Math.min(Math.max(options.limit ?? 20, 1), 50));
    if (options.workspaceId) qb.andWhere('d.workspace_id = :workspaceId', { workspaceId: assertUuid(options.workspaceId) });
    return qb.getMany();
  }

  async get(userId: string, documentId: string): Promise<Document> {
    return (await this.access.requireDocument(userId, documentId, Role.VIEWER, { allowArchived: true })).document;
  }

  async create(userId: string, workspaceId: string, title: string): Promise<Document> {
    await this.access.requireWorkspace(userId, workspaceId, Role.EDITOR);
    const document = await this.documents.save(this.documents.create({ workspaceId, title: title.trim(), createdBy: userId }));
    await this.activity.record({
      type: WorkspaceEventType.DOCUMENT_CREATED,
      workspaceId,
      actorId: userId,
      documentId: document.id,
      metadata: { title: document.title },
    });
    return document;
  }

  async rename(userId: string, documentId: string, title: string): Promise<Document> {
    const { document } = await this.access.requireDocument(userId, documentId, Role.EDITOR);
    const previous = document.title;
    document.title = title.trim();
    const saved = await this.documents.save(document);
    this.events.publishDocumentChanged(saved);
    await this.activity.record({
      type: WorkspaceEventType.DOCUMENT_RENAMED,
      workspaceId: saved.workspaceId,
      actorId: userId,
      documentId,
      metadata: { title: saved.title, detail: previous },
    });
    return saved;
  }

  async archive(userId: string, documentId: string): Promise<Document> {
    const { document } = await this.access.requireDocument(userId, documentId, Role.EDITOR);
    document.archivedAt = new Date();
    const saved = await this.documents.save(document);
    this.events.publishDocumentChanged(saved);
    await this.activity.record({
      type: WorkspaceEventType.DOCUMENT_ARCHIVED,
      workspaceId: saved.workspaceId,
      actorId: userId,
      documentId,
      metadata: { title: saved.title },
    });
    this.events.emitAccess({ type: 'document-archived', documentId });
    return saved;
  }
}
