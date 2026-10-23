import { createClient, type Client } from 'graphql-ws';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/graphql';
export const COLLAB_URL = import.meta.env.VITE_COLLAB_URL ?? 'ws://localhost:1234';
const WS_API_URL = API_URL.replace(/^http/, 'ws');

const TOKEN_KEY = 'collab.token';

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode); the session lasts for this tab only.
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

let onUnauthenticated: () => void = () => undefined;
export function setUnauthenticatedHandler(handler: () => void) {
  onUnauthenticated = handler;
}

export async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = readToken();
  let response: Response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ query, variables }),
    });
  } catch {
    throw new ApiError('Cannot reach the server', 'NETWORK');
  }
  const body = await response.json().catch(() => ({}));
  const error = body.errors?.[0];
  if (error) {
    const code = error.extensions?.code ?? 'INTERNAL_SERVER_ERROR';
    if (code === 'UNAUTHENTICATED' && token) onUnauthenticated();
    throw new ApiError(error.message, code);
  }
  return body.data as T;
}

let wsClient: Client | null = null;
let wsClientToken: string | null = null;

/** GraphQL subscription client for application events (not document edits). */
export function subscriptionClient(): Client {
  const token = readToken();
  if (!wsClient || wsClientToken !== token) {
    void wsClient?.dispose();
    wsClientToken = token;
    wsClient = createClient({
      url: WS_API_URL,
      connectionParams: () => ({ authorization: token ? `Bearer ${token}` : '' }),
      retryAttempts: Infinity,
      shouldRetry: () => true,
    });
  }
  return wsClient;
}

export function subscribe<T>(query: string, variables: Record<string, unknown>, onData: (data: T) => void): () => void {
  return subscriptionClient().subscribe<T>(
    { query, variables },
    {
      next: (result) => result.data && onData(result.data as T),
      error: () => undefined,
      complete: () => undefined,
    },
  );
}

export type Role = 'OWNER' | 'EDITOR' | 'VIEWER';

export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Workspace {
  id: string;
  name: string;
  ownerId: string;
  myRole: Role;
}

export interface Member {
  userId: string;
  role: Role;
  user: User;
}

export interface DocumentMeta {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt: string;
  archivedAt: string | null;
  myRole: Role;
}
