import { ActivityLog } from '../activity/activity-log.entity';
import { Session } from '../auth/session.entity';
import { Document } from '../documents/document.entity';
import { WorkspaceInvitation } from '../invitations/workspace-invitation.entity';
import { DocumentSnapshot } from '../persistence/document-snapshot.entity';
import { DocumentUpdate } from '../persistence/document-update.entity';
import { User } from '../users/user.entity';
import { WorkspaceMember } from '../workspaces/workspace-member.entity';
import { Workspace } from '../workspaces/workspace.entity';

export const ENTITIES = [
  User,
  Session,
  Workspace,
  WorkspaceMember,
  Document,
  DocumentUpdate,
  DocumentSnapshot,
  ActivityLog,
  WorkspaceInvitation,
];
