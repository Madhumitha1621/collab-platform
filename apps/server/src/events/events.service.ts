import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PubSub, PubSubEngine } from 'graphql-subscriptions';
import { RedisPubSub } from 'graphql-redis-subscriptions';
import IORedis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { Subject } from 'rxjs';
import { appConfig } from '../config';
import type { Document } from '../documents/document.entity';
import { WorkspaceEvent } from './workspace-event.model';

/** Server-internal signals that require active collaboration sessions to be re-checked. */
export type AccessEvent =
  | { type: 'membership-changed'; workspaceId: string; userId: string }
  | { type: 'session-revoked'; sessionId: string }
  | { type: 'document-archived'; documentId: string };

/** Payload fields that are Dates; JSON turns them into strings on the way through Redis. */
const DATE_KEYS = new Set(['occurredAt', 'createdAt', 'updatedAt', 'archivedAt']);
const reviveDates = (key: string, value: unknown) =>
  DATE_KEYS.has(key) && typeof value === 'string' ? new Date(value) : value;

/**
 * Fan-out point for application (non-document) events.
 *
 * Without REDIS_URL the PubSub is in-memory, which is correct for a single instance. With
 * REDIS_URL, GraphQL subscription events go through Redis, and access events are published on a
 * Redis channel so every instance can close the affected collaboration sessions.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(EventsService.name);
  private readonly config = appConfig();
  private readonly instanceId = randomUUID();
  private readonly accessChannel = this.redisChannel('access');
  private redisPub?: IORedis;
  private redisSub?: IORedis;

  readonly pubSub: PubSubEngine;
  readonly access$ = new Subject<AccessEvent>();

  constructor() {
    const url = this.config.redisUrl;
    if (!url) {
      this.pubSub = new PubSub();
      return;
    }
    this.redisPub = new IORedis(url, { lazyConnect: true });
    this.redisSub = new IORedis(url, { lazyConnect: true });
    this.pubSub = new RedisPubSub({
      publisher: this.redisPub,
      subscriber: this.redisSub,
      reviver: reviveDates,
      triggerTransform: (trigger) => this.redisChannel(String(trigger)),
    });
  }

  async onModuleInit() {
    if (!this.redisPub || !this.redisSub) return;
    await Promise.all([this.redisPub.connect(), this.redisSub.connect()]);
    this.redisSub.on('message', (channel: string, raw: string) => {
      if (channel !== this.accessChannel) return;
      try {
        const { origin, event } = JSON.parse(raw) as { origin: string; event: AccessEvent };
        // Local events were already delivered by emitAccess.
        if (origin !== this.instanceId) this.access$.next(event);
      } catch (error) {
        this.logger.warn(`ignoring malformed access event: ${(error as Error).message}`);
      }
    });
    // Subscribe before the app starts serving, so no revocation is missed after boot.
    await this.redisSub.subscribe(this.accessChannel);
    this.logger.log('events fan out through Redis');
  }

  async onApplicationShutdown() {
    this.access$.complete();
    this.redisPub?.disconnect();
    this.redisSub?.disconnect();
  }

  /** `up`/`down` with Redis configured, otherwise `disabled`. */
  get redisStatus(): 'up' | 'down' | 'disabled' {
    if (!this.redisPub || !this.redisSub) return 'disabled';
    return this.redisPub.status === 'ready' && this.redisSub.status === 'ready' ? 'up' : 'down';
  }

  static workspaceTopic(workspaceId: string) {
    return `workspace:${workspaceId}`;
  }

  static documentTopic(documentId: string) {
    return `document:${documentId}`;
  }

  publishWorkspaceEvent(event: Omit<WorkspaceEvent, 'occurredAt'>) {
    const payload: WorkspaceEvent = { ...event, occurredAt: new Date() };
    void this.publish(EventsService.workspaceTopic(event.workspaceId), { workspaceActivity: payload });
  }

  publishDocumentChanged(document: Document) {
    void this.publish(EventsService.documentTopic(document.id), { documentMetadataChanged: document });
  }

  /**
   * Delivers the event to this instance immediately, then to the other instances through Redis.
   * If Redis is unavailable, the local sessions are still closed.
   */
  emitAccess(event: AccessEvent) {
    this.access$.next(event);
    if (!this.redisPub) return;
    this.redisPub
      .publish(this.accessChannel, JSON.stringify({ origin: this.instanceId, event }))
      .catch((error: Error) => this.logger.error(`failed to publish access event ${event.type}: ${error.message}`));
  }

  private redisChannel(topic: string) {
    return `${this.config.redisPrefix}:${topic}`;
  }

  private async publish(topic: string, payload: object) {
    try {
      // RedisPubSub applies triggerTransform when subscribing but not when publishing.
      await this.pubSub.publish(this.redisPub ? this.redisChannel(topic) : topic, payload);
    } catch (error) {
      this.logger.error(`failed to publish ${topic}: ${(error as Error).message}`);
    }
  }
}
