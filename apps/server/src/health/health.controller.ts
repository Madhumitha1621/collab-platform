import { Controller, Get, Header, HttpCode, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { DataSource } from 'typeorm';
import { CollaborationService } from '../collaboration/collaboration.service';
import { PersistenceService } from '../persistence/persistence.service';

@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly collaboration: CollaborationService,
    private readonly persistence: PersistenceService,
  ) {}

  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    const database = await this.dataSource
      .query('SELECT 1')
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
    if (database === 'down') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      collaboration: {
        documents: this.collaboration.documentsCount,
        connections: this.collaboration.connectionsCount,
      },
      persistence: { queueDepth: this.persistence.queueDepth, ...this.persistence.stats },
    };
  }

  /** Prometheus text exposition format. */
  @Get('metrics')
  @HttpCode(200)
  @Header('Content-Type', 'text/plain; version=0.0.4')
  metrics(): string {
    const p = this.persistence.stats;
    const c = this.collaboration.stats;
    const lines: Array<[string, 'gauge' | 'counter', number]> = [
      ['collab_active_documents', 'gauge', this.collaboration.documentsCount],
      ['collab_active_connections', 'gauge', this.collaboration.connectionsCount],
      ['collab_rejected_connections_total', 'counter', c.rejectedConnections],
      ['collab_rejected_messages_total', 'counter', c.rejectedMessages],
      ['collab_revoked_connections_total', 'counter', c.revokedConnections],
      ['persistence_queue_depth', 'gauge', this.persistence.queueDepth],
      ['persistence_updates_persisted_total', 'counter', p.updatesPersisted],
      ['persistence_flushes_total', 'counter', p.flushes],
      ['persistence_flush_failures_total', 'counter', p.flushFailures],
      ['persistence_compactions_total', 'counter', p.compactions],
      ['persistence_last_flush_duration_ms', 'gauge', p.lastFlushDurationMs],
    ];
    return lines.map(([name, type, value]) => `# TYPE ${name} ${type}\n${name} ${value}`).join('\n') + '\n';
  }
}
