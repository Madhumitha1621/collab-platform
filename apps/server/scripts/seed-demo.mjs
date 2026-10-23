// Creates demo accounts, a workspace and a document through the public GraphQL API.
// Usage (API must be running): npm run seed:demo -w apps/server
const API = process.env.API_URL ?? 'http://localhost:4000/graphql';
const PASSWORD = 'demo-password-1';
const USERS = [
  { name: 'Ada Owner', email: 'ada@demo.test' },
  { name: 'Ben Editor', email: 'ben@demo.test' },
  { name: 'Cy Viewer', email: 'cy@demo.test' },
];

async function gql(query, variables = {}, token) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

async function signIn({ name, email }) {
  try {
    return (await gql(`mutation($i: LoginInput!) { login(input: $i) { token } }`, { i: { email, password: PASSWORD } })).login.token;
  } catch {
    return (await gql(`mutation($i: RegisterInput!) { register(input: $i) { token } }`, { i: { name, email, password: PASSWORD } }))
      .register.token;
  }
}

const [ada] = await Promise.all(USERS.map(signIn));
const { createWorkspace } = await gql(`mutation { createWorkspace(input: { name: "Demo team" }) { id } }`, {}, ada);
await gql(
  `mutation($i: InviteWorkspaceMemberInput!) { inviteWorkspaceMember(input: $i) { userId } }`,
  { i: { workspaceId: createWorkspace.id, email: USERS[1].email, role: 'EDITOR' } },
  ada,
);
await gql(
  `mutation($i: InviteWorkspaceMemberInput!) { inviteWorkspaceMember(input: $i) { userId } }`,
  { i: { workspaceId: createWorkspace.id, email: USERS[2].email, role: 'VIEWER' } },
  ada,
);
const { createDocument } = await gql(
  `mutation($i: CreateDocumentInput!) { createDocument(input: $i) { id } }`,
  { i: { workspaceId: createWorkspace.id, title: 'Project kickoff notes' } },
  ada,
);

console.log('Demo data ready. Password for every account:', PASSWORD);
for (const u of USERS) console.log(`  ${u.email}`);
console.log(`Document: http://localhost:5173/d/${createDocument.id}`);
