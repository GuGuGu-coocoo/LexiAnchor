import { expect, test } from '@playwright/test';

import { waitForEpubLayout, waitForEpubOpen } from './epub-readiness';

interface Checkpoint {
  cfi?: string;
  pageNumber?: number;
  totalPageCount?: number;
}
interface WheelRecord {
  gesture: number;
  time: number;
  delta: number;
  source: 'host' | 'iframe';
  target: string;
  trusted: boolean;
  prevented: boolean;
}
interface TransitionRecord {
  gesture: number;
  started: number;
  ready?: number;
  finished?: number;
  error?: string;
}
interface FrameRecord {
  gesture: number;
  time: number;
  input: number;
  distance: number;
  cfi?: string;
}
interface Probe {
  gesture: number;
  started: number;
  origin: number;
  wheels: WheelRecord[];
  transitions: TransitionRecord[];
  frames: FrameRecord[];
  auxiliary: { type: string; time: number }[];
  released: Record<number, number>;
  stop?(): void;
}
type ProbeWindow = Window & { __stackSuccessive?: Probe };

interface TerminalSnapshot {
  time: number;
  cfi?: string;
  pageNumber?: number;
  oldTime?: number;
  remaining?: number;
}
interface TerminalProbe {
  started: number;
  released: boolean;
  done: boolean;
  missed?: string;
  error?: string;
  requested?: TerminalSnapshot;
  firstSecondWheel?: TerminalSnapshot;
  frames: TerminalSnapshot[];
  wheels: (TerminalSnapshot & {
    second: boolean;
    delta: number;
    target: string;
    prevented: boolean;
  })[];
  stop?(): void;
}
type TerminalWindow = Window & {
  __stackTerminal?: TerminalProbe;
  __launchTerminalSecond?: () => Promise<void>;
};

test.use({ viewport: { width: 1280, height: 720 } });

test('stack: four successive trusted gestures at one fixed point need no click or pointer reset', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await context.route('https://en.wiktionary.org/**', (route) =>
    route.abort('internetdisconnected'),
  );
  await page.addInitScript(() => {
    const probe: Probe = {
      gesture: 0,
      started: 0,
      origin: 0,
      wheels: [],
      transitions: [],
      frames: [],
      auxiliary: [],
      released: {},
    };
    (window as unknown as ProbeWindow).__stackSuccessive = probe;
    for (const type of ['click', 'pointermove', 'keydown'])
      document.addEventListener(
        type,
        () => {
          if (probe.gesture)
            probe.auxiliary.push({ type, time: performance.now() - probe.started });
        },
        { capture: true, passive: true },
      );
    if (!document.startViewTransition) return;
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (update) => {
      const record: TransitionRecord = {
        gesture: probe.gesture,
        started: performance.now() - probe.started,
      };
      probe.transitions.push(record);
      const transition = start(update);
      void transition.ready.then(
        () => (record.ready = performance.now() - probe.started),
        (error: unknown) => (record.error = String(error)),
      );
      void transition.finished.then(
        () => (record.finished = performance.now() - probe.started),
        (error: unknown) => (record.error = String(error)),
      );
      return transition;
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre de test/ })
    .click();
  await waitForEpubOpen(page);
  await page.locator('details.reader-appearance-panel > summary').click();
  await page
    .getByRole('combobox', { name: /Page turn effect|翻页效果|Effet de changement/ })
    .selectOption('stack');
  await waitForEpubLayout(page, {
    pageSpread: 'single',
    contentWidthPercent: 90,
    fontSizePercent: 100,
  });
  await page.evaluate(async () => {
    const read = () => {
      const key = Object.keys(localStorage).find((value) =>
        value.startsWith('lexianchor:epub-location:'),
      );
      return key ? (localStorage.getItem(key) ?? '') : '';
    };
    let previous = read();
    let changed = performance.now();
    const deadline = changed + 5_000;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = read();
      if (current !== previous) {
        previous = current;
        changed = performance.now();
      }
      if (
        current &&
        (JSON.parse(current) as Checkpoint).totalPageCount &&
        performance.now() - changed >= 200
      )
        return;
    }
    throw new Error('Initial EPUB checkpoint did not finish initialization within 5 seconds');
  });
  const point = await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__stackSuccessive;
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    if (!probe || !scroller) throw new Error('Missing isolated EPUB probe');
    probe.started = performance.now();
    const documents = new Map<Document, (event: WheelEvent) => void>();
    const attach = (doc: Document, source: 'host' | 'iframe') => {
      if (documents.has(doc)) return;
      const capture = (event: WheelEvent) => {
        if (!probe.gesture) return;
        const target = event.target as Element | null;
        const record: WheelRecord = {
          gesture: probe.gesture,
          time: performance.now() - probe.started,
          delta: event.deltaX,
          source,
          target: `${target?.tagName ?? ''}#${target?.id ?? ''}.${target?.getAttribute?.('class') ?? ''}`,
          trusted: event.isTrusted,
          prevented: false,
        };
        probe.wheels.push(record);
        setTimeout(() => (record.prevented = event.defaultPrevented), 0);
      };
      doc.addEventListener('wheel', capture, { capture: true, passive: true });
      documents.set(doc, capture);
    };
    const scan = () => {
      for (const frame of scroller.querySelectorAll('iframe'))
        if (frame.contentDocument) attach(frame.contentDocument, 'iframe');
    };
    attach(document, 'host');
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(scroller, { childList: true, subtree: true });
    let frameId = 0;
    const sample = () => {
      scan();
      if (probe.gesture) {
        const input = probe.wheels
          .filter((wheel) => wheel.gesture === probe.gesture)
          .reduce((sum, wheel) => sum + wheel.delta, 0);
        const animation = document.documentElement.getAnimations({ subtree: true }).find((item) => {
          const effect = item.effect as KeyframeEffect | null;
          return (
            item.playState === 'paused' &&
            effect?.pseudoElement === '::view-transition-old(lexianchor-page)' &&
            effect.getKeyframes().some((frame) => frame.transform !== undefined)
          );
        });
        const effect = animation?.effect as KeyframeEffect | undefined;
        const end = effect?.getKeyframes().at(-1)?.transform;
        const key = Object.keys(localStorage).find((value) =>
          value.startsWith('lexianchor:epub-location:'),
        );
        const checkpoint = JSON.parse(
          key ? (localStorage.getItem(key) ?? '{}') : '{}',
        ) as Checkpoint;
        probe.frames.push({
          gesture: probe.gesture,
          time: performance.now() - probe.started,
          input,
          distance:
            animation && typeof end === 'string'
              ? (-new DOMMatrix(end).m41 * Number(animation.currentTime)) /
                Number(effect?.getTiming().duration)
              : scroller.scrollLeft - probe.origin,
          cfi: checkpoint.cfi,
        });
      }
      frameId = requestAnimationFrame(sample);
    };
    sample();
    probe.stop = () => {
      cancelAnimationFrame(frameId);
      observer.disconnect();
      for (const [doc, listener] of documents) doc.removeEventListener('wheel', listener, true);
    };
    const box = scroller.getBoundingClientRect();
    return {
      x: box.left + box.width * 0.5,
      y: box.top + box.height * 0.4,
      extent: scroller.clientWidth,
    };
  });
  const cdp = await context.newCDPSession(page);
  const turns: { gesture: number; before: Checkpoint; after: Checkpoint }[] = [];
  try {
    // From here there are no clicks, pointer moves, keys, TOC actions, reloads,
    // or page-turn buttons. The same CDP reading coordinate is reused unchanged.
    for (let gesture = 1; gesture <= 4; gesture += 1) {
      const before = await page.evaluate((index) => {
        const probe = (window as unknown as ProbeWindow).__stackSuccessive;
        const scroller = document.querySelector<HTMLElement>(
          '[data-testid="epub-container"] > .epub-container',
        );
        if (!probe || !scroller) throw new Error('Lost isolated EPUB probe');
        probe.gesture = index;
        probe.origin = scroller.scrollLeft;
        const key = Object.keys(localStorage).find((value) =>
          value.startsWith('lexianchor:epub-location:'),
        );
        return JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint;
      }, gesture);
      await cdp.send('Input.synthesizeScrollGesture', {
        x: point.x,
        y: point.y,
        xDistance: -point.extent * 0.55,
        speed: 240,
        gestureSourceType: 'mouse',
        preventFling: true,
      });
      await page.evaluate((index) => {
        const probe = (window as unknown as ProbeWindow).__stackSuccessive;
        if (probe) probe.released[index] = performance.now() - probe.started;
      }, gesture);
      await expect.soft
        .poll(
          () =>
            page.evaluate(
              ({ index, cfi, pageNumber }) => {
                const probe = (window as unknown as ProbeWindow).__stackSuccessive;
                const key = Object.keys(localStorage).find((value) =>
                  value.startsWith('lexianchor:epub-location:'),
                );
                const current = JSON.parse(
                  key ? (localStorage.getItem(key) ?? '{}') : '{}',
                ) as Checkpoint;
                const transitions =
                  probe?.transitions.filter((item) => item.gesture === index) ?? [];
                return Boolean(
                  current.pageNumber === (pageNumber ?? 1) + 1 &&
                  current.cfi !== cfi &&
                  transitions.length &&
                  transitions.every((item) => item.finished !== undefined) &&
                  !document.querySelector('.epub-page-stack-transition') &&
                  !document.documentElement
                    .getAnimations({ subtree: true })
                    .some((animation) =>
                      (animation.effect as KeyframeEffect | null)?.pseudoElement?.includes(
                        'lexianchor-page',
                      ),
                    ),
                );
              },
              { index: gesture, cfi: before.cfi, pageNumber: before.pageNumber },
            ),
          {
            message: `gesture ${gesture} must commit its adjacent page and clean up VT`,
            timeout: 5_000,
          },
        )
        .toBe(true);
      const after = await page.evaluate(() => {
        const key = Object.keys(localStorage).find((value) =>
          value.startsWith('lexianchor:epub-location:'),
        );
        return JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint;
      });
      turns.push({ gesture, before, after });
      expect
        .soft(after.pageNumber, `gesture ${gesture} adjacent page`)
        .toBe((before.pageNumber ?? 1) + 1);
      expect.soft(after.cfi, `gesture ${gesture} committed CFI`).not.toBe(before.cfi);
    }
  } finally {
    await cdp.detach();
    const trace = await page.evaluate(() => {
      const probe = (window as unknown as ProbeWindow).__stackSuccessive;
      probe?.stop?.();
      if (!probe) throw new Error('Lost isolated EPUB probe');
      const trace = { ...probe };
      delete trace.stop;
      return trace;
    });
    await testInfo.attach('four-successive-fixed-point-stack', {
      body: JSON.stringify(
        { protocol: 'CDP synthetic mouse, not a physical trackpad', point, turns, trace },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    for (const turn of turns) {
      const transitions = trace.transitions.filter((item) => item.gesture === turn.gesture);
      const wheels = trace.wheels.filter(
        (item) => item.gesture === turn.gesture && Math.abs(item.delta) > 0,
      );
      console.log(
        JSON.stringify({
          gesture: turn.gesture,
          before: turn.before.pageNumber,
          after: turn.after.pageNumber,
          transitions,
          routes: wheels.reduce<Record<string, number>>((counts, wheel) => {
            const route = `${wheel.source}:${wheel.prevented}:${wheel.target}`;
            counts[route] = (counts[route] ?? 0) + 1;
            return counts;
          }, {}),
        }),
      );
      expect.soft(transitions).toHaveLength(1);
      expect.soft(transitions[0]?.error).toBeUndefined();
      expect.soft(wheels.length).toBeGreaterThan(20);
      expect.soft(wheels.every((wheel) => wheel.trusted && wheel.prevented)).toBe(true);
      const ready = transitions[0]?.ready;
      expect.soft(ready).toBeDefined();
      const following = trace.frames.filter(
        (frame) =>
          frame.gesture === turn.gesture &&
          frame.time > (ready ?? 0) + 20 &&
          frame.time < (trace.released[turn.gesture] ?? Number.POSITIVE_INFINITY),
      );
      expect.soft(following.length).toBeGreaterThan(0);
      expect.soft(following.every((frame) => frame.cfi === turn.before.cfi)).toBe(true);
      expect
        .soft(Math.max(0, ...following.map((frame) => Math.abs(frame.distance - frame.input))))
        .toBeLessThan(1.1);
    }
    expect
      .soft(trace.auxiliary.filter((event) => event.type === 'click' || event.type === 'keydown'))
      .toEqual([]);
  }
});

test('stack: outward gesture can hand off a committed spring within its last visible pixel', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await context.route('https://en.wiktionary.org/**', (route) =>
    route.abort('internetdisconnected'),
  );
  await page.goto('/');
  await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre de test/ })
    .click();
  await waitForEpubOpen(page);
  await page.locator('details.reader-appearance-panel > summary').click();
  await page
    .getByRole('combobox', { name: /Page turn effect|翻页效果|Effet de changement/ })
    .selectOption('stack');
  await waitForEpubLayout(page, {
    pageSpread: 'single',
    contentWidthPercent: 90,
    fontSizePercent: 100,
  });
  const surface = await page
    .getByTestId('epub-container')
    .locator(':scope > .epub-container')
    .evaluate((scroller) => {
      const box = scroller.getBoundingClientRect();
      const key = Object.keys(localStorage).find((value) =>
        value.startsWith('lexianchor:epub-location:'),
      );
      return {
        x: box.left + box.width * 0.5,
        y: box.top + box.height * 0.4,
        extent: scroller.clientWidth,
        initial: JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint,
      };
    });
  const cdp = await context.newCDPSession(page);
  const gesture = () =>
    cdp.send('Input.synthesizeScrollGesture', {
      x: surface.x,
      y: surface.y,
      xDistance: -surface.extent * 0.55,
      speed: 240,
      gestureSourceType: 'mouse',
      preventFling: true,
    });
  await page.exposeFunction('__launchTerminalSecond', async () => {
    // Dispatch immediately: an extra evaluate before this send can consume
    // the few frames between the last visible pixel and the actual commit.
    await gesture();
    await page.evaluate(() => {
      const probe = (window as unknown as TerminalWindow).__stackTerminal;
      if (probe) probe.done = true;
    });
  });
  await page.evaluate((initial) => {
    const probe: TerminalProbe = {
      started: performance.now(),
      released: false,
      done: false,
      frames: [],
      wheels: [],
    };
    const ownWindow = window as unknown as TerminalWindow;
    ownWindow.__stackTerminal = probe;
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    if (!scroller) throw new Error('Missing isolated EPUB scroller');
    const snapshot = (): TerminalSnapshot => {
      const key = Object.keys(localStorage).find((value) =>
        value.startsWith('lexianchor:epub-location:'),
      );
      const checkpoint = JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint;
      const animation = document.documentElement
        .getAnimations({ subtree: true })
        .find(
          (item) =>
            item.playState === 'paused' &&
            (item.effect as KeyframeEffect | null)?.pseudoElement ===
              '::view-transition-old(lexianchor-page)',
        );
      const effect = animation?.effect as KeyframeEffect | undefined;
      const end = effect?.getKeyframes().at(-1)?.transform;
      const oldTime = animation ? Number(animation.currentTime) : undefined;
      const duration = Number(effect?.getTiming().duration);
      return {
        time: performance.now() - probe.started,
        cfi: checkpoint.cfi,
        pageNumber: checkpoint.pageNumber,
        oldTime,
        remaining:
          typeof end === 'string' && oldTime !== undefined
            ? Math.abs(new DOMMatrix(end).m41) * (1 - oldTime / duration)
            : undefined,
      };
    };
    const documents = new Map<Document, (event: WheelEvent) => void>();
    const attach = (doc: Document, source: string) => {
      if (documents.has(doc)) return;
      const capture = (event: WheelEvent) => {
        if (!event.deltaX) return;
        const row = {
          ...snapshot(),
          second: Boolean(probe.requested),
          delta: event.deltaX,
          target: `${source}:${(event.target as Element | null)?.tagName ?? ''}`,
          prevented: false,
        };
        probe.wheels.push(row);
        if (row.second && !probe.firstSecondWheel) probe.firstSecondWheel = row;
        setTimeout(() => (row.prevented = event.defaultPrevented), 0);
      };
      // Observe before the reader's document-capture bridge can synchronously
      // commit the old sheet. A later listener would see the repaired CFI and
      // mistake a successful terminal handoff for a missed timing window.
      if (!doc.defaultView) throw new Error('Missing live window for terminal input probe');
      doc.defaultView.addEventListener('wheel', capture, {
        capture: true,
        passive: true,
      });
      documents.set(doc, capture);
    };
    const scan = () => {
      for (const frame of scroller.querySelectorAll('iframe'))
        if (frame.contentDocument) attach(frame.contentDocument, 'iframe');
    };
    attach(document, 'host');
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(scroller, { childList: true, subtree: true });
    let frame = 0;
    const sample = () => {
      scan();
      const row = snapshot();
      probe.frames.push(row);
      if (probe.released && !probe.requested && !probe.missed) {
        if (row.cfi !== initial.cfi) {
          probe.missed = 'first page committed before a terminal-pixel cue was observed';
        } else if (row.remaining !== undefined && row.remaining >= 0 && row.remaining <= 1) {
          probe.requested = row;
          void ownWindow.__launchTerminalSecond?.().catch((error: unknown) => {
            probe.error = String(error);
          });
        }
      }
      frame = requestAnimationFrame(sample);
    };
    sample();
    probe.stop = () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const [doc, capture] of documents)
        doc.defaultView?.removeEventListener('wheel', capture, true);
    };
  }, surface.initial);
  let trace: TerminalProbe | undefined;
  let final: Checkpoint | undefined;
  try {
    // Neither gesture changes the pointer coordinate or uses a recovery click.
    await gesture();
    await page.evaluate(() => {
      const probe = (window as unknown as TerminalWindow).__stackTerminal;
      if (probe) probe.released = true;
    });
    await page.waitForFunction(
      () => {
        const probe = (window as unknown as TerminalWindow).__stackTerminal;
        return probe?.done || probe?.missed || probe?.error;
      },
      undefined,
      { timeout: 5_000 },
    );
    const timed = await page.evaluate(() => {
      const probe = (window as unknown as TerminalWindow).__stackTerminal;
      return probe?.firstSecondWheel;
    });
    const hit =
      timed !== undefined &&
      timed.cfi === surface.initial.cfi &&
      timed.remaining !== undefined &&
      timed.remaining >= 0 &&
      timed.remaining <= 1;
    if (hit)
      await expect.soft
        .poll(
          () =>
            page.evaluate(() => {
              const key = Object.keys(localStorage).find((value) =>
                value.startsWith('lexianchor:epub-location:'),
              );
              return (JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint)
                .pageNumber;
            }),
          {
            message:
              'a second outward gesture delivered before terminal commit must reach another adjacent page',
            timeout: 5_000,
          },
        )
        .toBe((surface.initial.pageNumber ?? 1) + 2);
  } finally {
    await cdp.detach();
    ({ trace, final } = await page.evaluate(() => {
      const probe = (window as unknown as TerminalWindow).__stackTerminal;
      probe?.stop?.();
      if (!probe) throw new Error('Lost terminal-pixel probe');
      const trace = { ...probe };
      delete trace.stop;
      const key = Object.keys(localStorage).find((value) =>
        value.startsWith('lexianchor:epub-location:'),
      );
      return {
        trace,
        final: JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint,
      };
    }));
    await testInfo.attach('terminal-pixel-cross-process-experiment', {
      body: JSON.stringify(
        { protocol: 'CDP synthetic mouse, not a physical trackpad', surface, final, trace },
        null,
        2,
      ),
      contentType: 'application/json',
    });
  }
  console.log(
    JSON.stringify({
      requested: trace?.requested,
      firstSecondWheel: trace?.firstSecondWheel,
      missed: trace?.missed,
      error: trace?.error,
      initialPage: surface.initial.pageNumber,
      finalPage: final?.pageNumber,
    }),
  );
  expect(trace?.error).toBeUndefined();
  const delivered = trace?.firstSecondWheel;
  test.skip(
    delivered === undefined ||
      delivered.cfi !== surface.initial.cfi ||
      delivered.remaining === undefined ||
      delivered.remaining < 0 ||
      delivered.remaining > 1,
    'Cross-process CDP input did not land inside the uncommitted terminal-pixel window; experiment inconclusive',
  );
  expect(final?.pageNumber).toBe((surface.initial.pageNumber ?? 1) + 2);
  expect(final?.cfi).not.toBe(surface.initial.cfi);
});
