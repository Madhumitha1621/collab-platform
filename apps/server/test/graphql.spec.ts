import { addMember, gql, registerUser, resetDatabase, setupWorkspace, startApp, type TestApp } from './helpers';

describe('GraphQL API: authentication and authorization', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await startApp();
    await resetDatabase(t.app);
  });
  afterAll(() => t.close());

  it('rejects unauthenticated access to private data', async () => {
    const res = await gql(t.app, `{ myWorkspaces { id } }`);
    expect(res.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('rejects invalid tokens', async () => {
    const res = await gql(t.app, `{ me { id } }`, {}, 'not-a-jwt');
    expect(res.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('validates input', async () => {
    const res = await gql(t.app, `mutation { register(input: { name: "x", email: "not-an-email", password: "short" }) { token } }`);
    expect(res.errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });

  it('logs in, and logout revokes the token', async () => {
    const user = await registerUser(t.app, 'alice');
    const login = await gql(t.app, `mutation($i: LoginInput!) { login(input: $i) { token } }`, {
      i: { email: user.user.email, password: 'password123' },
    });
    const token = login.data.login.token;
    expect((await gql(t.app, `{ me { id } }`, {}, token)).data.me.id).toBe(user.user.id);

    await gql(t.app, `mutation { logout }`, {}, token);
    const after = await gql(t.app, `{ me { id } }`, {}, token);
    expect(after.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a wrong password with a generic message', async () => {
    const user = await registerUser(t.app, 'bob');
    const res = await gql(t.app, `mutation($i: LoginInput!) { login(input: $i) { token } }`, {
      i: { email: user.user.email, password: 'wrong-password' },
    });
    expect(res.errors?.[0]).toMatchObject({ message: 'Invalid email or password', extensions: { code: 'UNAUTHENTICATED' } });
  });

  it('hides workspaces and documents from non-members', async () => {
    const { workspaceId, documentId } = await setupWorkspace(t.app);
    const outsider = await registerUser(t.app, 'outsider');

    expect((await gql(t.app, `{ myWorkspaces { id } }`, {}, outsider.token)).data.myWorkspaces).toEqual([]);
    const ws = await gql(t.app, `query($id: ID!) { workspace(id: $id) { id } }`, { id: workspaceId }, outsider.token);
    expect(ws.errors?.[0].extensions.code).toBe('NOT_FOUND');
    const doc = await gql(t.app, `query($id: ID!) { document(id: $id) { id title } }`, { id: documentId }, outsider.token);
    expect(doc.errors?.[0].extensions.code).toBe('NOT_FOUND');
    const docs = await gql(t.app, `query($id: ID!) { documents(workspaceId: $id) { id } }`, { id: workspaceId }, outsider.token);
    expect(docs.errors?.[0].extensions.code).toBe('NOT_FOUND');
  });

  it('rejects malformed ids', async () => {
    const user = await registerUser(t.app, 'carol');
    const res = await gql(t.app, `query { document(id: "../../etc") { id } }`, {}, user.token);
    expect(res.errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });

  it('enforces roles: viewers read, editors write, only owners manage members', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(t.app);
    const viewer = await registerUser(t.app, 'viewer');
    const editor = await registerUser(t.app, 'editor');
    await addMember(t.app, owner.token, workspaceId, viewer.user.email, 'VIEWER');
    await addMember(t.app, owner.token, workspaceId, editor.user.email, 'EDITOR');

    const read = await gql(t.app, `query($id: ID!) { document(id: $id) { title myRole } }`, { id: documentId }, viewer.token);
    expect(read.data.document).toEqual({ title: 'Spec', myRole: 'VIEWER' });

    const create = `mutation($input: CreateDocumentInput!) { createDocument(input: $input) { id } }`;
    const denied = await gql(t.app, create, { input: { workspaceId, title: 'Nope' } }, viewer.token);
    expect(denied.errors?.[0].extensions.code).toBe('FORBIDDEN');
    const allowed = await gql(t.app, create, { input: { workspaceId, title: 'Yes' } }, editor.token);
    expect(allowed.data.createDocument.id).toBeDefined();

    const rename = await gql(
      t.app,
      `mutation($input: RenameDocumentInput!) { renameDocument(input: $input) { title } }`,
      { input: { id: documentId, title: 'Renamed' } },
      viewer.token,
    );
    expect(rename.errors?.[0].extensions.code).toBe('FORBIDDEN');

    const promote = await gql(
      t.app,
      `mutation($input: UpdateMemberRoleInput!) { updateMemberRole(input: $input) { role } }`,
      { input: { workspaceId, userId: viewer.user.id, role: 'EDITOR' } },
      editor.token,
    );
    expect(promote.errors?.[0].extensions.code).toBe('FORBIDDEN');
  });

  it('archives documents and hides them from the default listing', async () => {
    const { owner, workspaceId, documentId } = await setupWorkspace(t.app);
    const archived = await gql(t.app, `mutation($id: ID!) { archiveDocument(id: $id) { archivedAt } }`, { id: documentId }, owner.token);
    expect(archived.data.archiveDocument.archivedAt).toBeTruthy();
    const list = await gql(t.app, `query($id: ID!) { documents(workspaceId: $id) { id } }`, { id: workspaceId }, owner.token);
    expect(list.data.documents).toEqual([]);
    const all = await gql(
      t.app,
      `query($id: ID!) { documents(workspaceId: $id, includeArchived: true) { id } }`,
      { id: workspaceId },
      owner.token,
    );
    expect(all.data.documents).toHaveLength(1);
  });

  it('protects the workspace owner from removal', async () => {
    const { owner, workspaceId } = await setupWorkspace(t.app);
    const res = await gql(
      t.app,
      `mutation($input: RemoveWorkspaceMemberInput!) { removeWorkspaceMember(input: $input) }`,
      { input: { workspaceId, userId: owner.user.id } },
      owner.token,
    );
    expect(res.errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });
});
