import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Role } from '../common/roles';
import { EventsService } from '../events/events.service';
import { WorkspaceEventType } from '../events/workspace-event.model';
import { AccessService } from '../workspaces/access.service';
import { ActivityLog } from './activity-log.entity';

export interface ActivityInput {
  type: WorkspaceEventType;
  workspaceId: string;
  actorId: string;
  documentId?: string;
  userId?: string;
  /** Small, display-only facts such as a title, role or email. Never document content. */
  metadata?: Record<string, string>;
}

export interface ActivityRow {
  id: string;
  type: WorkspaceEventType;
  workspaceId: string;
  documentId: string | null;
  metadata: Record<string, string>;
  createdAt: Date;
  actorId: string | null;
  actorName: string | null;
  targetUserId: string | null;
  targetUserName: string | null;
}

/**
 * Records workspace activity durably and publishes it to live subscribers. Every
 * document and membership change goes through here, so the history and the live
 * feed always agree.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    @InjectRepository(ActivityLog) private readonly logs: Repository<ActivityLog>,
    private readonly events: EventsService,
    private readonly access: AccessService,
  ) {}

  async record(input: ActivityInput): Promise<void> {
    try {
      await this.logs.insert({
        workspaceId: input.workspaceId,
        type: input.type,
        actorId: input.actorId,
        documentId: input.documentId ?? null,
        targetUserId: input.userId ?? null,
        metadata: input.metadata ?? {},
      });
    } catch (err) {
      // The change itself already succeeded; a missing history row must not fail it.
      this.logger.error(`failed to record ${input.type} workspace=${input.workspaceId}: ${err.message}`);
    }
    const { metadata: _metadata, ...event } = input;
    this.events.publishWorkspaceEvent(event);
  }

  async list(userId: string, workspaceId: string, limit: number, before?: string): Promise<ActivityRow[]> {
    await this.access.requireWorkspace(userId, workspaceId, Role.VIEWER);
    const query = this.logs
      .createQueryBuilder('a')
      .leftJoin('users', 'actor', 'actor.id = a.actor_id')
      .leftJoin('users', 'target', 'target.id = a.target_user_id')
      .select([
        'a.id AS id',
        'a.type AS type',
        'a.workspace_id AS "workspaceId"',
        'a.document_id AS "documentId"',
        'a.metadata AS metadata',
        'a.created_at AS "createdAt"',
        'a.actor_id AS "actorId"',
        'actor.name AS "actorName"',
        'a.target_user_id AS "targetUserId"',
        'target.name AS "targetUserName"',
      ])
      .where('a.workspace_id = :workspaceId', { workspaceId })
      .orderBy('a.id', 'DESC')
      .limit(Math.min(Math.max(limit, 1), 100));
    if (before && /^\d+$/.test(before)) query.andWhere('a.id < :before', { before });
    return query.getRawMany<ActivityRow>();
  }
}
