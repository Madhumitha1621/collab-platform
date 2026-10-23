import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Role } from '../common/roles';
import { EventsService } from '../events/events.service';
import { WorkspaceEventType } from '../events/workspace-event.model';
import { AccessService } from '../workspaces/access.service';
import { Document } from './document.entity';

@Injectable()
export class DocumentsService {
  constructor(
    @InjectRepository(Document) private readonly documents: Repository<Document>,
    private readonly access: AccessService,
    private readonly events: EventsService,
  ) {}

  async list(userId: string, workspaceId: string, includeArchived: boolean): Promise<Document[]> {
    await this.access.requireWorkspace(userId, workspaceId, Role.VIEWER);
    return this.documents.find({
      where: includeArchived ? { workspaceId } : { workspaceId, archivedAt: IsNull() },
      order: { updatedAt: 'DESC' },
    });
  }

  async get(userId: string, documentId: string): Promise<Document> {
    return (await this.access.requireDocument(userId, documentId, Role.VIEWER, { allowArchived: true })).document;
  }

  async create(userId: string, workspaceId: string, title: string): Promise<Document> {
    await this.access.requireWorkspace(userId, workspaceId, Role.EDITOR);
    const document = await this.documents.save(this.documents.create({ workspaceId, title: title.trim(), createdBy: userId }));
    this.events.publishWorkspaceEvent({
      type: WorkspaceEventType.DOCUMENT_CREATED,
      workspaceId,
      actorId: userId,
      documentId: document.id,
    });
    return document;
  }

  async rename(userId: string, documentId: string, title: string): Promise<Document> {
    const { document } = await this.access.requireDocument(userId, documentId, Role.EDITOR);
    document.title = title.trim();
    const saved = await this.documents.save(document);
    this.events.publishDocumentChanged(saved);
    this.events.publishWorkspaceEvent({
      type: WorkspaceEventType.DOCUMENT_RENAMED,
      workspaceId: saved.workspaceId,
      actorId: userId,
      documentId,
    });
    return saved;
  }

  async archive(userId: string, documentId: string): Promise<Document> {
    const { document } = await this.access.requireDocument(userId, documentId, Role.EDITOR);
    document.archivedAt = new Date();
    const saved = await this.documents.save(document);
    this.events.publishDocumentChanged(saved);
    this.events.publishWorkspaceEvent({
      type: WorkspaceEventType.DOCUMENT_ARCHIVED,
      workspaceId: saved.workspaceId,
      actorId: userId,
      documentId,
    });
    this.events.emitAccess({ type: 'document-archived', documentId });
    return saved;
  }
}
