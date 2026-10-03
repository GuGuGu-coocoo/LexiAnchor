import path from 'node:path';

import { expect, test, type Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';

import {
  createIsolatedProfile,
  launchSourceApp,
  removeIsolatedProfile,
  stopSourceApp,
} from '../../tools/reader-source-smoke.mjs';
import { waitForEpubLayout, waitForEpubOpen } from './epub-readiness';

// Opt-in source Electron QA only. CDP mouse input is not an NSEvent/trackpad
// phase replay, but it exercises Chromium hit testing instead of dispatchEvent.
const applicationEntry = process.env.LEXIANCHOR_SOURCE_APP;
const fixture = path.resolve('packages/test-fixtures/generated/lexianchor-spike.epub');

interface Checkpoint {
  cfi?: string;
  href?: string;
  pageNumber?: number;
}

interface Probe {
  stage: string;
  running: boolean;
  wheels: {
    sequence: number;
    stage: string;
    at: number;
    source: string;
    trusted: boolean;
    cancelable: boolean;
    target: string;
    prevented: boolean;
    deltaX: number;
    deltaY: number;
  }[];
  frames: {
    stage: string;
    at: number;
    oldTime: number | null;
    scrollLeft: number;
    inputDistance: number;
    wheelCount: number;
    cfi?: string;
  }[];
  transitions: {
    stage: string;
    at: number;
    readyAt?: number;
    readyWheelCount?: number;
    finishedAt?: number;
    error?: string;
  }[];
  writes: { stage: string; at: number; wheelCount: number; value: Checkpoint }[];
}

type ProbeWindow = Window & typeof globalThis & { __trackpadRoutingProbe: Probe };

async function bounded<T>(promise: Promise<T>, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('QA diagnostic timed out.')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function checkpoint(page: Page): Promise<Checkpoint> {
  return page.evaluate(() => {
    const keys = Object.keys(localStorage).filter((key) =>
      key.startsWith('lexianchor:epub-location:'),
    );
    if (keys.length !== 1) throw new Error(`Expected one QA EPUB, found ${keys.length}.`);
    return JSON.parse(localStorage.getItem(keys[0]!) ?? '{}') as Checkpoint;
  });
}

async function quietCheckpoint(page: Page) {
  let last = '';
  let stableSince = 0;
  await expect
    .poll(
      async () => {
        const value = await checkpoint(page);
        // Include navigation/index metadata, not just CFI: late enrichment is a
        // checkpoint write too and must not be hidden by the input assertions.
        const serialized = JSON.stringify(value);
        if (!value.cfi || serialized !== last) {
          last = serialized;
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

async function installProbe(page: Page) {
  await page.evaluate(() => {
    const probe: Probe = {
      stage: 'setup',
      running: true,
      wheels: [],
      frames: [],
      transitions: [],
      writes: [],
    };
    (window as ProbeWindow).__trackpadRoutingProbe = probe;
    const currentCfi = () => {
      const key = Object.keys(localStorage).find((item) =>
        item.startsWith('lexianchor:epub-location:'),
      );
      return (JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as Checkpoint).cfi;
    };
    const save = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      save.call(this, key, value);
      if (key.startsWith('lexianchor:epub-location:'))
        probe.writes.push({
          stage: probe.stage,
          at: performance.now(),
          wheelCount: probe.wheels.length,
          value: JSON.parse(value) as Checkpoint,
        });
    };
    const documents = new WeakSet<Document>();
    const observe = (doc: Document, source: string) => {
      if (documents.has(doc)) return;
      documents.add(doc);
      doc.addEventListener(
        'wheel',
        (event) => {
          const sample = {
            sequence: probe.wheels.length + 1,
            stage: probe.stage,
            at: performance.now(),
            source,
            trusted: event.isTrusted,
            cancelable: event.cancelable,
            target: (event.target as Element | null)?.tagName ?? '',
            // A native event can run a microtask checkpoint between capture
            // and bubble listeners. Read the event's final flag at sample/
            // serialization time, not in a capture-scheduled microtask.
            get prevented() {
              return event.defaultPrevented;
            },
            deltaX: event.deltaX,
            deltaY: event.deltaY,
          };
          probe.wheels.push(sample);
        },
        { capture: true, passive: true },
      );
    };
    observe(document, 'host');
    const frames = new WeakSet<HTMLIFrameElement>();
    const discover = () => {
      for (const frame of document.querySelectorAll<HTMLIFrameElement>(
        '[data-testid="epub-container"] iframe',
      )) {
        const attach = () => {
          if (frame.contentDocument) observe(frame.contentDocument, 'iframe');
        };
        attach();
        if (!frames.has(frame)) {
          frames.add(frame);
          frame.addEventListener('load', attach);
        }
      }
    };
    discover();
    new MutationObserver(discover).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (update) => {
      const sample: Probe['transitions'][number] = {
        stage: probe.stage,
        at: performance.now(),
      };
      probe.transitions.push(sample);
      const transition = start(update);
      void transition.ready.then(
        () => {
          sample.readyAt = performance.now();
          sample.readyWheelCount = probe.wheels.length;
        },
        (error: unknown) => {
          sample.error = String(error);
        },
      );
      void transition.finished.then(
        () => {
          sample.finishedAt = performance.now();
        },
        () => undefined,
      );
      return transition;
    };
    const sampleFrame = (at: number) => {
      if (!probe.running) return;
      const scroller = document.querySelector<HTMLElement>(
        '[data-testid="epub-container"] > .epub-container',
      );
      const oldAnimation = document.getAnimations().find((animation) => {
        const effect = animation.effect as KeyframeEffect | null;
        return (
          effect?.pseudoElement === '::view-transition-old(lexianchor-page)' &&
          animation.playState === 'paused'
        );
      });
      const time = oldAnimation?.currentTime;
      probe.frames.push({
        stage: probe.stage,
        at,
        oldTime: typeof time === 'number' ? time : null,
        scrollLeft: scroller?.scrollLeft ?? -1,
        inputDistance: probe.wheels
          .filter((wheel) => wheel.stage === probe.stage && wheel.prevented)
          .reduce((sum, wheel) => sum + wheel.deltaX, 0),
        wheelCount: probe.wheels.length,
        cfi: currentCfi(),
      });
      requestAnimationFrame(sampleFrame);
    };
    requestAnimationFrame(sampleFrame);
  });
}

async function inputPoint(page: Page) {
  return page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-testid="epub-container"] > .epub-container',
    );
    if (!scroller) throw new Error('No actual EPUB scroller.');
    const box = scroller.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return {
      x,
      y,
      extent: scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
      hitTag: document.elementFromPoint(x, y)?.tagName,
    };
  });
}

async function setStage(page: Page, stage: string) {
  await page.evaluate((value) => {
    (window as ProbeWindow).__trackpadRoutingProbe.stage = value;
  }, stage);
}

async function evidence(page: Page, stage: string) {
  return page.evaluate((value) => {
    const probe = (window as ProbeWindow).__trackpadRoutingProbe;
    return {
      wheels: probe.wheels.filter((item) => item.stage === value),
      frames: probe.frames.filter((item) => item.stage === value),
      transitions: probe.transitions.filter((item) => item.stage === value),
      writes: probe.writes.filter((item) => item.stage === value),
    };
  }, stage);
}

test('source Electron stack routes continuous trusted wheel through VT and does not turn on a light touch', async () => {
  test.skip(!applicationEntry, 'Set LEXIANCHOR_SOURCE_APP to an isolated source-only build.');
  test.setTimeout(120_000);
  if (!applicationEntry) return;
  const profile = await createIsolatedProfile();
  let session: { app: ElectronApplication; page: Page } | undefined;
  let windowId: number | undefined;
  const testInfo = test.info();
  try {
    session = await launchSourceApp(applicationEntry, profile);
    const { app, page } = session;
    await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
    await page.locator('.import-button input[type="file"]').setInputFiles(fixture);
    await waitForEpubOpen(page);
    const panel = page.locator('details.reader-appearance-panel');
    await panel.locator('summary').click();
    await page
      .getByRole('combobox', { name: /^Layout$|^阅读布局$|^Disposition$/ })
      .selectOption('paginated');
    await page
      .getByRole('combobox', { name: /Page columns|页面栏数|Colonnes/ })
      .selectOption('single');
    await page
      .getByRole('combobox', { name: /Page turn effect|翻页效果|Effet de changement/ })
      .selectOption('stack');
    await waitForEpubLayout(page, {
      pageSpread: 'single',
      contentWidthPercent: 90,
      fontSizePercent: 100,
    });
    // Complete metadata quietness complements, not replaces, layout readiness.
    await quietCheckpoint(page);
    await installProbe(page);
    windowId = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length !== 1) throw new Error('Expected exactly one isolated QA window.');
      const window = windows[0]!;
      if (window.webContents.debugger.isAttached())
        throw new Error('QA debugger already attached.');
      window.webContents.debugger.attach('1.3');
      return window.id;
    });
    const send = (method: string, params: Record<string, unknown>) =>
      app.evaluate(
        async ({ BrowserWindow }, command) => {
          const window = BrowserWindow.fromId(command.windowId);
          if (!window) throw new Error('Owned QA window closed during CDP input.');
          await window.webContents.debugger.sendCommand(command.method, command.params);
        },
        { windowId: windowId!, method, params },
      );
    const before = await quietCheckpoint(page);
    const point = await inputPoint(page);
    expect(point.hitTag).toBe('IFRAME');
    expect(before.cfi).toMatch(/^epubcfi\(/);
    await setStage(page, 'continuous');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await send('Input.synthesizeScrollGesture', {
      x: point.x,
      y: point.y,
      xDistance: -point.extent * 0.5,
      yDistance: 0,
      speed: 160,
      preventFling: true,
      gestureSourceType: 'mouse',
      interactionMarkerName: 'lexianchor-stack-trusted-slow-drag',
    });
    // Observe a fixed window: do not poll past a premature or extra commit.
    await page.waitForTimeout(1_400);
    const continuous = await evidence(page, 'continuous');
    const after = await checkpoint(page);
    const afterPoint = await inputPoint(page);
    await testInfo.attach('stack-trusted-continuous-input', {
      body: JSON.stringify({ before, point, after, afterPoint, ...continuous }, null, 2),
      contentType: 'application/json',
    });
    const wheels = continuous.wheels.filter((item) => Math.abs(item.deltaX) > 0);
    expect(wheels.length).toBeGreaterThan(10);
    expect(wheels.every((item) => item.trusted)).toBe(true);
    expect(wheels.some((item) => item.source === 'iframe')).toBe(true);
    const ready = continuous.transitions.find((item) => item.readyAt !== undefined);
    const readyAt = ready?.readyAt;
    expect(readyAt, 'A real stack ViewTransition must become ready.').toBeDefined();
    const postReady = wheels.filter((item) => item.sequence > ready!.readyWheelCount!);
    expect(
      postReady.length,
      'Input must continue after native VT hit testing changes.',
    ).toBeGreaterThan(4);
    expect(
      postReady.every((item) => item.prevented),
      'Every routed post-ready horizontal input must be accepted.',
    ).toBe(true);
    const firstInputSequence = wheels[0]!.sequence;
    const lastInputSequence = wheels.at(-1)!.sequence;
    const lastInputAt = wheels.at(-1)!.at;
    expect(lastInputAt - readyAt!).toBeGreaterThan(300);
    expect(
      Math.max(...postReady.slice(1).map((item, index) => item.at - postReady[index]!.at)),
      'Accepted input must remain continuous, not pause until an idle commit.',
    ).toBeLessThan(200);
    const inputFrames = continuous.frames.filter(
      (item) =>
        item.wheelCount > ready!.readyWheelCount! &&
        item.wheelCount < lastInputSequence &&
        item.oldTime !== null,
    );
    expect(inputFrames.length).toBeGreaterThan(5);
    expect(new Set(inputFrames.map((item) => Math.round(item.oldTime!))).size).toBeGreaterThan(5);
    expect(
      inputFrames.every((item) => item.cfi === before.cfi),
      'Preview must not commit a CFI while input is active.',
    ).toBe(true);
    expect(
      inputFrames.every((item) => {
        const acceptedDistance = continuous.wheels
          .filter((wheel) => wheel.sequence <= item.wheelCount && wheel.prevented)
          .reduce((sum, wheel) => sum + wheel.deltaX, 0);
        return (
          item.inputDistance === acceptedDistance &&
          Math.abs((item.oldTime! / 1_000) * point.extent - acceptedDistance) <= 1.1
        );
      }),
      'The old sheet must track accepted distance in each presentation frame.',
    ).toBe(true);
    expect(
      continuous.writes.filter(
        (item) => item.wheelCount >= firstInputSequence && item.wheelCount < lastInputSequence,
      ),
    ).toEqual([]);
    expect(after.href).toBe(before.href);
    expect(after.pageNumber).toBe(before.pageNumber! + 1);
    expect(after.cfi).not.toBe(before.cfi);
    expect(Math.abs(afterPoint.scrollLeft - point.scrollLeft - point.extent)).toBeLessThanOrEqual(
      1.1,
    );
    expect(
      new Set(continuous.writes.map((item) => item.value.cfi).filter((cfi) => cfi !== before.cfi))
        .size,
    ).toBe(1);

    for (const distance of [8, 24, 48]) {
      const stage = `light-${distance}`;
      const tapBefore = await checkpoint(page);
      const tapPoint = await inputPoint(page);
      await setStage(page, stage);
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: tapPoint.x,
        y: tapPoint.y,
        deltaX: distance,
        deltaY: 0,
      });
      await page.waitForTimeout(1_400);
      const tap = await evidence(page, stage);
      const tapAfter = await checkpoint(page);
      const tapAfterPoint = await inputPoint(page);
      await testInfo.attach(`stack-trusted-${stage}`, {
        body: JSON.stringify({ tapBefore, tapPoint, tapAfter, tapAfterPoint, ...tap }, null, 2),
        contentType: 'application/json',
      });
      const input = tap.wheels.filter((item) => Math.abs(item.deltaX) > 0);
      expect(input.length).toBeGreaterThan(0);
      expect(input.every((item) => item.trusted && item.prevented)).toBe(true);
      expect(tapAfter.cfi, `${distance}px light input must cancel, not turn.`).toBe(tapBefore.cfi);
      expect(tapAfter.pageNumber).toBe(tapBefore.pageNumber);
      expect(tap.writes, 'A cancelled light gesture must not write a checkpoint.').toEqual([]);
      expect(Math.abs(tapAfterPoint.scrollLeft - tapPoint.scrollLeft)).toBeLessThanOrEqual(1.1);
    }
  } finally {
    try {
      if (session) {
        await bounded(
          session.page.evaluate(() => {
            const probe = (window as Partial<ProbeWindow>).__trackpadRoutingProbe;
            if (probe) probe.running = false;
          }),
        ).catch(() => undefined);
        const fullProbe = await bounded(
          session.page.evaluate(() => (window as Partial<ProbeWindow>).__trackpadRoutingProbe),
        ).catch((error: unknown) => ({ diagnosticError: String(error) }));
        await testInfo
          .attach('stack-routing-full-probe', {
            body: JSON.stringify(fullProbe, null, 2),
            contentType: 'application/json',
          })
          .catch(() => undefined);
        if (windowId !== undefined)
          await bounded(
            session.app.evaluate(({ BrowserWindow }, id) => {
              const window = BrowserWindow.fromId(id);
              if (window?.webContents.debugger.isAttached()) window.webContents.debugger.detach();
            }, windowId),
          ).catch(() => undefined);
      }
    } finally {
      // Never let a failed/stalled renderer diagnostic bypass owned cleanup.
      // If the helper cannot stop this child, retain its profile for safety.
      if (session) await bounded(stopSourceApp(session, 'kill'), 10_000);
      await removeIsolatedProfile(profile);
    }
  }
});

test('source Electron stack turns successive pages at one stationary input point without clicks', async () => {
  test.skip(!applicationEntry, 'Set LEXIANCHOR_SOURCE_APP to an isolated source-only build.');
  test.setTimeout(90_000);
  if (!applicationEntry) return;
  const profile = await createIsolatedProfile();
  let session: { app: ElectronApplication; page: Page } | undefined;
  let windowId: number | undefined;
  const testInfo = test.info();
  try {
    session = await launchSourceApp(applicationEntry, profile);
    const { app, page } = session;
    await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
    await page.locator('.import-button input[type="file"]').setInputFiles(fixture);
    await waitForEpubOpen(page);
    await page.locator('details.reader-appearance-panel > summary').click();
    await page
      .getByRole('combobox', { name: /^Layout$|^阅读布局$|^Disposition$/ })
      .selectOption('paginated');
    await page
      .getByRole('combobox', { name: /Page columns|页面栏数|Colonnes/ })
      .selectOption('single');
    await page
      .getByRole('combobox', { name: /Page turn effect|翻页效果|Effet de changement/ })
      .selectOption('stack');
    await waitForEpubLayout(page, {
      pageSpread: 'single',
      contentWidthPercent: 90,
      fontSizePercent: 100,
    });
    await quietCheckpoint(page);
    await installProbe(page);
    windowId = await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length !== 1) throw new Error('Expected exactly one isolated QA window.');
      const window = windows[0]!;
      if (window.webContents.debugger.isAttached())
        throw new Error('QA debugger already attached.');
      window.webContents.debugger.attach('1.3');
      return window.id;
    });
    const send = (method: string, params: Record<string, unknown>) =>
      app.evaluate(
        async ({ BrowserWindow }, command) => {
          const window = BrowserWindow.fromId(command.windowId);
          if (!window) throw new Error('Owned QA window closed during CDP input.');
          await window.webContents.debugger.sendCommand(command.method, command.params);
        },
        { windowId: windowId!, method, params },
      );
    const point = await inputPoint(page);
    // Position the pointer only once. No click, mouse move, keyboard, Next,
    // TOC navigation or renderer reset is allowed between these gestures.
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    for (const [index, direction] of [1, 1, 1, 1, -1, -1].entries()) {
      const stage = `successive-${index}-${direction}`;
      const before = await checkpoint(page);
      const beforePoint = await inputPoint(page);
      await setStage(page, stage);
      await send('Input.synthesizeScrollGesture', {
        x: point.x,
        y: point.y,
        xDistance: -direction * point.extent * 0.55,
        yDistance: 0,
        speed: 640,
        preventFling: true,
        gestureSourceType: 'mouse',
      });
      // Start the next gesture as soon as this one commits, without the long
      // idle window used by the separate light-touch cancellation check.
      await expect
        .poll(async () => (await checkpoint(page)).cfi, { timeout: 1_400, intervals: [10] })
        .not.toBe(before.cfi);
      const trace = await evidence(page, stage);
      const after = await checkpoint(page);
      const afterPoint = await inputPoint(page);
      await testInfo.attach(stage, {
        body: JSON.stringify({ before, beforePoint, after, afterPoint, ...trace }, null, 2),
        contentType: 'application/json',
      });
      const wheels = trace.wheels.filter((wheel) => Math.abs(wheel.deltaX) > 0);
      expect(wheels.length, `${stage}: same-point input must still be delivered`).toBeGreaterThan(
        10,
      );
      expect(wheels.every((wheel) => wheel.trusted && wheel.prevented)).toBe(true);
      expect(trace.transitions).toHaveLength(1);
      expect(trace.transitions[0]?.readyAt).toBeDefined();
      expect(
        trace.transitions[0]?.finishedAt,
        `${stage}: snapshot must release without a click`,
      ).toBeDefined();
      expect(after.href).toBe(before.href);
      expect(
        after.pageNumber,
        `${stage}: each independent gesture must turn exactly one page`,
      ).toBe(before.pageNumber! + direction);
      expect(after.cfi).not.toBe(before.cfi);
      expect(
        Math.abs(afterPoint.scrollLeft - beforePoint.scrollLeft - direction * point.extent),
      ).toBeLessThanOrEqual(1.1);
      const lastSequence = wheels.at(-1)!.sequence;
      const held = trace.frames.filter(
        (frame) => frame.wheelCount > wheels[0]!.sequence && frame.wheelCount < lastSequence,
      );
      expect(held.length).toBeGreaterThan(2);
      expect(held.every((frame) => frame.cfi === before.cfi)).toBe(true);
      expect(trace.writes.filter((write) => write.wheelCount < lastSequence)).toEqual([]);
    }
  } finally {
    try {
      if (session) {
        const probe = await bounded(
          session.page.evaluate(() => {
            const probe = (window as Partial<ProbeWindow>).__trackpadRoutingProbe;
            if (probe) probe.running = false;
            return probe;
          }),
        ).catch((error: unknown) => ({ diagnosticError: String(error) }));
        await testInfo
          .attach('successive-full-probe', {
            body: JSON.stringify(probe, null, 2),
            contentType: 'application/json',
          })
          .catch(() => undefined);
        if (windowId !== undefined)
          await bounded(
            session.app.evaluate(({ BrowserWindow }, id) => {
              const window = BrowserWindow.fromId(id);
              if (window?.webContents.debugger.isAttached()) window.webContents.debugger.detach();
            }, windowId),
          ).catch(() => undefined);
      }
    } finally {
      if (session) await bounded(stopSourceApp(session, 'kill'), 10_000);
      await removeIsolatedProfile(profile);
    }
  }
});
