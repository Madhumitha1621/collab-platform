import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GraphQLModule } from '@nestjs/graphql';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLFormattedError } from 'graphql';
import { join } from 'node:path';
import { AuthResolver } from './auth/auth.resolver';
import { AuthService } from './auth/auth.service';
import { bearerToken } from './auth/gql-auth.guard';
import { CollaborationService } from './collaboration/collaboration.service';
import type { GqlContext } from './common/gql-context';
import { appConfig } from './config';
import { dataSourceOptions } from './database/data-source';
import { ENTITIES } from './database/entities';
import { DocumentsResolver } from './documents/documents.resolver';
import { DocumentsService } from './documents/documents.service';
import { EventsService } from './events/events.service';
import { HealthController } from './health/health.controller';
import { PersistenceService } from './persistence/persistence.service';
import { AccessService } from './workspaces/access.service';
import { WorkspacesResolver } from './workspaces/workspaces.resolver';
import { WorkspacesService } from './workspaces/workspaces.service';

/** Shared infrastructure: entities, auth, access policy and events. */
@Global()
@Module({
  imports: [
    TypeOrmModule.forFeature(ENTITIES),
    JwtModule.registerAsync({ useFactory: () => ({ secret: appConfig().jwtSecret }) }),
  ],
  providers: [AuthService, AccessService, EventsService],
  exports: [TypeOrmModule, AuthService, AccessService, EventsService],
})
class CoreModule {}

const KNOWN_CODES = new Set(['UNAUTHENTICATED', 'FORBIDDEN', 'BAD_REQUEST', 'BAD_USER_INPUT', 'NOT_FOUND', 'GRAPHQL_VALIDATION_FAILED']);

/** Returns structured errors without stack traces or internal details. */
function formatError(error: GraphQLFormattedError): GraphQLFormattedError {
  const original = error.extensions?.originalError as { statusCode?: number; message?: string | string[] } | undefined;
  let code = String(error.extensions?.code ?? 'INTERNAL_SERVER_ERROR');
  if (original?.statusCode === 404) code = 'NOT_FOUND';
  if (!KNOWN_CODES.has(code)) {
    return { message: 'Internal server error', path: error.path, extensions: { code: 'INTERNAL_SERVER_ERROR' } };
  }
  const message = Array.isArray(original?.message) ? original.message.join('; ') : error.message;
  return { message, path: error.path, locations: error.locations, extensions: { code } };
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      useFactory: () => ({ ...dataSourceOptions(appConfig().databaseUrl), migrationsRun: true }),
    }),
    CoreModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [AuthService],
      useFactory: (auth: AuthService) => ({
        autoSchemaFile: join(process.cwd(), 'schema.gql'),
        sortSchema: true,
        graphiql: process.env.NODE_ENV !== 'production',
        formatError,
        subscriptions: {
          'graphql-ws': {
            onConnect: async (ctx) => {
              const params = ctx.connectionParams as { authorization?: string } | undefined;
              try {
                (ctx.extra as { user?: unknown }).user = await auth.validateToken(bearerToken(params?.authorization));
                return true;
              } catch {
                return false;
              }
            },
          },
        },
        context: ({ req, extra }: { req?: GqlContext['req']; extra?: { user?: GqlContext['user'] } }): GqlContext => ({
          req,
          user: extra?.user,
        }),
      }),
    }),
  ],
  controllers: [HealthController],
  providers: [
    WorkspacesService,
    WorkspacesResolver,
    DocumentsService,
    DocumentsResolver,
    AuthResolver,
    PersistenceService,
    CollaborationService,
  ],
})
export class AppModule {}
