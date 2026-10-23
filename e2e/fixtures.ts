import { expect, type Browser, type Locator, type Page } from '@playwright/test';
import { E2E } from '../playwright.config';

const PASSWORD = 'e2e-password-1';

export async function api<T = any>(query: string, variables: object = {}, token?: string): Promise<T> {
  const res = await fetch(E2E.api, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

export interface Account {
  name: string;
  email: string;
  token: string;
}

export async function register(name: string): Promise<Account> {
  const email = `${name.split(' ')[0].toLowerCase()}+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}@e2e.test`;
  const data = await api(`mutation($i: RegisterInput!) { register(input: $i) { token } }`, { i: { name, email, password: PASSWORD } });
  return { name, email, token: data.register.token };
}

/** Owner + editor + viewer sharing one workspace and document. */
export async function seedTeam(title = 'Launch plan') {
  const [owner, editor, viewer] = await Promise.all([register('Ada Owner'), register('Ben Editor'), register('Cy Viewer')]);
  const { createWorkspace } = await api(`mutation { createWorkspace(input: { name: "Product team" }) { id } }`, {}, owner.token);
  const workspaceId = createWorkspace.id as string;
  for (const [member, role] of [
    [editor, 'EDITOR'],
    [viewer, 'VIEWER'],
  ] as const) {
    await api(
      `mutation($i: InviteWorkspaceMemberInput!) { inviteWorkspaceMember(input: $i) { userId } }`,
      { i: { workspaceId, email: member.email, role } },
      owner.token,
    );
  }
  const { createDocument } = await api(
    `mutation($i: CreateDocumentInput!) { createDocument(input: $i) { id } }`,
    { i: { workspaceId, title } },
    owner.token,
  );
  return { owner, editor, viewer, workspaceId, documentId: createDocument.id as string };
}

/** Opens a fresh browser context (separate storage) signed in through the login form. */
export async function signedInPage(browser: Browser, account: Account): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('heading', { name: 'Workspaces' })).toBeVisible();
  return page;
}

export async function openDocument(page: Page, documentId: string) {
  await page.goto(`/d/${documentId}`);
  await expect(page.getByRole('status')).toContainText('All changes saved');
  return page.locator('.tiptap');
}

/** List item texts, ignoring remote caret widgets (which carry the collaborator's name). */
export function listItems(editor: Locator): Promise<string[]> {
  return editor.locator('ul li').evaluateAll((items) =>
    items.map((item) => {
      const copy = item.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('.collaboration-carets__caret').forEach((caret) => caret.remove());
      return copy.textContent ?? '';
    }),
  );
}

/** Focuses the editor with the cursor at the end of the last list item's text. */
export async function placeCursorAtEndOfLastListItem(editor: Locator) {
  await editor.evaluate((dom) => {
    // TipTap attaches its Editor instance to the root DOM node.
    const tiptap = (dom as HTMLElement & { editor: any }).editor;
    let end = -1;
    tiptap.state.doc.descendants((node: any, pos: number) => {
      // listItem > paragraph: the paragraph's text ends 2 positions before the item closes.
      if (node.type.name === 'listItem') end = pos + node.nodeSize - 2;
    });
    tiptap.chain().focus().setTextSelection(end).run();
  });
}
