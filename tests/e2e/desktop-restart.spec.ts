import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

const electronExecutable = createRequire(import.meta.url)('electron') as string;

async function launchDesktop(
  mainEntry: string,
  userDataDirectory: string,
): Promise<{ app: ElectronApplication; page: Page }> {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: [mainEntry, `--user-data-dir=${userDataDirectory}`],
    env: environment,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30_000);
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

async function storedCfi(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith('lexianchor:epub-location:'),
    );
    return key
      ? ((JSON.parse(localStorage.getItem(key) ?? '{}') as { cfi?: string }).cfi ?? '')
      : '';
  });
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

test('restores the last Level Up page after restarting the desktop process', async () => {
  const mainEntry = process.env.LEXIANCHOR_DESKTOP_MAIN;
  const levelUpPath = process.env.LEXIANCHOR_LEVEL_UP_EPUB;
  test.skip(
    !mainEntry || !levelUpPath,
    'Set LEXIANCHOR_DESKTOP_MAIN and LEXIANCHOR_LEVEL_UP_EPUB for the desktop restart test.',
  );
  test.setTimeout(180_000);

  if (!mainEntry || !levelUpPath) {
    return;
  }

  const userDataDirectory = await mkdtemp(path.join(tmpdir(), 'lexianchor-restart-'));
  let runningApp: ElectronApplication | undefined;

  try {
    let launched = await launchDesktop(mainEntry, userDataDirectory);
    runningApp = launched.app;
    let page = launched.page;

    await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
    await page.locator('.import-button input[type="file"]').setInputFiles(levelUpPath);
    await expect(page.locator('.reader-engine-label')).toContainText('EPUB.js', {
      timeout: 60_000,
    });
    await page
      .getByRole('button', {
        name: /Open table of contents|打开目录|Ouvrir le sommaire/,
      })
      .click();
    await page
      .getByRole('navigation', { name: /Contents|目录|Sommaire/ })
      .getByRole('button', { name: /^Level 8:/ })
      .click();

    const appearancePanel = page.locator('details.reader-appearance-panel');
    if (!(await appearancePanel.evaluate((panel) => panel.open))) {
      await appearancePanel.locator('summary').click();
    }
    await page.getByRole('slider', { name: /Text size|文字大小|Taille du texte/ }).fill('115');

    const nextPage = page.getByRole('button', { name: /^Next$|^下一页$|^Suivant$/ });
    let previousCfi = await storedCfi(page);
    for (let index = 0; index < 4; index += 1) {
      await nextPage.click();
      await expect.poll(() => storedCfi(page)).not.toBe(previousCfi);
      previousCfi = await storedCfi(page);
    }
    const cfiBeforeRestart = previousCfi;
    expect(cfiBeforeRestart).toContain('/6/30!');

    await runningApp.close();
    runningApp = undefined;

    launched = await launchDesktop(mainEntry, userDataDirectory);
    runningApp = launched.app;
    page = launched.page;
    await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
    const savedBook = page.locator('article[data-book-id]').first();
    await expect(savedBook).toBeVisible({ timeout: 30_000 });
    await savedBook.getByRole('button', { name: /Continue|继续|Continuer/ }).click();

    await expect.poll(() => storedCfi(page), { timeout: 30_000 }).toBe(cfiBeforeRestart);
  } finally {
    if (runningApp) {
      await terminateDesktop(runningApp).catch(() => undefined);
    }
    await rm(userDataDirectory, { recursive: true, force: true });
  }
});
