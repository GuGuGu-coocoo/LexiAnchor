import { expect, test, type Page } from '@playwright/test';

import { waitForEpubLayout, waitForEpubOpen } from './epub-readiness';

type Effect = 'slide' | 'stack';
interface Checkpoint {
  cfi?: string;
  href?: string;
  pageNumber?: number;
  totalPageCount?: number;
}
interface FrameSample {
  index: number;
  time: number;
  wheelCount: number;
  phase: string;
  distance: number;
  scrollDistance: number;
  native: boolean;
  cfi?: string;
}
interface WheelSample {
  time: number;
  phase: string;
  delta: number;
  source: 'host' | 'iframe';
  target: string;
  trusted: boolean;
  accepted: boolean;
}
interface Trace {
  origin: number;
  extent: number;
  startedAt: number;
  initial: Checkpoint;
  phase: string;
  releasedAt: number;
  readyTimes: number[];
  frames: FrameSample[];
  pauses: { requestedDuration: number; start: FrameSample; end: FrameSample }[];
  wheels: WheelSample[];
  writes: { time: number; checkpoint: Checkpoint }[];
}
interface Runtime {
  trace: Trace;
  pause(duration: number): Promise<void>;
  stop(): Trace;
}
type TraceWindow = Window & { __trackpadIntent?: Runtime };
interface Segment {
  phase: string;
  deltas: number[];
  interval: number;
  pause?: number;
}

test.use({ viewport: { width: 1280, height: 720 } });
test.beforeEach(async ({ page, context }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await context.route('https://en.wiktionary.org/**', (route) =>
    route.abort('internetdisconnected'),
  );
  await page.addInitScript(() => {
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      const active = (window as unknown as TraceWindow).__trackpadIntent;
      if (active && key.startsWith('lexianchor:epub-location:'))
        active.trace.writes.push({
          time: performance.now() - active.trace.startedAt,
          checkpoint: JSON.parse(value) as Checkpoint,
        });
      save.call(this, key, value);
    };
    if (document.startViewTransition) {
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (update) => {
        const active = (window as unknown as TraceWindow).__trackpadIntent;
        const transition = start(update);
        void transition.ready.then(
          () => {
            if (active) active.trace.readyTimes.push(performance.now() - active.trace.startedAt);
          },
          () => undefined,
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

async function waitForCheckpointQuiescence(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        let previous = '';
        let changedAt = performance.now();
        let frame = 0;
        const timeout = setTimeout(() => {
          cancelAnimationFrame(frame);
          reject(new Error('EPUB checkpoint did not finish initialization within 5 seconds'));
        }, 5_000);
        const observe = () => {
          const key = Object.keys(localStorage).find((value) =>
            value.startsWith('lexianchor:epub-location:'),
          );
          const current = key ? (localStorage.getItem(key) ?? '') : '';
          if (!current || current !== previous) {
            previous = current;
            changedAt = performance.now();
          } else if (performance.now() - changedAt >= 200) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          frame = requestAnimationFrame(observe);
        };
        observe();
      }),
  );
}

async function open(page: Page, effect: Effect) {
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
  await expect.poll(async () => (await checkpoint(page)).totalPageCount ?? 0).toBeGreaterThan(0);
  // Index/TOC metadata can arrive after totalPageCount first appears. Establish
  // quiescence before input, without ignoring any writes during that input.
  await waitForCheckpointQuiescence(page);
  await waitForEpubLayout(page, {
    pageSpread: 'single',
    contentWidthPercent: 90,
    fontSizePercent: 100,
  });
}

async function laterPage(page: Page) {
  for (let index = 0; index < 4; index += 1) {
    const before = await checkpoint(page);
    await page.getByRole('button', { name: /^(Next|下一页|Suivant)$/ }).click();
    await expect.poll(async () => (await checkpoint(page)).cfi).not.toBe(before.cfi);
  }
  await waitForEpubLayout(page, {
    pageSpread: 'single',
    contentWidthPercent: 90,
    fontSizePercent: 100,
  });
  await waitForCheckpointQuiescence(page);
  await waitForEpubLayout(page, {
    pageSpread: 'single',
    contentWidthPercent: 90,
    fontSizePercent: 100,
  });
}

async function startTrace(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    if (!scroller) throw new Error('Missing actual EPUB scroller');
    const read = (): Checkpoint => {
      const key = Object.keys(localStorage).find((value) =>
        value.startsWith('lexianchor:epub-location:'),
      );
      return JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint;
    };
    const trace: Trace = {
      origin: scroller.scrollLeft,
      extent: scroller.clientWidth,
      startedAt: performance.now(),
      initial: read(),
      phase: 'start',
      releasedAt: Number.POSITIVE_INFINITY,
      readyTimes: [],
      frames: [],
      pauses: [],
      wheels: [],
      writes: [],
    };
    const documents = new Map<Document, (event: WheelEvent) => void>();
    const attach = (doc: Document, source: 'host' | 'iframe') => {
      if (documents.has(doc)) return;
      const capture = (event: WheelEvent) => {
        const element = event.target as Element | null;
        const row: WheelSample = {
          time: performance.now() - trace.startedAt,
          phase: trace.phase,
          delta: event.deltaX,
          source,
          target: `${element?.tagName ?? ''}#${element?.id ?? ''}.${element?.getAttribute?.('class') ?? ''}`,
          trusted: event.isTrusted,
          accepted: false,
        };
        trace.wheels.push(row);
        // Native events can checkpoint microtasks between listeners. Use the
        // next task to read acceptance after the whole dispatch; never prevent
        // or reroute this event just to observe its production handling.
        setTimeout(() => {
          row.accepted = event.defaultPrevented;
        }, 0);
      };
      documents.set(doc, capture);
      doc.addEventListener('wheel', capture, { capture: true, passive: true });
    };
    const frames = () => {
      for (const frame of Array.from(scroller.querySelectorAll('iframe'))) {
        if (frame.contentDocument) attach(frame.contentDocument, 'iframe');
      }
    };
    attach(document, 'host');
    frames();
    const observer = new MutationObserver(frames);
    observer.observe(scroller, { childList: true, subtree: true });
    let frameId = 0;
    const sampleOnce = (): FrameSample => {
      // Equal quantized timestamps do not imply event order. Snapshot the
      // number of already delivered wheel packets in this synchronous frame.
      const wheelCount = trace.wheels.length;
      frames();
      const animation = document.documentElement.getAnimations({ subtree: true }).find((item) => {
        const effect = item.effect as KeyframeEffect | null;
        return (
          item.playState === 'paused' &&
          effect?.pseudoElement === '::view-transition-old(lexianchor-page)' &&
          effect.getKeyframes().some((keyframe) => keyframe.transform !== undefined)
        );
      });
      const effect = animation?.effect as KeyframeEffect | undefined;
      const end = effect?.getKeyframes().at(-1)?.transform;
      const distance =
        animation && typeof end === 'string'
          ? (-new DOMMatrix(end).m41 * Number(animation.currentTime)) /
            Number(effect?.getTiming().duration)
          : scroller.scrollLeft - trace.origin;
      const frame = {
        index: trace.frames.length,
        time: performance.now() - trace.startedAt,
        wheelCount,
        phase: trace.phase,
        distance,
        scrollDistance: scroller.scrollLeft - trace.origin,
        native: Boolean(animation),
        cfi: read().cfi,
      };
      trace.frames.push(frame);
      return frame;
    };
    const sample = () => {
      sampleOnce();
      frameId = requestAnimationFrame(sample);
    };
    sample();
    (window as unknown as TraceWindow).__trackpadIntent = {
      trace,
      pause: async (requestedDuration) => {
        trace.phase = 'short-pause';
        const start = sampleOnce();
        await new Promise((resolve) => setTimeout(resolve, requestedDuration));
        const end = sampleOnce();
        trace.pauses.push({ requestedDuration, start, end });
      },
      stop: () => {
        cancelAnimationFrame(frameId);
        observer.disconnect();
        for (const [doc, capture] of documents) doc.removeEventListener('wheel', capture, true);
        delete (window as unknown as TraceWindow).__trackpadIntent;
        return trace;
      },
    };
    const box = scroller.getBoundingClientRect();
    return { extent: trace.extent, x: box.left + box.width * 0.5, y: box.top + box.height * 0.4 };
  });
}

function slowProtocol(extent: number, pause: number): Segment[] {
  return [
    { phase: 'slow-start', deltas: Array<number>(48).fill(2), interval: 8 },
    { phase: 'short-pause', deltas: [], interval: 0, pause },
    { phase: 'slow-resume', deltas: Array<number>(36).fill(2), interval: 16 },
    { phase: 'reverse', deltas: Array<number>(8).fill(-2), interval: 16 },
    {
      phase: 'continue',
      deltas: Array<number>(Math.ceil((extent * 0.55 - 152) / 2)).fill(2),
      interval: 8,
    },
    { phase: 'decaying-tail', deltas: [2, 1.5, 1, 0.75, 0.5, 0.25], interval: 16 },
  ];
}

async function runTrace(
  page: Page,
  segments: Segment[],
  input: 'body' | 'cdp' | 'synthetic',
  syntheticSpeed = 160,
) {
  const surface = await startTrace(page);
  try {
    if (input === 'body') {
      await page.evaluate(async (protocol) => {
        const runtime = (window as unknown as TraceWindow).__trackpadIntent;
        const scroller = document.querySelector<HTMLElement>(
          '[data-testid="epub-container"] > .epub-container',
        );
        if (!runtime || !scroller) throw new Error('Missing isolated trace runtime');
        const viewport = scroller.getBoundingClientRect();
        const frame = Array.from(scroller.querySelectorAll('iframe')).find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.right > viewport.left + 1 && box.left < viewport.right - 1;
        });
        const body = frame?.contentDocument?.body;
        if (!body) throw new Error('Missing current EPUB body');
        for (const segment of protocol) {
          runtime.trace.phase = segment.phase;
          if (segment.pause) await runtime.pause(segment.pause);
          for (const deltaX of segment.deltas) {
            body.dispatchEvent(
              new WheelEvent('wheel', {
                deltaX,
                deltaY: 0,
                deltaMode: 0,
                bubbles: true,
                cancelable: true,
              }),
            );
            await new Promise((resolve) => setTimeout(resolve, segment.interval));
          }
        }
      }, segments);
    } else {
      const cdp = await page.context().newCDPSession(page);
      try {
        await page.mouse.move(surface.x, surface.y);
        if (input === 'synthetic') {
          await page.evaluate(() => {
            const active = (window as unknown as TraceWindow).__trackpadIntent;
            if (active) active.trace.phase = 'synthetic-continuous';
          });
          await cdp.send('Input.synthesizeScrollGesture', {
            x: surface.x,
            y: surface.y,
            xDistance: -surface.extent * 0.55,
            speed: syntheticSpeed,
            gestureSourceType: 'mouse',
            preventFling: true,
          });
        }
        // dispatchMouseEvent packets exercise trusted hit testing, but CDP can
        // append phaseEnded per packet. They are not a physical macOS stream.
        const protocol = input === 'synthetic' ? [] : segments;
        let phaseAlreadySet = false;
        for (const [index, segment] of protocol.entries()) {
          if (segment.pause) {
            // One renderer task owns both pause boundaries and the resumed
            // phase. Do not add phase-only roundtrips around a short silence.
            await page.evaluate(
              async ({ duration, nextPhase }) => {
                const active = (window as unknown as TraceWindow).__trackpadIntent;
                if (!active) throw new Error('Missing isolated trace runtime');
                await active.pause(duration);
                if (nextPhase) active.trace.phase = nextPhase;
              },
              { duration: segment.pause, nextPhase: protocol[index + 1]?.phase },
            );
            phaseAlreadySet = true;
            continue;
          }
          if (!phaseAlreadySet)
            await page.evaluate((phase) => {
              const active = (window as unknown as TraceWindow).__trackpadIntent;
              if (active) active.trace.phase = phase;
            }, segment.phase);
          phaseAlreadySet = false;
          let deadline = Date.now();
          const pending = [];
          for (const deltaX of segment.deltas) {
            const delay = Math.max(0, deadline - Date.now());
            if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
            // Real browser hit testing, including native transition overlays.
            // Queue each packet at nominal cadence without waiting for a CDP
            // roundtrip to lengthen every 8–16 ms event interval.
            pending.push(
              cdp.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: surface.x,
                y: surface.y,
                deltaX,
                deltaY: 0,
              }),
            );
            deadline += segment.interval;
          }
          await Promise.all(pending);
          const remainder = deadline - Date.now();
          if (remainder > 0) await new Promise((resolve) => setTimeout(resolve, remainder));
        }
      } finally {
        await cdp.detach();
      }
    }
    await page.evaluate(() => {
      const active = (window as unknown as TraceWindow).__trackpadIntent;
      if (active) {
        active.trace.phase = 'released';
        active.trace.releasedAt = performance.now() - active.trace.startedAt;
      }
    });
    // Fixed observation window, not polling cancellation/commit until it passes.
    await page.waitForTimeout(1_600);
    const trace = await page.evaluate(() => {
      const active = (window as unknown as TraceWindow).__trackpadIntent;
      if (!active) throw new Error('Lost trace runtime');
      return active.stop();
    });
    return { input, trace, final: await checkpoint(page) };
  } finally {
    await page.evaluate(() => (window as unknown as TraceWindow).__trackpadIntent?.stop());
  }
}

test('stack: CDP synthetic continuous mouse gesture retains hit-test routing at 160/240px per second', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await open(page, 'stack');
  const first = await runTrace(page, [], 'synthetic', 160);
  await laterPage(page);
  const later = await runTrace(page, [], 'synthetic', 240);
  await testInfo.attach('synthetic-continuous-first-later', {
    body: JSON.stringify(
      {
        protocol: 'Input.synthesizeScrollGesture; gestureSourceType=mouse; preventFling=true',
        source:
          'https://chromedevtools.github.io/devtools-protocol/tot/Input/#method-synthesizeScrollGesture',
        limitation:
          'Official protocol synthetic input, not a physical trackpad or native inertia recording',
        firstSpeed: 160,
        laterSpeed: 240,
        first,
        later,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  });
  for (const { trace, final } of [first, later]) {
    expect(trace.readyTimes.length).toBeGreaterThan(0);
    expect(trace.wheels.length).toBeGreaterThan(20);
    expect(trace.wheels.every((wheel) => wheel.trusted)).toBe(true);
    // CDP defines positive xDistance as leftward. Verify the negative distance
    // actually produced positive pixel wheel packets before relying on it.
    const moving = trace.wheels.filter((wheel) => Math.abs(wheel.delta) > 0);
    expect(moving.every((wheel) => wheel.delta > 0)).toBe(true);
    const preparedAt = trace.readyTimes[0]!;
    const accepted = moving.filter((wheel) => wheel.time > preparedAt + 20);
    expect(accepted.length).toBeGreaterThan(20);
    expect(
      accepted.every((wheel) => wheel.accepted),
      'continuous trusted packets after VT ready must reach the reader',
    ).toBe(true);
    const held = trace.frames.filter((frame) => frame.time < trace.releasedAt);
    expect(held.every((frame) => frame.cfi === trace.initial.cfi)).toBe(true);
    expect(trace.writes.filter((write) => write.time < trace.releasedAt)).toEqual([]);
    for (const frame of held.filter((sample) => sample.time > preparedAt + 20)) {
      const input = trace.wheels
        .slice(0, frame.wheelCount)
        .reduce((sum, wheel) => sum + wheel.delta, 0);
      expect(
        Math.abs(frame.distance - input),
        `synthetic first-frame following at ${frame.time}ms`,
      ).toBeLessThan(1.1);
    }
    expect(final.pageNumber).toBe((trace.initial.pageNumber ?? 1) + 1);
    expect(final.cfi).not.toBe(trace.initial.cfi);
  }
});

function verifyContinuous(result: Awaited<ReturnType<typeof runTrace>>, effect: Effect) {
  const { trace, final } = result;
  const moving = trace.wheels.filter((wheel) => Math.abs(wheel.delta) > 0);
  const maxInputGap = Math.max(
    0,
    ...moving.slice(1).map((wheel, index) => wheel.time - moving[index]!.time),
  );
  const cumulativeInput = (sample: FrameSample) =>
    trace.wheels.slice(0, sample.wheelCount).reduce((sum, wheel) => sum + wheel.delta, 0);
  const pauseSamples = trace.pauses.map(({ requestedDuration, start, end }) => ({
    requestedDuration,
    elapsed: end.time - start.time,
    sampleCount: end.index - start.index + 1,
    maxSampleGap: Math.max(
      0,
      ...trace.frames
        .slice(start.index + 1, end.index + 1)
        .map((sample) => sample.time - trace.frames[sample.index - 1]!.time),
    ),
    lastWheelToStart: start.time - (trace.wheels[start.wheelCount - 1]?.time ?? 0),
    endToNextWheel: (trace.wheels[end.wheelCount]?.time ?? trace.releasedAt) - end.time,
    lastWheelToNextWheel:
      (trace.wheels[end.wheelCount]?.time ?? trace.releasedAt) -
      (trace.wheels[end.wheelCount - 1]?.time ?? 0),
    samples: trace.frames.slice(start.index, end.index + 1).map((sample) => ({
      time: sample.time,
      wheelCount: sample.wheelCount,
      distance: sample.distance,
      input: cumulativeInput(sample),
      error: sample.distance - cumulativeInput(sample),
    })),
  }));
  console.log(
    JSON.stringify({
      effect,
      input: result.input,
      initialPage: trace.initial.pageNumber,
      readyTimes: trace.readyTimes,
      maxInputGap,
      pauses: pauseSamples,
    }),
  );
  expect(
    maxInputGap,
    'input producer must keep actual delivered nonzero packet gaps below the 200ms idle boundary',
  ).toBeLessThan(200);
  const held = trace.frames.filter((frame) => frame.time < trace.releasedAt);
  expect(held.length).toBeGreaterThan(20);
  expect(held.every((frame) => frame.cfi === trace.initial.cfi)).toBe(true);
  expect(trace.writes.filter((write) => write.time < trace.releasedAt)).toEqual([]);
  expect(trace.pauses).toHaveLength(1);
  for (const { requestedDuration, start, end } of trace.pauses) {
    expect(
      end.time - start.time,
      'pause must not finish before its requested duration',
    ).toBeGreaterThanOrEqual(requestedDuration - 1);
    for (const sample of trace.frames.slice(start.index, end.index + 1)) {
      expect(
        Math.abs(sample.distance - cumulativeInput(sample)),
        `pause following at ${sample.time}ms with ${sample.wheelCount} delivered packets`,
      ).toBeLessThan(1.1);
    }
    if (start.wheelCount === end.wheelCount)
      expect(
        Math.abs(end.distance - start.distance),
        'pause boundaries without new input must stay still',
      ).toBeLessThan(1.1);
  }
  const preparedAt = effect === 'stack' ? trace.readyTimes[0] : 0;
  expect(preparedAt).toBeDefined();
  const following = held.filter(
    (frame) => frame.time > (preparedAt ?? 0) + 20 && frame.phase !== 'start',
  );
  for (const frame of following) {
    const input = cumulativeInput(frame);
    expect(
      Math.abs(frame.distance - input),
      `first-frame following at ${frame.time}ms/${frame.phase}`,
    ).toBeLessThan(1.1);
  }
  expect(following.some((frame) => frame.phase === 'reverse')).toBe(true);
  expect(final.pageNumber).toBe((trace.initial.pageNumber ?? 1) + 1);
  expect(final.cfi).not.toBe(trace.initial.cfi);
  expect(new Set(trace.writes.map((write) => write.checkpoint.cfi))).toEqual(new Set([final.cfi]));
  if (result.input === 'cdp') {
    expect(trace.wheels.every((wheel) => wheel.trusted)).toBe(true);
    const afterReady = trace.wheels.filter((wheel) => wheel.time > (preparedAt ?? 0) + 20);
    expect(afterReady.length).toBeGreaterThan(20);
    expect(
      afterReady.every((wheel) => wheel.accepted),
      'trusted wheel packets after native readiness must remain accepted',
    ).toBe(true);
  }
}

for (const effect of ['slide', 'stack'] as const) {
  for (const total of [8, 24, 48]) {
    test(`${effect}: light ${total}px contact cancels on first and later pages`, async ({
      page,
    }, testInfo) => {
      await open(page, effect);
      const delta = total === 8 ? 2 : total === 24 ? 3 : 4;
      const interval = total === 8 ? 8 : total === 24 ? 12 : 16;
      const protocol = [
        { phase: 'light-contact', deltas: Array<number>(total / delta).fill(delta), interval },
      ];
      const first = await runTrace(page, protocol, 'body');
      await laterPage(page);
      const later = await runTrace(page, protocol, 'body');
      await testInfo.attach('light-contact-first-later', {
        body: JSON.stringify({ first, later }, null, 2),
        contentType: 'application/json',
      });
      for (const result of [first, later]) {
        expect(result.trace.frames.length).toBeGreaterThan(10);
        expect(result.final.cfi).toBe(result.trace.initial.cfi);
        expect(result.trace.writes).toEqual([]);
        expect(
          Math.abs(result.trace.frames.at(-1)?.distance ?? Number.POSITIVE_INFINITY),
        ).toBeLessThan(1.1);
      }
    });
  }
  for (const gap of [100, 140]) {
    test(`${effect}: slow contact stays owned across ${gap}ms pause, reversal and decay`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(60_000);
      await open(page, effect);
      const extent = await page
        .getByTestId('epub-container')
        .locator(':scope > .epub-container')
        .evaluate((element) => element.clientWidth);
      const first = await runTrace(page, slowProtocol(extent, gap), 'body');
      await laterPage(page);
      const later = await runTrace(page, slowProtocol(extent, gap), 'body');
      await testInfo.attach('pixel-contact-first-later', {
        body: JSON.stringify({ nominalCadence: '8–16 ms', first, later }, null, 2),
        contentType: 'application/json',
      });
      verifyContinuous(first, effect);
      verifyContinuous(later, effect);
    });
  }
  test(`${effect}: trusted CDP trackpad packets keep reaching the reader after native readiness`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await open(page, effect);
    const extent = await page
      .getByTestId('epub-container')
      .locator(':scope > .epub-container')
      .evaluate((element) => element.clientWidth);
    const first = await runTrace(page, slowProtocol(extent, 120), 'cdp');
    await laterPage(page);
    const later = await runTrace(page, slowProtocol(extent, 120), 'cdp');
    await testInfo.attach('trusted-hit-test-first-later', {
      body: JSON.stringify(
        { nominalCadence: '8–16 ms; actual renderer event times recorded', first, later },
        null,
        2,
      ),
      contentType: 'application/json',
    });
    verifyContinuous(first, effect);
    verifyContinuous(later, effect);
  });
}
