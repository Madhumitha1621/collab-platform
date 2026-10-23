function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) throw new Error(`Environment variable ${name} must be an integer`);
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** Typed view over environment configuration. Read lazily so tests can override env vars. */
export function appConfig() {
  return {
    port: int('PORT', 4000),
    corsOrigins: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((o) => o.trim()),
    databaseUrl: required('DATABASE_URL'),
    jwtSecret: required('JWT_SECRET'),
    jwtExpiresInSeconds: int('JWT_EXPIRES_IN_SECONDS', 86400),
    /** When set, collaboration, subscriptions and access events fan out across instances via Redis. */
    redisUrl: process.env.REDIS_URL || undefined,
    redisPrefix: process.env.REDIS_PREFIX || 'collab',
    collab: {
      enabled: process.env.COLLAB_ENABLED !== 'false',
      port: int('COLLAB_PORT', 1234),
      maxMessageBytes: int('COLLAB_MAX_MESSAGE_BYTES', 1024 * 1024),
      maxMessagesPerSecond: int('COLLAB_MAX_MESSAGES_PER_SECOND', 200),
    },
    persistence: {
      flushMs: int('PERSIST_FLUSH_MS', 500),
      maxRetries: int('PERSIST_MAX_RETRIES', 5),
      snapshotThreshold: int('SNAPSHOT_UPDATE_THRESHOLD', 200),
    },
    /** Public URL of the web app, used for links in emails. */
    webUrl: (process.env.WEB_URL || 'http://localhost:5173').replace(/\/+$/, ''),
    mail: {
      /** e.g. smtps://user:pass@smtp.example.com:465. Unset: emails are logged (dev only). */
      smtpUrl: process.env.SMTP_URL || undefined,
      from: process.env.MAIL_FROM || 'Collab <no-reply@collab.local>',
    },
    invitationTtlHours: int('INVITATION_TTL_HOURS', 168),
  };
}

export type AppConfig = ReturnType<typeof appConfig>;
