import { expect, test, type Page } from '@playwright/test';

async function visibleHeadingText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const scroller = document
      .querySelector('[data-testid="epub-container"]')
      ?.querySelector<HTMLElement>('.epub-container');
    if (!scroller) {
      return '';
    }

    const viewport = scroller.getBoundingClientRect();
    for (const frame of Array.from(scroller.querySelectorAll('iframe'))) {
      const frameBox = frame.getBoundingClientRect();
      for (const heading of Array.from(
        frame.contentDocument?.querySelectorAll<HTMLElement>('h1, h2, h3, h4') ?? [],
      )) {
        const box = heading.getBoundingClientRect();
        const left = frameBox.left + box.left;
        const right = frameBox.left + box.right;
        if (right > viewport.left && left < viewport.right) {
          return heading.textContent?.replace(/\s+/g, ' ').trim() ?? '';
        }
      }
    }

    return '';
  });
}

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
  await page.locator('details.reader-appearance-panel summary').click();
  await page
    .getByRole('combobox', {
      name: /Page turn effect|翻页效果|Effet de changement de page/,
    })
    .selectOption('stack');

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
  const storedLocator = () =>
    page.evaluate(() => {
      const key = Object.keys(localStorage).find((candidate) =>
        candidate.startsWith('lexianchor:epub-location:'),
      );
      return key
        ? (JSON.parse(localStorage.getItem(key) ?? '{}') as {
            href?: string;
            cfi?: string;
            navigationHref?: string;
            layoutSignature?: string;
            totalProgression?: number;
          })
        : {};
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
  await contents.getByRole('button', { name: 'Finally, We Talk About Gameplay' }).click();
  await expect.poll(() => visibleHeadingText(page)).toContain('Finally, We Talk About Gameplay');
  await page.waitForTimeout(1_500);
  await expect.poll(() => visibleHeadingText(page)).toContain('Finally, We Talk About Gameplay');
  await openContents();
  await contents.getByRole('button', { name: 'Who Do You Want to Be Today?' }).click();
  await expect.poll(() => visibleHeadingText(page)).toContain('Who Do You Want to Be Today?');
  await page.waitForTimeout(1_500);
  await expect.poll(() => visibleHeadingText(page)).toContain('Who Do You Want to Be Today?');

  await openContents();
  await contents.getByRole('button', { name: /^Level 7:/ }).click();
  await expect.poll(currentHref).toContain('c07.xhtml');
  await page.waitForTimeout(1_500);
  await expect.poll(currentHref).toContain('c07.xhtml');

  await openContents();
  await contents.getByRole('button', { name: 'Dance, Monkey, Dance' }).click();
  await expect.poll(() => visibleHeadingText(page)).toContain('Dance, Monkey, Dance');
  await expect
    .poll(async () => (await storedLocator()).navigationHref)
    .toContain('c07.xhtml#head-2-87');
  await page.waitForTimeout(1_500);
  await expect.poll(() => visibleHeadingText(page)).toContain('Dance, Monkey, Dance');
  const childLocator = await storedLocator();
  expect(childLocator.href).toContain('c07.xhtml#head-2-87');
  expect(childLocator.cfi).toBeUndefined();
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  const savedBookAfterChildJump = page.locator('article[data-book-id]').first();
  await expect(savedBookAfterChildJump).toBeVisible();
  await savedBookAfterChildJump.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
  await expect
    .poll(() => visibleHeadingText(page), { timeout: 30_000 })
    .toContain('Dance, Monkey, Dance');
  await expect
    .poll(async () => (await storedLocator()).navigationHref)
    .toContain('c07.xhtml#head-2-87');

  await openContents();
  await contents.getByRole('button', { name: /^Level 7:/ }).click();
  await expect.poll(currentHref).toContain('c07.xhtml');

  await openContents();
  const currentChapter = contents.getByRole('button', { name: /^Level 7:/ });
  await expect(currentChapter).toHaveAttribute('aria-current', 'location');
  await expect
    .poll(async () => {
      const [navigationBox, chapterBox] = await Promise.all([
        contents.boundingBox(),
        currentChapter.boundingBox(),
      ]);
      return navigationBox && chapterBox
        ? chapterBox.y - navigationBox.y
        : Number.POSITIVE_INFINITY;
    })
    .toBeLessThan(24);
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
    expect(settledPage?.href).toContain('c07.xhtml');
    if (index > 0) {
      expect(settledPage?.position ?? 0).toBeGreaterThan(settledPages[index - 1]?.position ?? 0);
      expect(settledPage?.progression ?? 0).toBeGreaterThanOrEqual(
        (settledPages[index - 1]?.progression ?? 0) - 0.000_5,
      );
    }
  }

  const exactPage = await storedLocator();
  expect(exactPage.cfi).toContain('/6/28!');
  expect(exactPage.navigationHref).toContain('c07.xhtml');
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  const savedBook = page.locator('article[data-book-id]').first();
  await expect(savedBook).toBeVisible();
  await savedBook.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
  await expect.poll(currentHref, { timeout: 30_000 }).toContain('c07.xhtml');
  await expect.poll(async () => (await storedLocator()).cfi).toBe(exactPage.cfi);

  const appearancePanel = page.locator('details.reader-appearance-panel');
  if (!(await appearancePanel.evaluate((panel) => panel.open))) {
    await appearancePanel.locator('summary').click();
  }
  await page.getByRole('slider', { name: /Text size|文字大小|Taille du texte/ }).fill('115');
  await expect.poll(currentHref, { timeout: 30_000 }).toContain('c07.xhtml');
  await expect.poll(async () => (await storedLocator()).cfi).toContain('/6/28!');

  // Reproduce a real desktop restart: jump to Level 8, turn several pages
  // after a typography reflow, then reload without using the Library button
  // (and therefore without awaiting the async SQLite write queue).
  await openContents();
  await contents.getByRole('button', { name: /^Level 8:/ }).click();
  await expect.poll(currentHref).toContain('c08.xhtml');
  const levelEightStart = await storedLocator();
  expect(levelEightStart.href).toContain('c08.xhtml');

  const nextPage = page.getByRole('button', { name: /^Next$|^下一页$|^Suivant$/ });
  const pageCheckpoints: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await nextPage.click();
    await expect
      .poll(async () => (await storedLocator()).cfi)
      .not.toBe(pageCheckpoints.at(-1) ?? levelEightStart.cfi);
    pageCheckpoints.push((await storedLocator()).cfi ?? '');
  }

  const finalPageBeforeRestart = await storedLocator();
  expect(finalPageBeforeRestart.cfi).not.toBe(levelEightStart.cfi);

  await page.reload();
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const savedBookAfterRestart = page.locator('article[data-book-id]').first();
  await expect(savedBookAfterRestart).toBeVisible();
  await savedBookAfterRestart.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
  await expect.poll(currentHref, { timeout: 30_000 }).toContain('c08.xhtml');
  await expect.poll(async () => (await storedLocator()).cfi).toBe(finalPageBeforeRestart.cfi);
  await expect
    .poll(async () =>
      Math.abs(
        ((await storedLocator()).totalProgression ?? 0) -
          (finalPageBeforeRestart.totalProgression ?? 0),
      ),
    )
    .toBeLessThan(0.001);
});
