import { resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

async function savedCfi(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith('lexianchor:epub-location:'),
    );
    return key
      ? ((JSON.parse(localStorage.getItem(key) ?? '{}') as { cfi?: string }).cfi ?? '')
      : '';
  });
}

test('reopens the newer SQLite checkpoint instead of an older localStorage copy', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('.import-button input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-spike.epub'));
  await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => savedCfi(page)).not.toBe('');
  const firstCheckpoint = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith('lexianchor:epub-location:'),
    );
    if (!key) throw new Error('No initial EPUB checkpoint.');
    return { key, value: localStorage.getItem(key)! };
  });
  for (let index = 0; index < 2; index += 1) {
    const before = await savedCfi(page);
    await page.getByRole('button', { name: /^Next$|^下一页$|^Suivant$/ }).click();
    await expect.poll(() => savedCfi(page)).not.toBe(before);
  }
  const latestCfi = await savedCfi(page);
  await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
  await expect(page.getByTestId('epub-container')).toHaveCount(0);
  // Reproduce Chromium losing its newest localStorage batch on SIGKILL,
  // after the SQLite transaction has already acknowledged the latest page.
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), firstCheckpoint);
  await page.reload();
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('article[data-book-id]')
    .first()
    .getByRole('button', { name: /Continue|继续|Continuer/ })
    .click();
  await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => savedCfi(page)).toBe(latestCfi);
  await page.waitForTimeout(700);
  expect(await savedCfi(page)).toBe(latestCfi);
});

test('freezes the committed EPUB checkpoint while delayed SQLite writes flush on close', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;
    const observed = window as unknown as {
      qaProgressWrites: { cfi: string; forwarded: boolean }[];
    };
    observed.qaProgressWrites = [];
    Worker.prototype.postMessage = function (
      message: unknown,
      transfer?: Transferable[] | StructuredSerializeOptions,
    ) {
      const forward = () =>
        Reflect.apply(original, this, transfer === undefined ? [message] : [message, transfer]);
      const request = message as {
        type?: string;
        progress?: { locator?: { cfi?: string } };
      } | null;
      if (request?.type === 'save-progress') {
        const entry = { cfi: request.progress?.locator?.cfi ?? '', forwarded: false };
        observed.qaProgressWrites.push(entry);
        setTimeout(() => {
          entry.forwarded = true;
          forward();
        }, 150);
      } else {
        forward();
      }
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('.import-button input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-spike.epub'));
  await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => savedCfi(page)).not.toBe('');
  const next = page.getByRole('button', { name: /^Next$|^下一页$|^Suivant$/ });
  for (let index = 0; index < 2; index += 1) {
    const before = await savedCfi(page);
    await next.click();
    await expect.poll(() => savedCfi(page)).not.toBe(before);
  }
  const finalCfi = await savedCfi(page);

  // Begin a preview and close within the same browser task, before idle can
  // submit it. The queue may still be waiting on earlier storage requests.
  await page.evaluate(() => {
    const container = document.querySelector('[data-testid="epub-container"] > .epub-container');
    const viewport = container?.getBoundingClientRect();
    const frame = [...(container?.querySelectorAll('iframe') ?? [])].find((candidate) => {
      const bounds = candidate.getBoundingClientRect();
      return viewport && bounds.right > viewport.left && bounds.left < viewport.right;
    });
    if (!frame?.contentDocument?.body) throw new Error('No visible EPUB frame.');
    frame.contentDocument.body.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 60, deltaY: 0 }),
    );
    const close = document.querySelector<HTMLButtonElement>('.reader-toolbar-leading button');
    if (!close) throw new Error('No reader close button.');
    close.click();
  });
  await expect(page.getByTestId('epub-container')).toHaveCount(0);
  expect(await savedCfi(page)).toBe(finalCfi);
  const finalWrite = await page.evaluate(() => {
    const observed = window as unknown as {
      qaProgressWrites: { cfi: string; forwarded: boolean }[];
    };
    return observed.qaProgressWrites.at(-1);
  });
  expect(finalWrite).toEqual({ cfi: finalCfi, forwarded: true });
  const book = page.locator('article[data-book-id]').first();
  await book.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
  await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => savedCfi(page)).toBe(finalCfi);
  await page.waitForTimeout(700);
  expect(await savedCfi(page)).toBe(finalCfi);
});
