import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const electronExecutable = createRequire(import.meta.url)('electron') as string;

async function launchPackagedApp(
  applicationEntry: string,
  userDataDirectory: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [applicationEntry, `--user-data-dir=${userDataDirectory}`],
    env: environment,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function selectPdfWord(page: Page, word: string) {
  const textLayer = page.locator('.pdf-text-layer');
  await expect(textLayer.locator('span').first()).toBeVisible();
  await textLayer
    .locator('span', { hasText: word })
    .first()
    .evaluate((element, selectedWord) => {
      const textNode = [...element.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes(selectedWord),
      );
      if (!textNode?.textContent) {
        throw new Error(`The ${selectedWord} text run was not found.`);
      }
      const start = textNode.textContent.indexOf(selectedWord);
      const range = element.ownerDocument.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + selectedWord.length);
      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, word);
}

async function terminateDesktop(app: ElectronApplication): Promise<void> {
  const process = app.process();
  if (process.exitCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => process.once('exit', () => resolve()));
  process.kill('SIGKILL');
  await exited;
}

test('keeps books, word cards, and presets when replacing an installed app', async () => {
  const oldApplicationEntry = process.env.LEXIANCHOR_OLD_APP_ENTRY;
  const newApplicationEntry = process.env.LEXIANCHOR_NEW_APP_ENTRY;
  test.skip(
    !oldApplicationEntry || !newApplicationEntry,
    'Set old and new packaged app entries to run the release upgrade test.',
  );
  test.setTimeout(180_000);

  if (!oldApplicationEntry || !newApplicationEntry) {
    return;
  }

  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'lexianchor-upgrade-'));
  let runningApp: ElectronApplication | undefined;

  try {
    let launched = await launchPackagedApp(oldApplicationEntry, userDataDirectory);
    runningApp = launched.app;
    let page = launched.page;

    await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
    await page
      .locator('.import-button input[type="file"]')
      .setInputFiles(path.resolve('packages/test-fixtures/generated/lexianchor-spike.epub'));
    await expect(page.locator('.reader-engine-label')).toContainText('EPUB.js');

    const appearancePanel = page.locator('details.reader-appearance-panel');
    if (!(await appearancePanel.evaluate((panel) => panel.open))) {
      await appearancePanel.locator('summary').click();
    }
    await page.getByRole('slider', { name: /Text size|文字大小|Taille du texte/ }).fill('125');
    await page
      .getByRole('button', {
        name: /Save as preset|保存为预设|Enregistrer comme préréglage/,
      })
      .click();
    await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();

    const samplePdfCard = page.locator('article').filter({ hasText: 'Anchored Pages' });
    await samplePdfCard.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
    await selectPdfWord(page, 'resilient');
    await page
      .getByRole('button', { name: /Add to word cards|添加到词卡|Ajouter aux fiches/ })
      .click();
    await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();

    await runningApp.close();
    runningApp = undefined;

    launched = await launchPackagedApp(newApplicationEntry, userDataDirectory);
    runningApp = launched.app;
    page = launched.page;

    await page.getByRole('button', { name: /Word cards|词卡|Fiches de mots/ }).click();
    await expect(
      page.locator('article[data-word-card-id]').filter({ hasText: 'resilient' }),
    ).toBeVisible();

    await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
    const restoredEpubCard = page
      .locator('article[data-book-id]')
      .filter({ hasText: 'lexianchor-spike' });
    await expect(restoredEpubCard).toBeVisible();
    await restoredEpubCard.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
    const restoredAppearancePanel = page.locator('details.reader-appearance-panel');
    if (!(await restoredAppearancePanel.evaluate((panel) => panel.open))) {
      await restoredAppearancePanel.locator('summary').click();
    }
    await expect(
      page.getByRole('combobox', { name: /Current preset|当前预设|Préréglage actuel/ }),
    ).not.toHaveValue('default');
    await expect(
      page.getByRole('slider', { name: /Text size|文字大小|Taille du texte/ }),
    ).toHaveValue('125');
  } finally {
    if (runningApp) {
      await terminateDesktop(runningApp).catch(() => undefined);
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
