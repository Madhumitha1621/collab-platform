# API reference

Collab exposes two interfaces:

1. **GraphQL** (`/graphql`, HTTP and `graphql-ws` subscriptions) for accounts, workspaces, members,
   invitations, document metadata, versions, search and activity.
2. **Yjs collaboration WebSocket** (Hocuspocus, `ws://…:1234` or `/collab` behind nginx) for document
   content, cursors and presence.

The full machine-readable schema is generated to [`apps/server/schema.gql`](../apps/server/schema.gql).
In development, GraphiQL is available at `http://localhost:4000/graphql`.

## Authentication

`register` and `login` return a JWT. Send it on every request:

```http
Authorization: Bearer <token>
```

- Subscriptions (`graphql-ws`) pass it in `connectionParams: { authorization: "Bearer <token>" }`.
- The collaboration WebSocket takes it as the provider `token`.
- Tokens are tied to a server-side session. `logout` revokes the session and closes its open
  collaboration connections.

## Errors

Errors carry a stable `extensions.code`. Stack traces and internals are never returned.

| Code | When |
|---|---|
| `UNAUTHENTICATED` | Missing, invalid, expired or revoked token |
| `FORBIDDEN` | Signed in, but your role is too low (e.g. a viewer renaming a document) |
| `NOT_FOUND` | Missing resource, **or one you're not a member of** (existence is not revealed) |
| `BAD_REQUEST` | Validation failures, malformed ids, invalid state transitions |
| `INTERNAL_SERVER_ERROR` | Anything unexpected (details are only in the server log) |

## Roles

| Capability | Viewer | Editor | Owner |
|---|:-:|:-:|:-:|
| Read documents, members, activity, versions | ✅ | ✅ | ✅ |
| Edit content, create/rename/archive documents, save/restore versions | | ✅ | ✅ |
| Invite, change roles, remove members, rename workspace | | | ✅ |

Roles are enforced on the server for both GraphQL and the collaboration socket.

## Operations

### Queries

| Query | Returns |
|---|---|
| `me` | The signed-in user |
| `myWorkspaces` | Workspaces you belong to (each with `myRole`, `members`) |
| `workspace(id)` | One workspace |
| `documents(workspaceId, includeArchived = false)` | Documents, most recently edited first |
| `document(id)` | One document (`title`, `updatedAt`, `archivedAt`, `myRole`, `workspaceName`) |
| `searchDocuments(query, workspaceId?, limit = 20)` | Title search across your workspaces; prefix matches first, wildcards matched literally |
| `documentSnapshots(documentId)` | Named versions, newest first |
| `activityLog(workspaceId, limit = 30, before?)` | Workspace history, newest first. Pass the last `id` as `before` to page |
| `workspaceInvitations(workspaceId)` | Open invitations (owners) |
| `invitation(token)` | Preview of an invitation link: workspace, inviter, role, status |

### Mutations

| Mutation | Role | Notes |
|---|---|---|
| `register(input: { name, email, password })` | — | Password ≥ 8 characters |
| `login(input: { email, password })` | — | Generic error on bad credentials |
| `logout` | any | Revokes the session everywhere |
| `createWorkspace(input: { name })` | any | You become the owner |
| `updateWorkspace(input: { id, name })` | owner | |
| `sendWorkspaceInvitation(input: { workspaceId, email, role })` | owner | Emails a link valid for `INVITATION_TTL_HOURS` (default 7 days). Re-inviting replaces the old link |
| `revokeWorkspaceInvitation(id)` | owner | |
| `acceptWorkspaceInvitation(token)` | invitee | You must be signed in with the invited address |
| `inviteWorkspaceMember(input: { workspaceId, email, role })` | owner | Adds an **existing** user directly and emails them a notification |
| `updateMemberRole(input: { workspaceId, userId, role })` | owner | Live sessions reconnect with the new role |
| `removeWorkspaceMember(input: { workspaceId, userId })` | owner | Live sessions are closed |
| `createDocument(input: { workspaceId, title })` | editor | |
| `renameDocument(input: { id, title })` | editor | |
| `archiveDocument(id)` | editor | Closes open editing sessions |
| `createDocumentSnapshot(input: { documentId, label? })` | editor | Saves a named version |
| `restoreDocumentSnapshot(snapshotId)` | editor | Applies the version as a live edit. Saves `Before restoring "…"` first, so the restore can be undone |

### Subscriptions

| Subscription | Payload |
|---|---|
| `workspaceActivity(workspaceId)` | `WorkspaceEvent { type, workspaceId, actorId, documentId, userId, occurredAt }` for every change in the workspace |
| `documentMetadataChanged(documentId)` | The `Document` after a rename or archive |

Access is checked again for every delivered event, so a removed member stops receiving events at once.

### Example

```graphql
mutation Login {
  login(input: { email: "ada@demo.test", password: "demo-password-1" }) { token }
}

query Workspace($id: ID!) {
  workspace(id: $id) {
    name
    myRole
    members { role user { name email } }
  }
  documents(workspaceId: $id) { id title updatedAt }
  activityLog(workspaceId: $id, limit: 5) { type actorName documentTitle detail createdAt }
}
```

## Collaboration WebSocket

The server speaks the standard [y-protocols](https://github.com/yjs/y-protocols) sync and awareness
messages through [Hocuspocus](https://tiptap.dev/docs/hocuspocus). Any Hocuspocus provider works:

```ts
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';

const doc = new Y.Doc();
const provider = new HocuspocusProvider({
  url: 'ws://localhost:1234',   // or wss://your-host/collab
  name: documentId,             // the document UUID
  document: doc,
  token,                        // the JWT from login
});
```

TipTap edits the `Y.XmlFragment` named `default`.

| Behaviour | Detail |
|---|---|
| Authentication | `onAuthenticated({ scope })` reports `read-write` (editor/owner) or `readonly` (viewer). Failures arrive as `onAuthenticationFailed({ reason })` with `unauthenticated`, `forbidden` or `invalid-document` |
| Read-only | Viewer updates are dropped by the server and never persisted |
| Save acknowledgements | After each durable write the server broadcasts a stateless message `{"type":"persistence","status":"saved","stateVector":"<base64>"}`. Your edits are saved once `stateVector[yourClientId] >= your clock`. On storage trouble: `{"type":"persistence","status":"error","message":…}` |
| Limits | Messages over `COLLAB_MAX_MESSAGE_BYTES` (1 MB), or more than `COLLAB_MAX_MESSAGES_PER_SECOND` (200) per connection, close the connection (codes 4413 / 4429). The provider reconnects |
| Access changes | Role changes, removal, logout and archive close the socket with code **4401**. The provider reconnects and authenticates again with the new role, or is rejected |
