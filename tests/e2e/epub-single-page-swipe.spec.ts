import { expect, test, type Page } from '@playwright/test';

import { waitForEpubLayout, waitForEpubOpen } from './epub-readiness';

interface Checkpoint {
  cfi?: string;
  href?: string;
  pageNumber?: number;
  totalPageCount?: number;
}

interface SwipeProbe {
  writes: Checkpoint[];
  ready: number;
  failed: number;
  forceFailure: boolean;
  hold?: number;
}

declare global {
  interface Window {
    __singlePageSwipe: SwipeProbe;
  }
}
type ProbeWindow = Window;
type Effect = 'slide' | 'stack';

test.use({ viewport: { width: 1280, height: 720 } });

test.beforeEach(async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await context.route('https://en.wiktionary.org/**', (route) =>
    route.abort('internetdisconnected'),
  );
  await page.addInitScript(() => {
    const probe: SwipeProbe = { writes: [], ready: 0, failed: 0, forceFailure: false };
    (window as ProbeWindow).__singlePageSwipe = probe;
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('lexianchor:epub-location:'))
        probe.writes.push(JSON.parse(value) as Checkpoint);
      save.call(this, key, value);
    };
    if (document.startViewTransition) {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (update) => {
        if (probe.forceFailure) {
          probe.failed += 1;
          throw new Error('Deliberate test-only native ViewTransition failure');
        }
        const transition = start(update);
        void transition.ready.then(
          () => (probe.ready += 1),
          () => (probe.failed += 1),
        );
        return transition;
      };
    }
  });
});

async function checkpoint(page: Page): Promise<Checkpoint> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) =>
      value.startsWith('lexianchor:epub-location:'),
    );
    return JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint;
  });
}

async function openMiddlePage(page: Page, effect: Effect, failNative: boolean) {
  await page.goto('/');
  await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre de test/ })
    .click();
  await waitForEpubOpen(page);
  await page.locator('details.reader-appearance-panel > summary').click();
  await page
    .getByRole('combobox', { name: /Page turn effect|翻页效果|Effet de changement/ })
    .selectOption(effect);
  await waitForEpubLayout(page, {
    pageSpread: 'single',
    contentWidthPercent: 90,
    fontSizePercent: 100,
  });
  // Finish background indexing before probing zero writes during a gesture.
  await expect.poll(async () => (await checkpoint(page)).totalPageCount ?? 0).toBeGreaterThan(0);
  for (let turn = 0; turn < 4; turn += 1) {
    const before = await checkpoint(page);
    await page.getByRole('button', { name: /^(Next|下一页|Suivant)$/ }).click();
    await expect.poll(async () => (await checkpoint(page)).cfi).not.toBe(before.cfi);
  }
  await waitForEpubLayout(page, {
    pageSpread: 'single',
    contentWidthPercent: 90,
    fontSizePercent: 100,
  });
  await page.evaluate((fail) => {
    const probe = (window as ProbeWindow).__singlePageSwipe;
    probe.writes.length = 0;
    probe.ready = 0;
    probe.failed = 0;
    probe.forceFailure = fail;
  }, failNative);
}

async function heldBurst(
  page: Page,
  effect: Effect,
  direction: -1 | 1,
  failNative: boolean,
  oversized: boolean,
) {
  return page.evaluate(
    async ({ presentation, sign, forceFailure, large }) => {
      const probe = (window as ProbeWindow).__singlePageSwipe;
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="epub-container"] > .epub-container',
      );
      if (!scroller) throw new Error('Missing real EPUB scroller');
      const viewport = scroller.getBoundingClientRect();
      const frame = Array.from(scroller.querySelectorAll('iframe')).find((candidate) => {
        const box = candidate.getBoundingClientRect();
        return box.right > viewport.left + 1 && box.left < viewport.right - 1;
      });
      const body = frame?.contentDocument?.body;
      if (!body) throw new Error('Missing current real EPUB body');
      const origin = scroller.scrollLeft;
      const extent = scroller.clientWidth;
      const available = sign > 0 ? scroller.scrollWidth - extent - origin : origin;
      const wheel = (deltaX: number) =>
        body.dispatchEvent(
          new WheelEvent('wheel', {
            deltaX,
            deltaY: 0,
            deltaMode: 0,
            bubbles: true,
            cancelable: true,
          }),
        );
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const measure = () => {
        const animation = document.documentElement.getAnimations({ subtree: true }).find((item) => {
          const effect = item.effect as KeyframeEffect | null;
          return (
            item.playState === 'paused' &&
            effect?.pseudoElement === '::view-transition-old(lexianchor-page)' &&
            effect.getKeyframes().some((keyframe) => keyframe.transform !== undefined)
          );
        });
        const effect = animation?.effect as KeyframeEffect | undefined;
        const keyframes = effect?.getKeyframes();
        const end = keyframes?.at(-1)?.transform;
        const duration = Number(effect?.getTiming().duration);
        // Read the paused WAAPI presentation, not private controller state or
        // the underlying adjacent-page scroll target hidden beneath its sheet.
        const distance =
          animation && typeof end === 'string'
            ? -new DOMMatrix(end).m41 * (Number(animation.currentTime) / duration)
            : scroller.scrollLeft - origin;
        return {
          distance,
          scrollDistance: scroller.scrollLeft - origin,
          native: Boolean(animation),
          checkpoint: (() => {
            const key = Object.keys(localStorage).find((value) =>
              value.startsWith('lexianchor:epub-location:'),
            );
            return JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint;
          })(),
        };
      };
      // Hold input ownership while CDP/assertion roundtrips run. Balanced tiny
      // samples add no meaningful travel and cannot start another page turn.
      probe.hold = window.setInterval(() => {
        wheel(0.001);
        wheel(-0.001);
      }, 20);
      wheel(sign * 64);
      const deadline = performance.now() + 1_500;
      if (presentation === 'stack') {
        // Only preparation is awaited; none of the range/reversal assertions is
        // polled until it passes. Native cases cannot silently pass via fallback.
        while ((forceFailure ? probe.failed : probe.ready) === 0) {
          if (performance.now() > deadline)
            throw new Error('Native transition preparation timed out');
          await nextFrame();
        }
      }
      await nextFrame();
      const samples = [measure()];
      const count = large ? 16 : 10;
      const delta = sign * extent * (large ? 0.21 : 0.049);
      for (let index = 0; index < count; index += 1) {
        wheel(delta);
        await nextFrame();
        samples.push(measure());
      }
      const reversals = [];
      if (large)
        for (const pixels of [8, 30]) {
          const before = measure();
          wheel(-sign * pixels);
          await nextFrame();
          reversals.push({ pixels, before, after: measure() });
        }
      return {
        origin,
        extent,
        available,
        inputTravel: 64 + Math.abs(delta) * count,
        samples,
        reversals,
        writes: [...probe.writes],
        ready: probe.ready,
        failed: probe.failed,
      };
    },
    { presentation: effect, sign: direction, forceFailure: failNative, large: oversized },
  );
}

async function release(page: Page) {
  await page.evaluate(() => {
    const probe = (window as ProbeWindow).__singlePageSwipe;
    if (probe.hold !== undefined) window.clearInterval(probe.hold);
    probe.hold = undefined;
  });
}

for (const mode of [
  { effect: 'slide' as const, failure: false },
  { effect: 'stack' as const, failure: false },
  { effect: 'stack' as const, failure: true },
])
  for (const direction of [1, -1] as const) {
    test(`${mode.effect}${mode.failure ? ' native-failure fallback' : ''}: one sustained ${direction > 0 ? 'forward' : 'backward'} swipe owns only one page`, async ({
      page,
    }, testInfo) => {
      await openMiddlePage(page, mode.effect, mode.failure);
      const before = await checkpoint(page);
      try {
        const held = await heldBurst(page, mode.effect, direction, mode.failure, true);
        await testInfo.attach('single-page-held-presentation', {
          body: JSON.stringify(held, null, 2),
          contentType: 'application/json',
        });
        expect(held.available).toBeGreaterThan(held.extent * 3.3);
        expect(held.inputTravel).toBeGreaterThan(held.extent * 3.3);
        if (mode.effect === 'stack' && !mode.failure) expect(held.ready).toBeGreaterThan(0);
        if (mode.failure) expect(held.failed).toBeGreaterThan(0);
        for (const sample of held.samples) {
          expect(Math.abs(sample.distance)).toBeLessThanOrEqual(held.extent + 1.1);
          expect(Math.abs(sample.scrollDistance)).toBeLessThanOrEqual(held.extent + 1.1);
          expect(sample.checkpoint.cfi).toBe(before.cfi);
          if (mode.effect === 'stack' && !mode.failure) expect(sample.native).toBe(true);
        }
        expect(held.writes).toEqual([]);
        for (const reversal of held.reversals) {
          const travel = direction * (reversal.before.distance - reversal.after.distance);
          expect(Math.abs(travel - reversal.pixels)).toBeLessThan(1.1);
          expect(reversal.after.checkpoint.cfi).toBe(before.cfi);
        }
        await release(page);
        await expect
          .poll(async () => (await checkpoint(page)).pageNumber)
          .toBe((before.pageNumber ?? 1) + direction);
        await waitForEpubLayout(page, {
          pageSpread: 'single',
          contentWidthPercent: 90,
          fontSizePercent: 100,
        });
        const after = await checkpoint(page);
        expect(after.href).toBe(before.href);
        expect(after.cfi).not.toBe(before.cfi);
        const firstWrites = await page.evaluate(
          () => (window as ProbeWindow).__singlePageSwipe.writes,
        );
        expect(new Set(firstWrites.map((value) => value.cfi))).toEqual(new Set([after.cfi]));
        await page.evaluate(() => {
          const probe = (window as ProbeWindow).__singlePageSwipe;
          probe.writes.length = 0;
          probe.ready = 0;
          probe.failed = 0;
        });
        const independent = await heldBurst(page, mode.effect, direction, mode.failure, false);
        expect(independent.writes).toEqual([]);
        expect(independent.samples.at(-1)?.checkpoint.cfi).toBe(after.cfi);
        await release(page);
        await expect
          .poll(async () => (await checkpoint(page)).pageNumber)
          .toBe((after.pageNumber ?? 1) + direction);
        expect((await checkpoint(page)).cfi).not.toBe(after.cfi);
      } finally {
        await release(page);
      }
    });
  }
