import { expect, test, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';

interface Probe {
  writes: { cfi?: string; href?: string }[];
  snapshots: { old: string[]; next: string[] }[];
}

type ProbeWindow = Window & { __epubGestureProbe: Probe };
type HeldProbeWindow = ProbeWindow & { __epubGestureHold?: number };

// Chromium screenshot PNGs are 8-bit RGB/RGBA. Decode their lossless pixels
// with built-in zlib so the native ViewTransition is checked, not just DOM.
function pngPixels(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = png[25] === 6 ? 4 : png[25] === 2 ? 3 : 0;
  if (png[24] !== 8 || channels === 0 || png[28] !== 0)
    throw new Error('Unsupported screenshot PNG');
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    const filter = raw[row];
    for (let x = 0; x < stride; x += 1) {
      const index = y * stride + x;
      const left = x >= channels ? pixels[index - channels]! : 0;
      const above = y > 0 ? pixels[index - stride]! : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[index - stride - channels]! : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const a = Math.abs(p - left),
          b = Math.abs(p - above),
          c = Math.abs(p - upperLeft);
        predictor = a <= b && a <= c ? left : b <= c ? above : upperLeft;
      } else if (filter !== 0) throw new Error('Unsupported screenshot PNG filter');
      pixels[index] = (raw[row + x + 1]! + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function pixelFraction(
  png: Buffer,
  box: { x: number; y: number; width: number; height: number },
  colour: readonly number[],
) {
  const image = pngPixels(png);
  let matched = 0,
    total = 0;
  const left = Math.max(0, Math.ceil(box.x + 8));
  const right = Math.min(image.width, Math.floor(box.x + box.width - 8));
  const top = Math.max(0, Math.ceil(box.y + 8));
  const bottom = Math.min(image.height, Math.floor(box.y + box.height - 8));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * image.width + x) * image.channels;
      if (colour.every((value, channel) => Math.abs(image.pixels[index + channel]! - value) <= 5))
        matched += 1;
      total += 1;
    }
  }
  return matched / total;
}

test.beforeEach(async ({ page, context }) => {
  await context.route('https://en.wiktionary.org/**', (route) =>
    route.abort('internetdisconnected'),
  );
  await page.addInitScript(() => {
    const probe: Probe = { writes: [], snapshots: [] };
    (window as ProbeWindow).__epubGestureProbe = probe;
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (key.startsWith('lexianchor:epub-location:')) {
        probe.writes.push(JSON.parse(value) as { cfi?: string; href?: string });
      }
      save.call(this, key, value);
    };
    const visible = () => {
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="epub-container"] > .epub-container',
      );
      if (!scroller) return [];
      const viewport = scroller.getBoundingClientRect();
      const texts: string[] = [];
      for (const frame of Array.from(scroller.querySelectorAll('iframe'))) {
        const box = frame.getBoundingClientRect();
        for (const element of Array.from(
          frame.contentDocument?.querySelectorAll('h1,h2,p') ?? [],
        )) {
          const rect = element.getBoundingClientRect();
          if (
            box.left + rect.right > viewport.left + 2 &&
            box.left + rect.left < viewport.right - 2
          ) {
            const text = element.textContent?.replace(/\s+/g, ' ').trim();
            if (text) texts.push(text);
          }
        }
      }
      return texts;
    };
    if (document.startViewTransition) {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (update) => {
        const snapshot = { old: visible(), next: [] as string[] };
        probe.snapshots.push(snapshot);
        return start(async () => {
          if (typeof update === 'function') await update();
          else await update?.update?.();
          snapshot.next = visible();
        });
      };
    }
  });
});

async function checkpoint(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) =>
      value.startsWith('lexianchor:epub-location:'),
    );
    return key
      ? (JSON.parse(localStorage.getItem(key) ?? '{}') as {
          cfi?: string;
          href?: string;
          pageNumber?: number;
          pageCount?: number;
        })
      : {};
  });
}

async function openBook(page: Page, effect: 'slide' | 'stack' = 'stack', columns = 'single') {
  await page.goto('/');
  await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre de test/ })
    .click();
  await expect(page.getByTestId('epub-container').locator('iframe').first()).toBeVisible();
  const panel = page.locator('details.reader-appearance-panel');
  await panel.locator('summary').click();
  await page
    .getByRole('combobox', { name: /Page turn effect|翻页效果|Effet de changement/ })
    .selectOption(effect);
  await page
    .getByRole('combobox', { name: /Page columns|页面栏数|Colonnes/ })
    .selectOption(columns);
  await expect.poll(async () => (await checkpoint(page)).pageCount ?? 0).toBeGreaterThan(10);
  await page.waitForTimeout(200);
}

async function resetProbe(page: Page) {
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).__epubGestureProbe;
    probe.writes.length = 0;
    probe.snapshots.length = 0;
  });
}

async function sample(page: Page, deltaX: number) {
  await page.evaluate((delta) => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    if (!scroller) throw new Error('Missing real EPUB scroller');
    const viewport = scroller.getBoundingClientRect();
    const frames = Array.from(scroller.querySelectorAll('iframe'));
    const frame = frames.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.right > viewport.left && rect.left < viewport.right;
    });
    if (!frame?.contentDocument?.body) throw new Error('Missing visible real EPUB frame');
    frame.contentDocument.body.dispatchEvent(
      new WheelEvent('wheel', {
        deltaX: delta,
        deltaY: 0,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, deltaX);
}

async function swipe(page: Page, direction: -1 | 1) {
  const width = await page
    .getByTestId('epub-container')
    .locator(':scope > .epub-container')
    .evaluate((element) => element.clientWidth);
  for (let index = 0; index < 10; index += 1) {
    await sample(page, direction * width * 0.055);
    await page.waitForTimeout(16);
  }
}

async function waitSettled(page: Page) {
  await expect(page.locator('.epub-page-stack-transition')).toHaveCount(0);
  await page.waitForTimeout(200);
}

async function toc(page: Page, chapter: string) {
  await page
    .getByRole('button', { name: /Open table of contents|打开目录|Ouvrir le sommaire/ })
    .click();
  await page
    .getByRole('navigation', { name: /Contents|目录|Sommaire/ })
    .getByRole('button', { name: chapter })
    .click();
}

async function intersects(page: Page, selector: string) {
  return page.evaluate((target) => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    if (!scroller) return false;
    const viewport = scroller.getBoundingClientRect();
    return Array.from(scroller.querySelectorAll('iframe')).some((frame) => {
      const element = frame.contentDocument?.querySelector(target);
      if (!element) return false;
      const frameBox = frame.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return (
        frameBox.left + rect.right > viewport.left && frameBox.left + rect.left < viewport.right
      );
    });
  }, selector);
}

for (const effect of ['slide', 'stack'] as const) {
  test(`${effect}: preview cancellation writes no checkpoint; each committed turn advances one actual page`, async ({
    page,
  }) => {
    await openBook(page, effect);
    const before = await checkpoint(page);
    const initialFooter = Number(await page.locator('.reader-footer-page-current').textContent());
    await resetProbe(page);
    await sample(page, 20);
    await page.waitForTimeout(20);
    await sample(page, -20);
    await page.waitForTimeout(700);
    await waitSettled(page);
    expect((await checkpoint(page)).cfi).toBe(before.cfi);
    expect(await page.evaluate(() => (window as ProbeWindow).__epubGestureProbe.writes)).toEqual(
      [],
    );

    await resetProbe(page);
    await swipe(page, 1);
    await expect
      .poll(async () => (await checkpoint(page)).pageNumber)
      .toBe((before.pageNumber ?? 1) + 1);
    await waitSettled(page);
    expect(Number(await page.locator('.reader-footer-page-current').textContent())).toBe(
      initialFooter + 1,
    );
    expect((await checkpoint(page)).pageCount).toBe(before.pageCount);
    const forward = await page.evaluate(() => (window as ProbeWindow).__epubGestureProbe);
    expect(new Set(forward.writes.map((value) => value.cfi)).size).toBe(1);
    if (effect === 'stack') {
      expect(forward.snapshots).toHaveLength(1);
      expect(forward.snapshots[0]?.next).not.toEqual(forward.snapshots[0]?.old);
      expect(forward.snapshots[0]?.next.length).toBeGreaterThan(0);
    }
    const afterForward = await checkpoint(page);
    await resetProbe(page);
    await swipe(page, -1);
    await expect.poll(async () => (await checkpoint(page)).pageNumber).toBe(before.pageNumber);
    await waitSettled(page);
    expect((await checkpoint(page)).cfi).toBe(before.cfi);
    const backward = await page.evaluate(() => (window as ProbeWindow).__epubGestureProbe);
    expect(new Set(backward.writes.map((value) => value.cfi)).size).toBe(1);
    expect(afterForward.cfi).not.toBe(before.cfi);
    if (effect === 'stack') {
      expect(backward.snapshots[0]?.next).toEqual(forward.snapshots[0]?.old);
    }
  });
}

test('stack prepares previous chapter at its start and preserves child TOC/Back/reflow content', async ({
  page,
}) => {
  await openBook(page);
  await toc(page, 'Finding an Anchor');
  await expect.poll(async () => (await checkpoint(page)).href).toContain('chapter-2.xhtml');
  await waitSettled(page);
  await swipe(page, -1);
  await expect.poll(async () => (await checkpoint(page)).href).toContain('chapter-1.xhtml');
  await waitSettled(page);
  const backward = await page.evaluate(() =>
    (window as ProbeWindow).__epubGestureProbe.snapshots.at(-1),
  );
  const previous = await checkpoint(page);
  expect(previous.pageNumber).toBe(previous.pageCount);
  expect(backward?.next.join(' ')).toContain('The book closed for the evening');
  await swipe(page, 1);
  await expect.poll(async () => (await checkpoint(page)).href).toContain('chapter-2.xhtml');

  await toc(page, 'The Bookmark');
  await expect.poll(async () => (await checkpoint(page)).href).toBe('chapter-1.xhtml#page-turn-3');
  await expect.poll(() => intersects(page, '#page-turn-3 > h2')).toBe(true);
  const child = await checkpoint(page);
  await page.waitForTimeout(500);
  expect((await checkpoint(page)).cfi).toBe(child.cfi);
  await page.evaluate(() => {
    for (const frame of Array.from(
      document.querySelectorAll<HTMLIFrameElement>('.epub-container iframe'),
    )) {
      const link = frame.contentDocument?.querySelector<HTMLElement>('#cross-chapter-link');
      if (link) {
        link.click();
        return;
      }
    }
    throw new Error('Missing exact child link');
  });
  await expect.poll(async () => (await checkpoint(page)).href).toContain('chapter-2.xhtml');
  await page.locator('.reader-footer-leading button').click();
  await expect.poll(async () => (await checkpoint(page)).href).toContain('chapter-1.xhtml');
  await expect.poll(async () => (await checkpoint(page)).cfi).toMatch(/^epubcfi\(/);
  await expect.poll(() => intersects(page, '#cross-chapter-link')).toBe(true);
  await page
    .getByRole('button', { name: /Hide reader sidebar|隐藏阅读侧栏|Masquer le panneau/ })
    .click();
  await expect.poll(() => intersects(page, '#cross-chapter-link')).toBe(true);
  await page
    .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
    .click();
  await expect.poll(() => intersects(page, '#cross-chapter-link')).toBe(true);
  await page.getByRole('slider', { name: /Text size|字体大小|Taille du texte/ }).fill('130');
  await expect.poll(() => intersects(page, '#cross-chapter-link')).toBe(true);
});

test('two-column turns count a screen once and keep the publisher child after layout switch', async ({
  page,
}) => {
  await openBook(page, 'stack', 'double');
  const before = await checkpoint(page);
  const footer = Number(await page.locator('.reader-footer-page-current').textContent());
  await swipe(page, 1);
  await expect
    .poll(() => page.locator('.reader-footer-page-current').textContent())
    .toBe(String(footer + 1));
  await waitSettled(page);
  expect((await checkpoint(page)).pageCount).toBe(before.pageCount);
  await toc(page, 'The Bookmark');
  await expect.poll(async () => (await checkpoint(page)).href).toBe('chapter-1.xhtml#page-turn-3');
  await expect.poll(() => intersects(page, '#page-turn-3 > h2')).toBe(true);
  await page
    .getByRole('combobox', { name: /Page columns|页面栏数|Colonnes/ })
    .selectOption('single');
  await expect.poll(() => intersects(page, '#page-turn-3 > h2')).toBe(true);
  await expect.poll(async () => (await checkpoint(page)).pageCount ?? 0).toBeGreaterThan(10);
});

test('a slide immediately after typography changes is not reset by a stale display', async ({
  page,
}) => {
  await openBook(page, 'slide');
  await page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }).check();
  await page.getByRole('combobox', { name: /^(Font|字体|Police)$/ }).selectOption('sans-serif');
  await page.getByRole('slider', { name: /Text weight|正文字重|Graisse du texte/ }).fill('550');
  await page
    .getByRole('slider', { name: /Letter spacing|字间距|Espacement des lettres/ })
    .fill('0.08');
  await page.getByRole('slider', { name: /Text width|正文宽度|Largeur du texte/ }).fill('70');
  await page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }).uncheck();
  const body = page.getByTestId('epub-container').frameLocator('iframe').first().locator('body');
  await body.click({ position: { x: 24, y: 24 } });
  const motion = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    const frameBody = scroller?.querySelector('iframe')?.contentDocument?.body;
    if (!scroller || !frameBody) throw new Error('Missing immediate-reflow reading surface');
    const before = scroller.scrollLeft;
    frameBody.dispatchEvent(
      new WheelEvent('wheel', { deltaX: 120, deltaY: 2, bubbles: true, cancelable: true }),
    );
    const frames = [];
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      frames.push(scroller.scrollLeft - before);
    }
    return frames;
  });
  expect(motion[0]).toBeGreaterThan(100);
  expect(motion.every((offset) => offset > 100)).toBe(true);
});

for (const columns of ['single', 'double'] as const) {
  test(`${columns}: narrow text margins remain column-relative on resize and preserve selection`, async ({
    page,
  }) => {
    await openBook(page, 'stack', columns);
    const marginError = (percent: number) =>
      page.evaluate(
        ({ widthPercent, divisor }) => {
          const container = document.querySelector<HTMLElement>(
            '[data-testid="epub-container"] > .epub-container',
          );
          const body = container?.querySelector('iframe')?.contentDocument?.body;
          if (!container || !body) return Number.POSITIVE_INFINITY;
          const expected = ((container.clientWidth / divisor) * (100 - widthPercent)) / 200;
          return Math.abs(parseFloat(getComputedStyle(body).paddingLeft) - expected);
        },
        { widthPercent: percent, divisor: columns === 'double' ? 2 : 1 },
      );
    await expect.poll(() => marginError(90)).toBeLessThan(0.1);
    await page.getByRole('slider', { name: /Text width|正文宽度|Largeur du texte/ }).fill('70');
    await expect.poll(() => marginError(70)).toBeLessThan(0.1);
    await page.setViewportSize({ width: 1440, height: 720 });
    await expect.poll(() => marginError(70)).toBeLessThan(0.1);
    await expect.poll(() => intersects(page, 'h1')).toBe(true);
    const frame = page.getByTestId('epub-container').frameLocator('iframe').first();
    await frame.locator('em').evaluate((element) => {
      const selection = element.ownerDocument.defaultView?.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await expect(page.getByRole('complementary').locator('.selection-word')).toHaveText(
      'attentive',
    );
  });
}

test('native stack reversal retains the origin sheet and reveals the correct neighbour pixels', async ({
  page,
}) => {
  await openBook(page);
  await toc(page, 'A Clear Path');
  await expect.poll(async () => (await checkpoint(page)).href).toBe('chapter-1.xhtml#page-turn-2');
  await expect.poll(() => intersects(page, '#page-turn-2 > h2')).toBe(true);
  await waitSettled(page);
  const before = await checkpoint(page);
  const extent = await page
    .getByTestId('epub-container')
    .locator(':scope > .epub-container')
    .evaluate((element) => element.clientWidth);
  const scroller = page.getByTestId('epub-container').locator(':scope > .epub-container');
  const box = await scroller.boundingBox();
  if (!box) throw new Error('Missing reading viewport');
  const colours = { origin: [216, 42, 64], next: [32, 190, 80], previous: [48, 88, 220] };
  await page.evaluate(
    ({ width, palette }) => {
      const container = document.querySelector<HTMLElement>(
        '[data-testid="epub-container"] > .epub-container',
      );
      const frame = container?.querySelector('iframe');
      if (!container || !frame?.contentDocument?.body)
        throw new Error('Missing native page marker surface');
      const column = Math.round(container.scrollLeft / width);
      for (const [offset, colour] of [
        [-1, palette.previous],
        [0, palette.origin],
        [1, palette.next],
      ] as const) {
        const marker = frame.contentDocument.createElement('div');
        marker.dataset.epubPixelMarker = String(offset);
        marker.style.cssText = `position:absolute;left:${(column + offset) * width}px;top:0;width:${width}px;height:${container.clientHeight}px;background:rgb(${colour.join(',')});z-index:2147483600;pointer-events:none`;
        frame.contentDocument.body.append(marker);
      }
      (window as HeldProbeWindow).__epubGestureHold = window.setInterval(() => {
        // Keep input ownership while screenshot/ready polling takes a roundtrip;
        // symmetric sub-pixel pulses neither advance nor settle the page.
        for (const deltaX of [0.1, -0.1]) {
          frame.contentDocument?.body.dispatchEvent(
            new WheelEvent('wheel', {
              deltaX,
              deltaY: 0,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
      }, 20);
    },
    { width: extent, palette: colours },
  );
  await resetProbe(page);
  await sample(page, extent * 0.4);
  const waitHalf = () =>
    expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement
            .getAnimations({ subtree: true })
            .some(
              (animation) =>
                animation.playState === 'paused' &&
                Math.abs(Number(animation.currentTime) - 400) < 2,
            ),
        ),
      )
      .toBe(true);
  await waitHalf();
  const forward = await page.screenshot({
    path: test.info().outputPath('stack-forward-half.png'),
    animations: 'allow',
  });
  await sample(page, -extent * 0.8);
  await expect
    .poll(() => page.evaluate(() => (window as ProbeWindow).__epubGestureProbe.snapshots.length))
    .toBeGreaterThanOrEqual(2);
  await waitHalf();
  const reverse = await page.screenshot({
    path: test.info().outputPath('stack-reverse-half.png'),
    animations: 'allow',
  });
  const roi = {
    viewport: box,
    inset: 8,
    forward: {
      origin: pixelFraction(forward, box, colours.origin),
      next: pixelFraction(forward, box, colours.next),
      previous: pixelFraction(forward, box, colours.previous),
    },
    reverse: {
      origin: pixelFraction(reverse, box, colours.origin),
      next: pixelFraction(reverse, box, colours.next),
      previous: pixelFraction(reverse, box, colours.previous),
    },
  };
  await test.info().attach('native-stack-pixel-roi', {
    body: JSON.stringify(roi, null, 2),
    contentType: 'application/json',
  });
  console.log('NATIVE_STACK_PIXEL_ROI', JSON.stringify(roi));
  expect(roi.forward.origin).toBeGreaterThan(0.45);
  expect(roi.forward.next).toBeGreaterThan(0.3);
  expect(roi.forward.previous).toBeLessThan(0.01);
  expect(roi.reverse.origin).toBeGreaterThan(0.45);
  expect(roi.reverse.previous).toBeGreaterThan(0.3);
  expect(roi.reverse.next).toBeLessThan(0.01);
  await page.evaluate(() => window.clearInterval((window as HeldProbeWindow).__epubGestureHold));
  await sample(page, extent * 0.4);
  await page.waitForTimeout(700);
  await waitSettled(page);
  expect((await checkpoint(page)).cfi).toBe(before.cfi);
  expect(await page.evaluate(() => (window as ProbeWindow).__epubGestureProbe.writes)).toEqual([]);
});
