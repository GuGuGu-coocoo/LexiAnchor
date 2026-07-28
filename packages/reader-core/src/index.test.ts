import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createHorizontalPageScrollGesture,
  createStackedPageScrollGesture,
  focusFontWeight,
  focusPrefixLength,
} from './index';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('focus highlighting strength', () => {
  it('increases the emphasized prefix without exceeding the word', () => {
    expect(focusPrefixLength(10, 'light')).toBe(4);
    expect(focusPrefixLength(10, 'medium')).toBe(5);
    expect(focusPrefixLength(10, 'strong')).toBe(6);
    expect(focusPrefixLength(3, 'light')).toBe(1);
    expect(focusPrefixLength(3, 'strong')).toBe(2);
    expect(focusPrefixLength(0, 'strong')).toBe(0);
  });

  it('uses progressively stronger visual weights', () => {
    expect(focusFontWeight('light')).toBeLessThan(focusFontWeight('medium'));
    expect(focusFontWeight('medium')).toBeLessThan(focusFontWeight('strong'));
  });
});

describe('continuous page gesture', () => {
  it('starts an interrupted gesture from the current visible page', () => {
    vi.useFakeTimers();
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1 });

    const scroller = {
      scrollLeft: 0,
      scrollWidth: 5_000,
      clientWidth: 1_000,
    } as HTMLElement;
    const gesture = createHorizontalPageScrollGesture({
      getScroller: () => scroller,
      getPageExtent: () => 1_000,
    });
    const wheel = {
      deltaX: 120,
      deltaY: 2,
      deltaMode: 0,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent;

    gesture.handleWheel(wheel);
    vi.advanceTimersByTime(90);
    scroller.scrollLeft = 1_000;
    gesture.handleWheel(wheel);
    vi.advanceTimersByTime(90);

    let time = performance.now();
    for (let index = 0; index < 240 && frames.size > 0; index += 1) {
      const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback];
      frames.delete(id);
      time += 16;
      callback(time);
    }

    expect(scroller.scrollLeft).toBe(2_000);
    gesture.dispose();
  });
});

describe('stacked page gesture', () => {
  it('slides the captured top sheet away and commits the page underneath', async () => {
    vi.useFakeTimers();
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1 });

    const pauseAnimation = vi.fn();
    const cancelAnimation = vi.fn();
    const sheetAnimation = {
      currentTime: 0,
      pause: pauseAnimation,
      cancel: cancelAnimation,
    } as unknown as Animation;
    const skipTransition = vi.fn();
    const update = vi.fn();
    const ownerDocument = {
      documentElement: {
        animate: vi.fn(() => sheetAnimation),
      },
      startViewTransition: vi.fn((callback: () => void) => {
        callback();
        return {
          ready: Promise.resolve(),
          finished: Promise.resolve(),
          updateCallbackDone: Promise.resolve(),
          types: new Set<string>(),
          skipTransition,
        };
      }),
    } as unknown as Document;
    const classes = new Set<string>();
    const scroller = {
      scrollLeft: 0,
      scrollWidth: 5_000,
      clientWidth: 1_000,
      ownerDocument,
      style: { viewTransitionName: '' },
      classList: {
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
      },
    } as unknown as HTMLElement;
    const gesture = createStackedPageScrollGesture({
      getScroller: () => scroller,
      getPageExtent: () => 1_000,
      onSettled: update,
    });
    const wheel = {
      deltaX: 420,
      deltaY: 2,
      deltaMode: 0,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent;

    gesture.handleWheel(wheel);
    await Promise.resolve();
    expect(scroller.scrollLeft).toBe(1_000);
    expect(classes.has('epub-page-stack-transition')).toBe(true);
    expect(pauseAnimation).toHaveBeenCalledOnce();
    expect(sheetAnimation.currentTime).toBe(420);

    gesture.handleWheel({
      ...wheel,
      deltaX: 80,
      preventDefault: vi.fn(),
    });
    expect(sheetAnimation.currentTime).toBe(500);

    vi.advanceTimersByTime(160);
    let time = performance.now();
    for (let index = 0; index < 240 && frames.size > 0; index += 1) {
      const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback];
      frames.delete(id);
      time += 16;
      callback(time);
    }

    expect(scroller.scrollLeft).toBe(1_000);
    expect(update).toHaveBeenCalledWith(1);
    expect(skipTransition).toHaveBeenCalledOnce();
    expect(classes.has('epub-page-stack-transition')).toBe(false);
    gesture.dispose();
  });

  it('starts a new sheet when another gesture arrives during the previous settle', async () => {
    vi.useFakeTimers();
    let frameId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frameId += 1;
      frames.set(frameId, callback);
      return frameId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1 });

    const finishedResolvers: Array<() => void> = [];
    const startViewTransition = vi.fn((callback: () => void) => {
      callback();
      let resolveFinished: () => void = () => {};
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      finishedResolvers.push(resolveFinished);
      return {
        ready: Promise.resolve(),
        finished,
        updateCallbackDone: Promise.resolve(),
        types: new Set<string>(),
        skipTransition: vi.fn(),
      };
    });
    const ownerDocument = {
      documentElement: {
        animate: vi.fn(
          () =>
            ({
              currentTime: 0,
              pause: vi.fn(),
              cancel: vi.fn(),
            }) as unknown as Animation,
        ),
      },
      startViewTransition,
    } as unknown as Document;
    const scroller = {
      scrollLeft: 0,
      scrollWidth: 5_000,
      clientWidth: 1_000,
      ownerDocument,
      style: { viewTransitionName: '' },
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    } as unknown as HTMLElement;
    const gesture = createStackedPageScrollGesture({
      getScroller: () => scroller,
      getPageExtent: () => 1_000,
    });
    const wheel = {
      deltaX: 520,
      deltaY: 2,
      deltaMode: 0,
      preventDefault: vi.fn(),
    } as unknown as WheelEvent;

    gesture.handleWheel(wheel);
    await Promise.resolve();
    vi.advanceTimersByTime(160);
    expect(frames.size).toBeGreaterThan(0);

    gesture.handleWheel(wheel);
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    finishedResolvers[0]?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(startViewTransition).toHaveBeenCalledTimes(2);
    expect(scroller.scrollLeft).toBe(2_000);
    gesture.dispose();
  });
});
