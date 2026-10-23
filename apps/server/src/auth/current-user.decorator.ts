import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { AuthUser, GqlContext } from '../common/gql-context';

export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext): AuthUser => {
  return GqlExecutionContext.create(context).getContext<GqlContext>().user!;
});
