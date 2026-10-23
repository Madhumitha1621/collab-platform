import type { Request } from 'express';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  sessionId: string;
}

export interface GqlContext {
  req?: Request;
  user?: AuthUser;
}
