import { Injectable } from '@nestjs/common';
import { PubSub } from 'graphql-subscriptions';
import { Subject } from 'rxjs';
import type { Document } from '../documents/document.entity';
import { WorkspaceEvent } from './workspace-event.model';

/** Server-internal signals that require active collaboration sessions to be re-checked. */
export type AccessEvent =
  | { type: 'membership-changed'; workspaceId: string; userId: string }
  | { type: 'session-revoked'; sessionId: string }
  | { type: 'document-archived'; documentId: string };

/**
 * Fan-out point for application (non-document) events.
 * The PubSub is in-memory: correct for a single instance. Swap for a Redis-backed
 * PubSub when running multiple instances.
 */
@Injectable()
export class EventsService {
  readonly pubSub = new PubSub();
  readonly access$ = new Subject<AccessEvent>();

  static workspaceTopic(workspaceId: string) {
    return `workspace:${workspaceId}`;
  }

  static documentTopic(documentId: string) {
    return `document:${documentId}`;
  }

  publishWorkspaceEvent(event: Omit<WorkspaceEvent, 'occurredAt'>) {
    const payload: WorkspaceEvent = { ...event, occurredAt: new Date() };
    void this.pubSub.publish(EventsService.workspaceTopic(event.workspaceId), { workspaceActivity: payload });
  }

  publishDocumentChanged(document: Document) {
    void this.pubSub.publish(EventsService.documentTopic(document.id), { documentMetadataChanged: document });
  }

  emitAccess(event: AccessEvent) {
    this.access$.next(event);
  }
}
