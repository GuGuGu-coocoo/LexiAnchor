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

  const currentHref = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) =>
        candidate.startsWith('lexianchor:epub-location:'),
      );
      return key
        ? ((JSON.parse(localStorage.getItem(key) ?? '{}') as { href?: string }).href ?? '')
        : '';
    });
  const currentProgression = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) =>
        candidate.startsWith('lexianchor:epub-location:'),
      );
      return key
        ? ((JSON.parse(localStorage.getItem(key) ?? '{}') as { totalProgression?: number })
            .totalProgression ?? 0)
        : 0;
    });
  const openContents = () =>
    page
      .getByRole('button', {
        name: /Open table of contents|打开目录|Ouvrir le sommaire/,
      })
      .click();

  await openContents();
  const contents = page.getByRole('navigation', { name: /Contents|目录|Sommaire/ });
  await contents.getByRole('button', { name: /^Level 5:/ }).click();
  await expect.poll(currentHref).toContain('c05.xhtml');

  await openContents();
  await contents.getByRole('button', { name: /^Level 7:/ }).click();
  await expect.poll(currentHref).toContain('c07.xhtml');
  await page.waitForTimeout(1_500);
  await expect.poll(currentHref).toContain('c07.xhtml');

  await openContents();
  await expect(contents.getByRole('button').first()).toContainText('Level 7:');
  await openContents();

  const progressionBeforeSidebarChange = await currentProgression();
  await page
    .getByRole('button', { name: /Hide reader sidebar|隐藏阅读侧栏|Masquer le panneau/ })
    .click();
  await expect.poll(currentHref).toContain('c07.xhtml');
  await expect
    .poll(async () => Math.abs((await currentProgression()) - progressionBeforeSidebarChange))
    .toBeLessThan(0.002);
  await page
    .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
    .click();
  await expect.poll(currentHref).toContain('c07.xhtml');
  await expect
    .poll(async () => Math.abs((await currentProgression()) - progressionBeforeSidebarChange))
    .toBeLessThan(0.002);

  const settledPages: Array<{
    position: number;
    extent: number;
    href: string;
    progression: number;
  }> = [];
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
      const key = Object.keys(localStorage).find((candidate) =>
        candidate.startsWith('lexianchor:epub-location:'),
      );
      const locator = key
        ? (JSON.parse(localStorage.getItem(key) ?? '{}') as {
            href?: string;
            totalProgression?: number;
          })
        : {};
      return {
        position: scroller?.scrollLeft ?? 0,
        extent: scroller?.clientWidth ?? 0,
        href: locator.href ?? '',
        progression: locator.totalProgression ?? 0,
      };
    });
    settledPages.push(settledPage);
  }

  for (let index = 0; index < settledPages.length; index += 1) {
    const settledPage = settledPages[index];
    expect(settledPage?.extent).toBeGreaterThan(500);
    expect(
      Math.abs(
        (settledPage?.position ?? 0) -
          Math.round((settledPage?.position ?? 0) / (settledPage?.extent ?? 1)) *
            (settledPage?.extent ?? 0),
      ),
    ).toBeLessThan(6);
    expect(settledPage?.href).toContain('c07.xhtml');
    if (index > 0) {
      expect(settledPage?.progression ?? 0).toBeGreaterThanOrEqual(
        (settledPages[index - 1]?.progression ?? 0) - 0.000_5,
      );
    }
  }
});
