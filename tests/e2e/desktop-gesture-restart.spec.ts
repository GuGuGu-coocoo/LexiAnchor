import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';

import {
  createIsolatedProfile,
  launchSourceApp,
  removeIsolatedProfile,
  stopSourceApp,
} from '../../tools/reader-source-smoke.mjs';

// Opt-in: this is installed Electron + source JS, not a packaged-app test.
// Build once with reader-source-smoke.mjs build; no private books are needed.
const applicationEntry = process.env.LEXIANCHOR_SOURCE_APP;
const fixture = path.resolve('packages/test-fixtures/generated/lexianchor-spike.epub');
const fixtureCardId = 'source-restart-card';
const labels = {
  library: /Library|书库|Bibliothèque/,
  cards: /Word cards|词卡|Fiches de mots/,
  continue: /Continue|继续|Continuer/,
  contents: /Open table of contents|打开目录|Ouvrir le sommaire/,
  effect: /Page turn effect|翻页效果|Effet de changement de page/,
  fontSize: /Text size|文字大小|Taille du texte/,
  preset: /Current preset|当前预设|Préréglage actuel/,
};

interface Session {
  app: ElectronApplication;
  page: Page;
}

interface Checkpoint {
  cfi?: string;
  href: string;
}

async function checkpoint(page: Page): Promise<Checkpoint> {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith('lexianchor:epub-location:'),
    );
    if (keys.length !== 1) {
      throw new Error(`Expected one imported EPUB checkpoint, found ${keys.length}.`);
    }
    return JSON.parse(localStorage.getItem(keys[0]!) ?? '{}') as Checkpoint;
  });
}

async function stableCheckpoint(page: Page, requireExactCfi = false): Promise<Checkpoint> {
  let lastPosition = '';
  let stableSince = 0;
  await expect
    .poll(
      async () => {
        const value = await checkpoint(page).catch(() => ({ cfi: '', href: '' }));
        // A committed publisher TOC anchor deliberately has no CFI. Its
        // href#fragment is the stable reopening position until a page turn.
        const position = value.cfi
          ? JSON.stringify([value.href, value.cfi])
          : !requireExactCfi && value.href?.includes('#')
            ? value.href
            : '';
        if (!position || position !== lastPosition) {
          lastPosition = position;
          stableSince = Date.now();
          return false;
        }
        return Date.now() - stableSince >= 600;
      },
      { timeout: 30_000, intervals: [30, 50, 100] },
    )
    .toBe(true);
  return checkpoint(page);
}

async function appearance(page: Page) {
  const panel = page.locator('details.reader-appearance-panel');
  if (!(await panel.evaluate((element) => (element as HTMLDetailsElement).open))) {
    await panel.locator('summary').click();
  }
}

async function openImportedBook(page: Page) {
  await page.getByRole('button', { name: labels.library }).click();
  const card = page
    .locator('article[data-book-id]')
    .filter({ hasText: /lexianchor-spike|Anchored Reading/i });
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole('button', { name: labels.continue }).click();
  await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
}

async function seedWordCard(page: Page) {
  const timestamp = '2026-10-03T00:00:00.000Z';
  const backup = {
    format: 'lexianchor.word-cards',
    schemaVersion: 1,
    exportedAt: timestamp,
    cards: [
      {
        id: fixtureCardId,
        term: 'attentive',
        normalizedTerm: 'attentive',
        partOfSpeech: 'adjective',
        definition: 'Paying close attention.',
        definitions: ['Paying close attention.', 'Careful and observant.'],
        rootOrEtymology: null,
        dictionarySource: 'Repository-owned QA fixture',
        sourceBookId: null,
        sourceBookTitle: 'LexiAnchor Spike',
        sourceSentence: 'An attentive reader remembers the page.',
        occurrenceCount: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        deletedAt: null,
        version: 1,
      },
    ],
  };
  await page.getByRole('button', { name: labels.cards }).click();
  await page.locator('.card-transfer-actions input[type="file"]').setInputFiles({
    name: 'source-restart-card.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator(`[data-word-card-id="${fixtureCardId}"]`)).toBeVisible();
}

async function targetIntersectsViewport(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((targetSelector) => {
    const scroller = document.querySelector('[data-testid="epub-container"] > .epub-container');
    if (!scroller) {
      return false;
    }
    const viewport = scroller.getBoundingClientRect();
    return [...scroller.querySelectorAll('iframe')].some((frame) => {
      const element = frame.contentDocument?.querySelector(targetSelector);
      if (!element) {
        return false;
      }
      const frameBox = frame.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return frameBox.left + box.right > viewport.left && frameBox.left + box.left < viewport.right;
    });
  }, selector);
}

async function wheel(page: Page, deltaX: number) {
  await page.evaluate((delta) => {
    const scroller = document.querySelector('[data-testid="epub-container"] > .epub-container');
    const frames = [...(scroller?.querySelectorAll('iframe') ?? [])];
    const viewport = scroller?.getBoundingClientRect();
    const frame = frames.find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return viewport && box.right > viewport.left && box.left < viewport.right;
    });
    const body = frame?.contentDocument?.body;
    if (!body) {
      throw new Error('No visible EPUB body for the wheel gesture.');
    }
    body.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: 0,
        deltaX: delta,
        deltaY: 0,
      }),
    );
  }, deltaX);
}

async function committedTurn(page: Page): Promise<Checkpoint> {
  const before = await stableCheckpoint(page);
  for (let sample = 0; sample < 8; sample += 1) {
    await wheel(page, 35);
    await page.waitForTimeout(16);
  }
  const scroller = page.getByTestId('epub-container').locator(':scope > .epub-container');
  await expect(scroller).not.toHaveClass(/epub-page-stack-transition/, { timeout: 10_000 });
  // A removed transition class also occurs on cancellation; require a real commit.
  await expect
    .poll(async () => {
      const value = await checkpoint(page);
      return Boolean(value.cfi && value.cfi !== before.cfi);
    })
    .toBe(true);
  return stableCheckpoint(page, true);
}

async function keepGestureOpen(page: Page) {
  await page.evaluate(() => {
    const scroller = document.querySelector('[data-testid="epub-container"] > .epub-container');
    const viewport = scroller?.getBoundingClientRect();
    const frame = [...(scroller?.querySelectorAll('iframe') ?? [])].find((candidate) => {
      const box = candidate.getBoundingClientRect();
      return viewport && box.right > viewport.left && box.left < viewport.right;
    });
    const body = frame?.contentDocument?.body;
    if (!body) {
      throw new Error('No EPUB body for an unfinished gesture.');
    }
    const dispatch = () =>
      body.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: 0,
          deltaX: 3,
          deltaY: 0,
        }),
      );
    dispatch();
    // Keep input alive until this test's own process closes; never let idle commit.
    window.setInterval(dispatch, 16);
  });
}

async function assertSavedData(page: Page, presetId: string, effect: string) {
  await page.getByRole('button', { name: labels.cards }).click();
  const card = page.locator(`[data-word-card-id="${fixtureCardId}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText('attentive');
  await openImportedBook(page);
  await appearance(page);
  await expect(page.getByRole('combobox', { name: labels.preset })).toHaveValue(presetId);
  await expect(page.getByRole('slider', { name: labels.fontSize })).toHaveValue('110');
  await expect(page.getByRole('combobox', { name: labels.effect })).toHaveValue(effect);
}

for (const effect of ['stack', 'slide'] as const) {
  for (const stopMode of ['normal', 'kill'] as const) {
    test(`source Electron ${effect}: ${stopMode} restart retains committed page/data and cancels a half gesture`, async () => {
      const testInfo = test.info();
      test.skip(
        !applicationEntry,
        'Set LEXIANCHOR_SOURCE_APP to an isolated source-only build directory.',
      );
      test.setTimeout(180_000);
      if (!applicationEntry) {
        return;
      }
      const profile = await createIsolatedProfile();
      const trace: unknown[] = [];
      const observe = async (page: Page, stage: string) => {
        await page.exposeFunction('__readingQaTrace', (record: unknown) => {
          trace.push({ stage, receivedAt: Date.now(), record });
        });
        await page.evaluate(() => {
          const record = (value: unknown) => {
            void (
              window as Window & { __readingQaTrace: (record: unknown) => Promise<void> }
            ).__readingQaTrace(value);
          };
          const save = Storage.prototype.setItem;
          Storage.prototype.setItem = function (key, value) {
            save.call(this, key, value);
            if (key.startsWith('lexianchor:epub-location:')) {
              record({ kind: 'checkpoint', at: Date.now(), value: JSON.parse(value) });
            }
          };
          record({ kind: 'observe', at: Date.now() });
        });
      };
      let session: Session | undefined;
      try {
        session = await launchSourceApp(applicationEntry, profile);
        let page = session.page;
        await observe(page, 'first');
        await seedWordCard(page);
        await page.getByRole('button', { name: labels.library }).click();
        await page.locator('.import-button input[type="file"]').setInputFiles(fixture);
        await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
        await stableCheckpoint(page);
        await page.getByRole('button', { name: labels.contents }).click();
        await page
          .getByRole('navigation', { name: /Contents|目录|Sommaire/ })
          .getByRole('button', { name: /^The Bookmark(?:\s|$)/ })
          .click();
        await expect.poll(() => targetIntersectsViewport(page, '#page-turn-3 h2')).toBe(true);
        const tocCheckpoint = await stableCheckpoint(page);
        expect(tocCheckpoint.href).toContain('chapter-1.xhtml#page-turn-3');
        await appearance(page);
        await page.getByRole('combobox', { name: labels.effect }).selectOption(effect);
        await page.getByRole('slider', { name: labels.fontSize }).fill('110');
        await expect.poll(() => targetIntersectsViewport(page, '#page-turn-3 h2')).toBe(true);
        const afterReflow = await stableCheckpoint(page);
        expect(afterReflow.href).toContain('chapter-1.xhtml#page-turn-3');
        await page
          .getByRole('button', { name: /Save as preset|保存为预设|Enregistrer comme préréglage/ })
          .click();
        const presetId = await page.getByRole('combobox', { name: labels.preset }).inputValue();
        expect(presetId).not.toBe('default');
        await committedTurn(page);
        const lastCommitted = await committedTurn(page);
        trace.push({ kind: 'lastCommitted', at: Date.now(), value: lastCommitted });
        await stopSourceApp(session, stopMode);
        session = undefined;

        session = await launchSourceApp(applicationEntry, profile);
        page = session.page;
        await observe(page, 'preview');
        await assertSavedData(page, presetId, effect);
        await expect.poll(async () => (await checkpoint(page)).cfi).toBe(lastCommitted.cfi);
        expect((await stableCheckpoint(page, true)).cfi).toBe(lastCommitted.cfi);

        const beforePreview = await stableCheckpoint(page, true);
        trace.push({ kind: 'beforePreview', at: Date.now(), value: beforePreview });
        const scroller = page.getByTestId('epub-container').locator(':scope > .epub-container');
        const origin = await scroller.evaluate((element) => element.scrollLeft);
        await keepGestureOpen(page);
        if (effect === 'stack') {
          await expect(scroller).toHaveClass(/epub-page-stack-transition/);
        } else {
          await expect
            .poll(() => scroller.evaluate((element) => element.scrollLeft))
            .not.toBe(origin);
        }
        expect((await checkpoint(page)).cfi).toBe(beforePreview.cfi);
        trace.push({ kind: 'beforeKill', at: Date.now(), value: await checkpoint(page) });
        await stopSourceApp(session, stopMode);
        session = undefined;

        session = await launchSourceApp(applicationEntry, profile);
        page = session.page;
        await observe(page, 'reopen');
        await assertSavedData(page, presetId, effect);
        trace.push({ kind: 'reopened', at: Date.now(), value: await checkpoint(page) });
        await expect.poll(async () => (await checkpoint(page)).cfi).toBe(beforePreview.cfi);
        expect((await stableCheckpoint(page, true)).cfi).toBe(beforePreview.cfi);
      } finally {
        await testInfo.attach('reading-checkpoint-trace', {
          body: JSON.stringify(trace, null, 2),
          contentType: 'application/json',
        });
        if (session) {
          await stopSourceApp(session, 'kill').catch(() => undefined);
        }
        await removeIsolatedProfile(profile);
      }
    });
  }
}
