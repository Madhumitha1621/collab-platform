import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { Connection, Extension, Server } from '@hocuspocus/server';
import { Subscription } from 'rxjs';
import * as Y from 'yjs';
import { AuthService } from '../auth/auth.service';
import { isUuid } from '../common/ids';
import { Role } from '../common/roles';
import { appConfig } from '../config';
import { AccessEvent, EventsService } from '../events/events.service';
import { PersistenceService, PersistenceStatus } from '../persistence/persistence.service';
import { AccessService } from '../workspaces/access.service';

/** Per-connection identity stored by Hocuspocus as `connection.context`. */
export interface CollabContext {
  userId: string;
  sessionId: string;
  workspaceId: string;
  documentId: string;
  role: Role;
}

/** Close code sent when the server ends a session because access changed; the client re-authenticates. */
export const ACCESS_CHANGED_CLOSE_CODE = 4401;

class CollabError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Yjs collaboration endpoint built on Hocuspocus, a maintained server for the standard
 * y-protocols sync + awareness messages. NestJS owns authentication, authorization and
 * persistence; Hocuspocus owns the wire protocol, document rooms and awareness.
 *
 * Document name == document UUID. Viewers connect read-only: Hocuspocus refuses their sync
 * and update messages server-side, so bypassing the UI cannot change the document.
 */
@Injectable()
export class CollaborationService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(CollaborationService.name);
  private readonly config = appConfig().collab;
  private server?: Server;
  private accessSubscription?: Subscription;
  private readonly messageWindows = new WeakMap<Connection, { windowStart: number; count: number }>();
  readonly stats = { rejectedConnections: 0, rejectedMessages: 0, revokedConnections: 0 };

  constructor(
    private readonly auth: AuthService,
    private readonly access: AccessService,
    private readonly persistence: PersistenceService,
    private readonly events: EventsService,
  ) {}

  async onApplicationBootstrap() {
    this.persistence.setStateVectorProvider((documentId) => {
      const document = this.server?.hocuspocus.documents.get(documentId);
      return document ? Y.encodeStateVector(document) : undefined;
    });
    this.persistence.onStatus((documentId, status) => this.broadcastPersistence(documentId, status));
    this.accessSubscription = this.events.access$.subscribe((event) => this.handleAccessEvent(event));
    if (this.config.enabled) await this.listen(this.config.port);
  }

  async onApplicationShutdown() {
    this.accessSubscription?.unsubscribe();
    // Hocuspocus stores (and therefore flushes) every loaded document while shutting down.
    await this.server?.destroy();
    this.server = undefined;
  }

  async listen(port: number): Promise<number> {
    this.server = new Server(
      {
        name: 'collab',
        port,
        quiet: true,
        timeout: 30_000,
        // Safety net: the persistence service already flushes every PERSIST_FLUSH_MS.
        debounce: 2_000,
        maxDebounce: 10_000,
        extensions: [this.extension()],
      },
      { maxPayload: this.config.maxMessageBytes },
    );
    await this.server.listen();
    const actualPort = this.server.address.port;
    this.logger.log(`collaboration server listening on ws://localhost:${actualPort}`);
    return actualPort;
  }

  get port(): number | undefined {
    return this.server?.address.port;
  }

  get documentsCount(): number {
    return this.server?.hocuspocus.getDocumentsCount() ?? 0;
  }

  get connectionsCount(): number {
    return this.server?.hocuspocus.getConnectionsCount() ?? 0;
  }

  private extension(): Extension {
    return {
      onAuthenticate: async ({ token, documentName, connectionConfig, socketId }) => {
        if (!isUuid(documentName)) {
          this.stats.rejectedConnections++;
          throw new CollabError('invalid-document');
        }
        const user = await this.auth.validateToken(token).catch(() => null);
        if (!user) {
          this.stats.rejectedConnections++;
          this.logger.warn(`collab auth rejected: invalid token socket=${socketId}`);
          throw new CollabError('unauthenticated');
        }
        const access = await this.access.requireDocument(user.id, documentName, Role.VIEWER).catch(() => null);
        if (!access) {
          this.stats.rejectedConnections++;
          this.logger.warn(`collab auth rejected: no access user=${user.id} document=${documentName}`);
          throw new CollabError('forbidden');
        }
        connectionConfig.readOnly = access.role === Role.VIEWER;
        this.logger.log(`collab join user=${user.id} document=${documentName} role=${access.role}`);
        const context: CollabContext = {
          userId: user.id,
          sessionId: user.sessionId,
          workspaceId: access.document.workspaceId,
          documentId: documentName,
          role: access.role,
        };
        return context;
      },

      beforeHandleMessage: async ({ connection, update }) => {
        // ws enforces maxPayload at the frame level; this also bounds per-connection message rate.
        const now = Date.now();
        const window = this.messageWindows.get(connection);
        if (!window || now - window.windowStart >= 1000) {
          this.messageWindows.set(connection, { windowStart: now, count: 1 });
        } else if (++window.count > this.config.maxMessagesPerSecond) {
          this.stats.rejectedMessages++;
          throw Object.assign(new CollabError('rate-limited'), { code: 4429 });
        }
        if (update.byteLength > this.config.maxMessageBytes) {
          this.stats.rejectedMessages++;
          throw Object.assign(new CollabError('message-too-large'), { code: 4413 });
        }
      },

      onLoadDocument: async ({ document, documentName }) => {
        const started = Date.now();
        // If this throws, Hocuspocus refuses the connection instead of serving an empty document
        // that could later overwrite stored content.
        const state = await this.persistence.loadState(documentName);
        if (state) Y.applyUpdate(document, state);
        this.logger.log(`loaded document=${documentName} bytes=${state?.byteLength ?? 0} ms=${Date.now() - started}`);
      },

      onChange: async ({ documentName, update }) => {
        this.persistence.enqueue(documentName, update);
      },

      onStoreDocument: async ({ documentName }) => {
        await this.persistence.flush(documentName);
      },
    };
  }

  private broadcastPersistence(documentId: string, status: PersistenceStatus) {
    const document = this.server?.hocuspocus.documents.get(documentId);
    if (!document) return;
    const payload =
      status.status === 'saved'
        ? { type: 'persistence', status: 'saved', stateVector: Buffer.from(status.stateVector).toString('base64') }
        : { type: 'persistence', status: 'error', message: status.message };
    document.broadcastStateless(JSON.stringify(payload));
  }

  /** Drops live sessions whose authorization may have changed; clients reconnect and re-authenticate. */
  private handleAccessEvent(event: AccessEvent) {
    const matches = (ctx: CollabContext) => {
      switch (event.type) {
        case 'membership-changed':
          return ctx.workspaceId === event.workspaceId && ctx.userId === event.userId;
        case 'session-revoked':
          return ctx.sessionId === event.sessionId;
        case 'document-archived':
          return ctx.documentId === event.documentId;
      }
    };
    for (const document of this.server?.hocuspocus.documents.values() ?? []) {
      for (const connection of document.getConnections()) {
        const ctx = connection.context as CollabContext | undefined;
        if (ctx && matches(ctx)) {
          this.stats.revokedConnections++;
          this.logger.log(`collab session closed (${event.type}) user=${ctx.userId} document=${ctx.documentId}`);
          connection.webSocket.close(ACCESS_CHANGED_CLOSE_CODE, 'access-changed');
        }
      }
    }
  }
}
