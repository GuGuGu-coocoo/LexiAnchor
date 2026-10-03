import { expect, test, type Page } from '@playwright/test';

type Spread = 'single' | 'double';

async function checkpoint(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) =>
      value.startsWith('lexianchor:epub-location:'),
    );
    return key
      ? (JSON.parse(localStorage.getItem(key) ?? '{}') as { cfi?: string; href?: string })
      : {};
  });
}

async function geometry(page: Page, spread: Spread) {
  return page.evaluate((columns) => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    if (!scroller) throw new Error('Missing real EPUB scroller');
    const viewport = scroller.getBoundingClientRect();
    const logicalPitch = scroller.clientWidth / (columns === 'double' ? 2 : 1);
    const frames = Array.from(scroller.querySelectorAll('iframe'));
    const samples: { href: string; pitch: number | null; origins: number[]; css: string }[] = [];
    const clipped: { text: string; left: number; right: number }[] = [];
    let visibleLines = 0;
    for (const frame of frames) {
      const box = frame.getBoundingClientRect();
      if (box.right <= viewport.left + 1 || box.left >= viewport.right - 1) continue;
      const doc = frame.contentDocument;
      if (!doc?.body || !frame.contentWindow) continue;
      const origins: number[] = [];
      for (const element of Array.from(doc.querySelectorAll('h1,h2,p'))) {
        const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let first = true;
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const text = node.textContent ?? '';
          const offset = text.search(/\S/);
          if (offset < 0) continue;
          if (first) {
            const point = doc.createRange();
            point.setStart(node, offset);
            point.setEnd(node, offset + ((text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1));
            const rect = point.getClientRects()[0];
            if (rect?.width && rect.height) origins.push(rect.left);
            first = false;
          }
          // Text-node fragments are actual painted lines, not a paragraph's
          // union box spanning several columns. A settled page must not cut one.
          const range = doc.createRange();
          range.selectNodeContents(node);
          for (const rect of Array.from(range.getClientRects())) {
            if (rect.width <= 1 || rect.height <= 1) continue;
            const left = box.left + rect.left;
            const right = box.left + rect.right;
            const top = box.top + rect.top;
            const bottom = box.top + rect.bottom;
            if (bottom <= viewport.top || top >= viewport.bottom) continue;
            if (right <= viewport.left + 1 || left >= viewport.right - 1) continue;
            visibleLines += 1;
            if (left < viewport.left - 1 || right > viewport.right + 1) {
              clipped.push({
                text: text.replace(/\s+/g, ' ').trim().slice(0, 65),
                left: left - viewport.left,
                right: right - viewport.left,
              });
            }
          }
        }
      }
      const sorted = origins.sort((a, b) => a - b);
      const distinct = sorted.filter((left, index) => index === 0 || left - sorted[index - 1]! > 4);
      const deltas = distinct
        .slice(1)
        .map((left, index) => left - distinct[index]!)
        .filter((delta) => delta > logicalPitch * 0.4);
      const style = frame.contentWindow.getComputedStyle(doc.body);
      samples.push({
        href: doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
        pitch: deltas.length ? Math.min(...deltas) : null,
        origins: distinct,
        css: `width=${style.width}, column=${style.columnWidth}, gap=${style.columnGap}, padding=${style.padding}`,
      });
    }
    return {
      width: scroller.clientWidth,
      height: scroller.clientHeight,
      scrollLeft: scroller.scrollLeft,
      logicalPitch,
      samples,
      visibleLines,
      clipped: clipped.slice(0, 12),
    };
  }, spread);
}

async function settled(page: Page) {
  await expect.poll(async () => (await checkpoint(page)).cfi ?? '').toMatch(/^epubcfi\(/);
  // Observe stable native geometry rather than assuming a theme/resize delay.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const scroller = document.querySelector<HTMLElement>(
          '[data-testid="epub-container"] > .epub-container',
        );
        if (!scroller) return false;
        const value = () =>
          `${scroller.clientWidth}:${scroller.clientHeight}:${scroller.scrollLeft}:${scroller.scrollWidth}`;
        const before = value();
        for (let index = 0; index < 4; index += 1)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return before === value();
      }),
    )
    .toBe(true);
}

async function assertGeometry(page: Page, spread: Spread, label: string) {
  await settled(page);
  const measured = await geometry(page, spread);
  const diagnostic = `${label}: ${JSON.stringify(measured)}`;
  expect(measured.visibleLines, diagnostic).toBeGreaterThan(0);
  const pitches = measured.samples.flatMap((sample) =>
    sample.pitch === null ? [] : [sample.pitch],
  );
  expect(pitches.length, diagnostic).toBeGreaterThan(0);
  for (const pitch of pitches)
    expect(Math.abs(pitch - measured.logicalPitch), diagnostic).toBeLessThan(1.1);
  for (const sample of measured.samples) {
    const first = sample.origins[0];
    if (first === undefined) continue;
    // Check every sampled column against the logical grid, including distant
    // columns. A small per-column error must not accumulate farther along.
    for (const origin of sample.origins) {
      const distance = origin - first;
      const columns = Math.round(distance / measured.logicalPitch);
      expect(Math.abs(distance - columns * measured.logicalPitch), diagnostic).toBeLessThan(1.1);
    }
  }
  expect(measured.clipped, diagnostic).toEqual([]);
  return measured;
}

async function pageOffset(page: Page) {
  return page
    .getByTestId('epub-container')
    .locator(':scope > .epub-container')
    .evaluate((element) => ({ width: element.clientWidth, left: element.scrollLeft }));
}

async function assertOneScreen(
  page: Page,
  before: Awaited<ReturnType<typeof checkpoint>>,
  offset: Awaited<ReturnType<typeof pageOffset>>,
  direction: -1 | 1,
) {
  await settled(page);
  const after = await checkpoint(page);
  if (after.href !== before.href) return; // Cross-spine strips can be rebased.
  const actual = await pageOffset(page);
  expect(Math.abs(actual.left - offset.left - direction * offset.width)).toBeLessThan(1.1);
}

async function turn(page: Page, direction: 'next' | 'previous') {
  const before = await checkpoint(page);
  const offset = await pageOffset(page);
  await page
    .getByRole('button', {
      name: direction === 'next' ? /^(Next|下一页|Suivant)$/ : /^(Previous|上一页|Précédent)$/,
    })
    .click();
  await expect.poll(async () => (await checkpoint(page)).cfi).not.toBe(before.cfi);
  await assertOneScreen(page, before, offset, direction === 'next' ? 1 : -1);
}

async function horizontalSwipe(page: Page, direction: -1 | 1) {
  const before = await checkpoint(page);
  const offset = await pageOffset(page);
  for (let index = 0; index < 10; index += 1) {
    await page.evaluate(
      (delta) => {
        const scroller = document.querySelector<HTMLElement>(
          '[data-testid="epub-container"] > .epub-container',
        );
        if (!scroller) throw new Error('Missing real EPUB scroller');
        const viewport = scroller.getBoundingClientRect();
        const frame = Array.from(scroller.querySelectorAll('iframe')).find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.right > viewport.left + 1 && box.left < viewport.right - 1;
        });
        if (!frame?.contentDocument?.body) throw new Error('Missing visible EPUB document');
        frame.contentDocument.body.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX: delta,
            deltaY: 0,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      direction * offset.width * 0.055,
    );
    await page.waitForTimeout(16);
  }
  await expect.poll(async () => (await checkpoint(page)).cfi).not.toBe(before.cfi);
  await assertOneScreen(page, before, offset, direction);
}

test.use({ viewport: { width: 1728, height: 1117 } });

for (const spread of ['single', 'double'] as const) {
  for (const textWidth of [90, 70]) {
    test(`EPUB physical columns stay aligned through ten pages: ${spread}, ${textWidth}%`, async ({
      page,
      context,
    }, testInfo) => {
      test.setTimeout(90_000);
      await context.route('https://en.wiktionary.org/**', (route) =>
        route.abort('internetdisconnected'),
      );
      const evidence: { label: string; geometry: Awaited<ReturnType<typeof geometry>> }[] = [];
      const verify = async (label: string) => {
        evidence.push({ label, geometry: await assertGeometry(page, spread, label) });
      };
      try {
        await page.goto('/');
        await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
        await page
          .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre de test/ })
          .click();
        await expect(page.getByTestId('epub-container').locator('iframe').first()).toBeVisible();
        await page.locator('details.reader-appearance-panel > summary').click();
        await page
          .getByRole('combobox', { name: /Page turn effect|翻页效果|Effet de changement/ })
          .selectOption('slide');
        await page
          .getByRole('combobox', { name: /Page columns|页面栏数|Colonnes/ })
          .selectOption(spread);
        await page
          .getByRole('slider', { name: /Text width|正文宽度|Largeur du texte/ })
          .fill(String(textWidth));
        await page
          .getByRole('button', { name: /Hide reader sidebar|隐藏阅读侧栏|Masquer le panneau/ })
          .click();
        await verify('wide window before paging');

        // A shorter viewport gives this real sample enough independent screen
        // turns even in two columns; the final crop check uses the reported
        // 1728 × 1117 full-width geometry, not a synthetic DOM fixture.
        await page.setViewportSize({ width: 1728, height: 620 });
        await page
          .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
          .click();
        await page.getByRole('slider', { name: /Text size|文字大小|Taille du texte/ }).fill('180');
        await page
          .getByRole('button', { name: /Hide reader sidebar|隐藏阅读侧栏|Masquer le panneau/ })
          .click();
        await verify('short viewport start');
        for (let index = 1; index <= 10; index += 1) {
          await turn(page, 'next');
          await verify(`next ${index}`);
        }
        for (let index = 1; index <= 2; index += 1) {
          await turn(page, 'previous');
          await verify(`previous ${index}`);
        }
        await horizontalSwipe(page, -1);
        await verify('backward synthetic wheel');
        await horizontalSwipe(page, 1);
        await verify('forward synthetic wheel');

        const beforeResize = await checkpoint(page);
        await page.setViewportSize({ width: 1728, height: 1117 });
        await verify('wide window later page');
        await expect.poll(async () => (await checkpoint(page)).cfi).toBe(beforeResize.cfi);
        const beforeSidebar = await checkpoint(page);
        await page
          .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
          .click();
        await verify('sidebar shown later page');
        await expect.poll(async () => (await checkpoint(page)).cfi).toBe(beforeSidebar.cfi);
        await page
          .getByRole('button', { name: /Hide reader sidebar|隐藏阅读侧栏|Masquer le panneau/ })
          .click();
        await verify('sidebar hidden later page');
        await expect.poll(async () => (await checkpoint(page)).cfi).toBe(beforeSidebar.cfi);
      } finally {
        await testInfo.attach('actual-column-geometry', {
          body: JSON.stringify(evidence, null, 2),
          contentType: 'application/json',
        });
      }
    });
  }
}
