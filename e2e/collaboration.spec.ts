import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { listItems, openDocument, seedTeam, signedInPage } from './fixtures';

const SCREENSHOTS = process.env.SCREENSHOTS === '1';
if (SCREENSHOTS) mkdirSync('docs/images', { recursive: true });

test('two people edit the same document live, with formatting, cursors and presence', async ({ browser }) => {
  const team = await seedTeam('Launch plan');
  const ada = await signedInPage(browser, team.owner);
  const ben = await signedInPage(browser, team.editor);
  const adaEditor = await openDocument(ada, team.documentId);
  const benEditor = await openDocument(ben, team.documentId);

  // Presence: both avatars appear in both sessions.
  await expect(ada.getByLabel('Active collaborators').locator('li')).toHaveCount(2);
  await expect(ben.getByLabel('Active collaborators').locator('li')).toHaveCount(2);

  await adaEditor.click();
  await ada.getByRole('button', { name: 'H1' }).click();
  await ada.keyboard.type('Launch plan');
  await ada.keyboard.press('Enter');
  await ada.keyboard.type('Goals for the release:');
  await ada.keyboard.press('Enter');
  await ada.getByRole('button', { name: '• List' }).click();
  await ada.keyboard.type('Ship real-time editing');

  await expect(benEditor.locator('h1')).toContainText('Launch plan');
  await expect.poll(() => listItems(benEditor)).toEqual(['Ship real-time editing']);

  // Ben adds to the same list while Ada is still in it.
  await benEditor.locator('ul li').last().click();
  await ben.keyboard.press('End');
  await ben.keyboard.press('Enter');
  await ben.getByRole('button', { name: 'B', exact: true }).click();
  await ben.keyboard.type('Zero lost edits');

  await expect.poll(() => listItems(adaEditor)).toEqual(['Ship real-time editing', 'Zero lost edits']);
  await expect(adaEditor.locator('strong')).toHaveText('Zero lost edits');
  // Ben's caret label is rendered in Ada's editor.
  await expect(adaEditor.locator('.collaboration-carets__label')).toHaveText('Ben Editor');
  await expect(ada.getByRole('status')).toContainText('All changes saved');
  await expect(ben.getByRole('status')).toContainText('All changes saved');

  if (SCREENSHOTS) await ada.screenshot({ path: 'docs/images/editor.png' });

  // Content is durable: a reload reconstructs it from PostgreSQL.
  await ada.reload();
  await expect(ada.locator('.tiptap h1')).toHaveText('Launch plan');
  await expect(ada.locator('.tiptap ul li')).toHaveCount(2);
});

test('viewers get a read-only editor and still see live changes', async ({ browser }) => {
  const team = await seedTeam('Read-only check');
  const ada = await signedInPage(browser, team.owner);
  const cy = await signedInPage(browser, team.viewer);
  const adaEditor = await openDocument(ada, team.documentId);
  const cyEditor = await openDocument(cy, team.documentId);

  await expect(cy.getByRole('status')).toContainText('view only');
  await expect(cyEditor).toHaveAttribute('contenteditable', 'false');
  await expect(cy.getByRole('toolbar', { name: 'Formatting' })).toHaveCount(0);
  await expect(cy.getByRole('button', { name: 'Restore' })).toHaveCount(0);

  await adaEditor.click();
  await ada.keyboard.type('Visible to viewers');
  await expect(cyEditor).toContainText('Visible to viewers');

  await cyEditor.click();
  await cy.keyboard.type('should not appear');
  await expect(adaEditor).not.toContainText('should not appear');
});

test('named versions can be saved and restored', async ({ browser }) => {
  const team = await seedTeam('Versioned doc');
  const ada = await signedInPage(browser, team.owner);
  const editor = await openDocument(ada, team.documentId);

  await editor.click();
  await ada.keyboard.type('Approved wording');
  await expect(ada.getByRole('status')).toContainText('All changes saved');
  await ada.getByPlaceholder('Name this version').fill('Approved');
  await ada.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(ada.locator('.version-list')).toContainText('Approved');

  await editor.press('Control+a');
  await ada.keyboard.type('Accidental rewrite');
  await expect(editor).toHaveText('Accidental rewrite');

  ada.once('dialog', (dialog) => void dialog.accept());
  await ada.locator('.version-list li', { hasText: 'Approved' }).last().getByRole('button', { name: 'Restore' }).click();
  await expect(editor).toHaveText('Approved wording');
  await expect(ada.locator('.version-list')).toContainText('Before restoring "Approved"');
  if (SCREENSHOTS) await ada.screenshot({ path: 'docs/images/versions.png' });
});

test('search finds documents and the workspace shows live activity', async ({ browser }) => {
  const team = await seedTeam('Quarterly roadmap');
  const ada = await signedInPage(browser, team.owner);
  const ben = await signedInPage(browser, team.editor);
  await ben.goto(`/w/${team.workspaceId}`);
  await expect(ben.locator('.activity')).toContainText('created Quarterly roadmap');

  await ada.getByLabel('Search documents').fill('quarterly');
  await ada.getByRole('option').filter({ hasText: 'Quarterly roadmap' }).click();
  await expect(ada.getByRole('heading', { name: 'Quarterly roadmap' })).toBeVisible();

  // Ada creates a document; Ben's open workspace page updates without a reload.
  await ada.goto(`/w/${team.workspaceId}`);
  await ada.getByPlaceholder('New document title').fill('Retro notes');
  await ada.getByRole('button', { name: 'New document' }).click();
  await expect(ben.getByRole('link', { name: 'Retro notes' }).first()).toBeVisible();
  await expect(ben.locator('.activity li').first()).toContainText('Ada Owner created Retro notes');
  await expect(ada.locator('.activity li').first()).toContainText('Ada Owner created Retro notes');
  if (SCREENSHOTS) await ada.screenshot({ path: 'docs/images/workspace.png' });
});
