import * as Y from 'yjs';
import { MailerService } from '../src/mail/mailer.service';
import {
  addMember,
  connect,
  gql,
  registerUser,
  resetDatabase,
  setupWorkspace,
  sleep,
  startApp,
  waitFor,
  waitSynced,
  type TestApp,
  type TestClient,
} from './helpers';

describe('P1 features', () => {
  let t: TestApp;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    t = await startApp();
    await resetDatabase(t.app);
  });
  afterEach(() => {
    while (clients.length) clients.pop()!.destroy();
  });
  afterAll(() => t.close());

  const lastInviteToken = (to: string) => {
    const mail = [...t.app.get(MailerService).outbox].reverse().find((m) => m.to === to);
    return mail?.text.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  };

  describe('activity history', () => {
    it('records document and membership changes for members, newest first', async () => {
      const { owner, workspaceId, documentId } = await setupWorkspace(t.app);
      const viewer = await registerUser(t.app, 'viewer');
      await addMember(t.app, owner.token, workspaceId, viewer.user.email, 'VIEWER');
      await gql(
        t.app,
        `mutation($input: RenameDocumentInput!) { renameDocument(input: $input) { id } }`,
        { input: { id: documentId, title: 'Spec v2' } },
        owner.token,
      );

      const res = await gql(
        t.app,
        `query($id: ID!) { activityLog(workspaceId: $id) { id type actorName targetUserName documentTitle detail } }`,
        { id: workspaceId },
        viewer.token,
      );
      expect(res.data.activityLog.map((a: { type: string }) => a.type)).toEqual([
        'DOCUMENT_RENAMED',
        'MEMBER_ADDED',
        'DOCUMENT_CREATED',
      ]);
      expect(res.data.activityLog[0]).toMatchObject({ actorName: 'owner', documentTitle: 'Spec v2', detail: 'Spec' });
      expect(res.data.activityLog[1]).toMatchObject({ targetUserName: 'viewer', detail: 'VIEWER' });

      const page = await gql(
        t.app,
        `query($id: ID!, $before: ID) { activityLog(workspaceId: $id, before: $before) { type } }`,
        { id: workspaceId, before: res.data.activityLog[1].id },
        viewer.token,
      );
      expect(page.data.activityLog).toEqual([{ type: 'DOCUMENT_CREATED' }]);
    });

    it('hides the history from non-members', async () => {
      const { workspaceId } = await setupWorkspace(t.app);
      const outsider = await registerUser(t.app, 'outsider');
      const res = await gql(t.app, `query($id: ID!) { activityLog(workspaceId: $id) { id } }`, { id: workspaceId }, outsider.token);
      expect(res.errors?.[0].extensions.code).toBe('NOT_FOUND');
    });
  });

  describe('title search', () => {
    it('finds documents across my workspaces only, prefix matches first, wildcards literal', async () => {
      const a = await setupWorkspace(t.app);
      const create = (workspaceId: string, title: string, token: string) =>
        gql(t.app, `mutation($input: CreateDocumentInput!) { createDocument(input: $input) { id } }`, { input: { workspaceId, title } }, token);
      await create(a.workspaceId, 'Roadmap 2027', a.owner.token);
      await create(a.workspaceId, 'Q3 roadmap review', a.owner.token);
      await create(a.workspaceId, '100% done', a.owner.token);
      const other = await setupWorkspace(t.app);
      await create(other.workspaceId, 'Roadmap secret', other.owner.token);

      const search = (query: string) =>
        gql(t.app, `query($q: String!) { searchDocuments(query: $q) { title workspaceName } }`, { q: query }, a.owner.token);
      const roadmap = await search('roadmap');
      expect(roadmap.data.searchDocuments.map((d: { title: string }) => d.title)).toEqual(['Roadmap 2027', 'Q3 roadmap review']);
      expect(roadmap.data.searchDocuments[0].workspaceName).toBe('Team');
      expect((await search('%')).data.searchDocuments.map((d: { title: string }) => d.title)).toEqual(['100% done']);
      expect((await search('   ')).errors?.[0].extensions.code).toBe('BAD_REQUEST');
    });
  });

  describe('email invitations', () => {
    it('emails a link that the invited address can accept exactly once', async () => {
      const { owner, workspaceId } = await setupWorkspace(t.app);
      const email = `newcomer-${Date.now()}@example.com`;
      const sent = await gql(
        t.app,
        `mutation($input: SendWorkspaceInvitationInput!) { sendWorkspaceInvitation(input: $input) { id email role status } }`,
        { input: { workspaceId, email, role: 'EDITOR' } },
        owner.token,
      );
      expect(sent.data.sendWorkspaceInvitation).toMatchObject({ email, role: 'EDITOR', status: 'PENDING' });
      const token = lastInviteToken(email)!;
      expect(token).toBeDefined();

      const preview = await gql(t.app, `query($t: String!) { invitation(token: $t) { workspaceName invitedByName status } }`, { t: token });
      expect(preview.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');

      // Someone else cannot use the forwarded link.
      const stranger = await registerUser(t.app, 'stranger');
      const wrong = await gql(t.app, `mutation($t: String!) { acceptWorkspaceInvitation(token: $t) { id } }`, { t: token }, stranger.token);
      expect(wrong.errors?.[0].extensions.code).toBe('FORBIDDEN');

      const newcomer = await gql(
        t.app,
        `mutation($i: RegisterInput!) { register(input: $i) { token } }`,
        { i: { name: 'Newcomer', email, password: 'password123' } },
      );
      const newcomerToken = newcomer.data.register.token;
      const seen = await gql(t.app, `query($t: String!) { invitation(token: $t) { workspaceName invitedByName status } }`, { t: token }, newcomerToken);
      expect(seen.data.invitation).toEqual({ workspaceName: 'Team', invitedByName: 'owner', status: 'PENDING' });

      const accepted = await gql(t.app, `mutation($t: String!) { acceptWorkspaceInvitation(token: $t) { id } }`, { t: token }, newcomerToken);
      expect(accepted.data.acceptWorkspaceInvitation.id).toBe(workspaceId);
      const role = await gql(t.app, `query($id: ID!) { workspace(id: $id) { myRole } }`, { id: workspaceId }, newcomerToken);
      expect(role.data.workspace.myRole).toBe('EDITOR');

      const again = await gql(t.app, `mutation($t: String!) { acceptWorkspaceInvitation(token: $t) { id } }`, { t: token }, newcomerToken);
      expect(again.errors?.[0].extensions.code).toBe('BAD_REQUEST');
    });

    it('lets owners list and revoke invitations, and re-inviting replaces the old link', async () => {
      const { owner, workspaceId } = await setupWorkspace(t.app);
      const email = `pending-${Date.now()}@example.com`;
      const send = () =>
        gql(
          t.app,
          `mutation($input: SendWorkspaceInvitationInput!) { sendWorkspaceInvitation(input: $input) { id } }`,
          { input: { workspaceId, email, role: 'VIEWER' } },
          owner.token,
        );
      await send();
      const firstToken = lastInviteToken(email)!;
      const second = await send();
      const list = await gql(t.app, `query($id: ID!) { workspaceInvitations(workspaceId: $id) { id email } }`, { id: workspaceId }, owner.token);
      expect(list.data.workspaceInvitations).toEqual([{ id: second.data.sendWorkspaceInvitation.id, email }]);

      const invitee = await gql(t.app, `mutation($i: RegisterInput!) { register(input: $i) { token } }`, {
        i: { name: 'Invitee', email, password: 'password123' },
      });
      const stale = await gql(
        t.app,
        `mutation($t: String!) { acceptWorkspaceInvitation(token: $t) { id } }`,
        { t: firstToken },
        invitee.data.register.token,
      );
      expect(stale.errors?.[0].message).toContain('revoked');

      await gql(t.app, `mutation($id: ID!) { revokeWorkspaceInvitation(id: $id) }`, { id: second.data.sendWorkspaceInvitation.id }, owner.token);
      const after = await gql(t.app, `query($id: ID!) { workspaceInvitations(workspaceId: $id) { id } }`, { id: workspaceId }, owner.token);
      expect(after.data.workspaceInvitations).toEqual([]);
    });

    it('only owners can invite', async () => {
      const { owner, workspaceId } = await setupWorkspace(t.app);
      const editor = await registerUser(t.app, 'editor');
      await addMember(t.app, owner.token, workspaceId, editor.user.email, 'EDITOR');
      const res = await gql(
        t.app,
        `mutation($input: SendWorkspaceInvitationInput!) { sendWorkspaceInvitation(input: $input) { id } }`,
        { input: { workspaceId, email: 'x@example.com', role: 'VIEWER' } },
        editor.token,
      );
      expect(res.errors?.[0].extensions.code).toBe('FORBIDDEN');
    });

    it('notifies existing users added directly', async () => {
      const { owner, workspaceId } = await setupWorkspace(t.app);
      const member = await registerUser(t.app, 'member');
      await addMember(t.app, owner.token, workspaceId, member.user.email, 'VIEWER');
      const mail = t.app.get(MailerService).outbox.find((m) => m.to === member.user.email);
      expect(mail?.subject).toBe('You were added to Team');
    });
  });

  describe('named versions', () => {
    it('saves versions and restores one live, keeping the pre-restore state as a version', async () => {
      const { owner, workspaceId, documentId } = await setupWorkspace(t.app);
      const viewer = await registerUser(t.app, 'viewer');
      await addMember(t.app, owner.token, workspaceId, viewer.user.email, 'VIEWER');
      const editor = connect(t.collabUrl, documentId, owner.token);
      const reader = connect(t.collabUrl, documentId, viewer.token);
      clients.push(editor, reader);
      await Promise.all([waitSynced(editor), waitSynced(reader)]);

      editor.text.insert(0, 'first draft');
      await waitFor(() => editor.stateless.some((s) => s.includes('"saved"')), 5000, 'saved');
      const v1 = await gql(
        t.app,
        `mutation($input: CreateDocumentSnapshotInput!) { createDocumentSnapshot(input: $input) { id label createdByName } }`,
        { input: { documentId, label: 'Draft 1' } },
        owner.token,
      );
      expect(v1.data.createDocumentSnapshot).toMatchObject({ label: 'Draft 1', createdByName: 'owner' });

      editor.text.delete(0, editor.text.length);
      editor.text.insert(0, 'rewritten completely');
      await waitFor(() => reader.text.toString() === 'rewritten completely', 5000, 'reader sees rewrite');

      const denied = await gql(t.app, `mutation($id: ID!) { restoreDocumentSnapshot(snapshotId: $id) { id } }`, { id: v1.data.createDocumentSnapshot.id }, viewer.token);
      expect(denied.errors?.[0].extensions.code).toBe('FORBIDDEN');

      const restored = await gql(
        t.app,
        `mutation($id: ID!) { restoreDocumentSnapshot(snapshotId: $id) { label } }`,
        { id: v1.data.createDocumentSnapshot.id },
        owner.token,
      );
      expect(restored.data.restoreDocumentSnapshot.label).toBe('Before restoring "Draft 1"');
      // Connected clients receive the restore as a normal edit.
      await waitFor(() => editor.text.toString() === 'first draft' && reader.text.toString() === 'first draft', 5000, 'restore');

      const versions = await gql(t.app, `query($id: ID!) { documentSnapshots(documentId: $id) { label } }`, { id: documentId }, viewer.token);
      expect(versions.data.documentSnapshots.map((v: { label: string }) => v.label)).toEqual(['Before restoring "Draft 1"', 'Draft 1']);

      // The restore is durable.
      const fresh = connect(t.collabUrl, documentId, owner.token);
      clients.push(fresh);
      await waitSynced(fresh);
      expect(fresh.text.toString()).toBe('first draft');
    });

    it('restores rich-text (XML fragment) content used by the editor', async () => {
      const { owner, documentId } = await setupWorkspace(t.app);
      const c = connect(t.collabUrl, documentId, owner.token);
      clients.push(c);
      await waitSynced(c);
      const fragment = c.ydoc.getXmlFragment('default');
      const paragraph = new Y.XmlElement('paragraph');
      paragraph.insert(0, [new Y.XmlText('original paragraph')]);
      fragment.insert(0, [paragraph]);
      await waitFor(() => c.stateless.some((s) => s.includes('"saved"')), 5000, 'saved');
      const v1 = await gql(
        t.app,
        `mutation($input: CreateDocumentSnapshotInput!) { createDocumentSnapshot(input: $input) { id } }`,
        { input: { documentId, label: 'v1' } },
        owner.token,
      );

      const heading = new Y.XmlElement('heading');
      heading.insert(0, [new Y.XmlText('new heading')]);
      fragment.delete(0, fragment.length);
      fragment.insert(0, [heading]);
      await sleep(200);

      await gql(t.app, `mutation($id: ID!) { restoreDocumentSnapshot(snapshotId: $id) { id } }`, { id: v1.data.createDocumentSnapshot.id }, owner.token);
      await waitFor(() => fragment.toString() === '<paragraph>original paragraph</paragraph>', 5000, 'xml restore');
    });
  });

  it('marks documents as modified when their content changes', async () => {
    const { owner, documentId } = await setupWorkspace(t.app);
    const query = `query($id: ID!) { document(id: $id) { updatedAt } }`;
    const before = (await gql(t.app, query, { id: documentId }, owner.token)).data.document.updatedAt;
    await sleep(20);
    const c = connect(t.collabUrl, documentId, owner.token);
    clients.push(c);
    await waitSynced(c);
    c.text.insert(0, 'edit');
    await waitFor(() => c.stateless.some((s) => s.includes('"saved"')), 5000, 'saved');
    const after = (await gql(t.app, query, { id: documentId }, owner.token)).data.document.updatedAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});
