import { expect, test } from '@playwright/test';

test('keeps consecutive pages in Level Up instead of returning to the opening page', async ({
  page,
}) => {
  const levelUpPath = process.env.LEXIANCHOR_LEVEL_UP_EPUB;
  test.skip(!levelUpPath, 'Set LEXIANCHOR_LEVEL_UP_EPUB to the local Level Up EPUB.');
  test.setTimeout(120_000);

  if (!levelUpPath) {
    return;
  }

  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page.locator('.import-button input[type="file"]').setInputFiles(levelUpPath);
  await expect(page.locator('.reader-engine-label')).toContainText('EPUB.js', {
    timeout: 60_000,
  });

  const settledPages: Array<{ position: number; extent: number }> = [];
  for (let index = 0; index < 5; index += 1) {
    const body = page.locator('.epub-container iframe').last().contentFrame().locator('body');
    await body.dispatchEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: 0,
      deltaX: 520,
      deltaY: 2,
    });
    await page.waitForTimeout(700);
    const settledPage = await page.evaluate(() => {
      const scroller = document
        .querySelector('[data-testid="epub-container"]')
        ?.querySelector<HTMLElement>('.epub-container');
      return {
        position: scroller?.scrollLeft ?? 0,
        extent: scroller?.clientWidth ?? 0,
      };
    });
    settledPages.push(settledPage);
  }

  for (let index = 0; index < settledPages.length; index += 1) {
    const page = settledPages[index];
    expect(page?.extent).toBeGreaterThan(500);
    expect(Math.abs((page?.position ?? 0) - (index + 1) * (page?.extent ?? 0))).toBeLessThan(6);
  }
});
