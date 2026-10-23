import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { GqlContext } from '../common/gql-context';
import { AuthService } from './auth.service';

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' ? token : undefined;
}

@Injectable()
export class GqlAuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = GqlExecutionContext.create(context).getContext<GqlContext>();
    // Subscriptions authenticate once in the graphql-ws onConnect handler.
    if (ctx.user) return true;
    ctx.user = await this.auth.validateToken(bearerToken(ctx.req?.headers.authorization));
    return true;
  }
}
