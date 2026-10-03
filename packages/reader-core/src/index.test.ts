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

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function microtasks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function fixture({
  stacked = true,
  immediateUpdate = true,
  viewTransitions = true,
  throwCapture = false,
  throwAnimation = false,
  reducedMotion = false,
  integerScroll = false,
  pageExtent = 1_000,
  preparePage,
}: {
  stacked?: boolean;
  immediateUpdate?: boolean;
  viewTransitions?: boolean;
  throwCapture?: boolean;
  throwAnimation?: boolean;
  reducedMotion?: boolean;
  integerScroll?: boolean;
  pageExtent?: number;
  preparePage?: (direction: -1 | 1, signal: AbortSignal) => void | Promise<void>;
} = {}) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: reducedMotion }));
  vi.stubGlobal('WheelEvent', { DOM_DELTA_LINE: 1, DOM_DELTA_PAGE: 2 });
  const classes = new Set<string>();
  const rootClasses = new Set<string>();
  const order: string[] = [];
  const writes: number[] = [];
  const animations: Array<{
    currentTime: number;
    keyframes: Keyframe[];
    cancelled: boolean;
    pause: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const transitions: Array<{
    ready: ReturnType<typeof deferred>;
    finished: ReturnType<typeof deferred>;
    update: () => void;
    origin: number;
    skip: ReturnType<typeof vi.fn>;
  }> = [];
  let position = 2_000;
  let animationFails = throwAnimation;
  const scroller = {
    get scrollLeft() {
      return position;
    },
    set scrollLeft(value: number) {
      const clamped = Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, value));
      position = integerScroll ? Math.round(clamped) : clamped;
      writes.push(position);
      order.push('scroll');
    },
    scrollWidth: 6_000,
    clientWidth: pageExtent,
    style: { viewTransitionName: 'original' },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
    ownerDocument: {
      documentElement: {
        classList: {
          add: (name: string) => rootClasses.add(name),
          remove: (name: string) => rootClasses.delete(name),
        },
        animate: vi.fn((keyframes: Keyframe[]) => {
          if (animationFails) throw new Error('animation unavailable');
          const animation = {
            currentTime: 0,
            keyframes,
            cancelled: false,
            pause: vi.fn(),
            cancel: vi.fn(() => {
              animation.cancelled = true;
            }),
          };
          animations.push(animation);
          return animation;
        }),
      },
      startViewTransition: viewTransitions
        ? vi.fn((callback: () => void) => {
            order.push('capture');
            if (throwCapture) throw new Error('capture unavailable');
            const ready = deferred();
            const finished = deferred();
            let updated = false;
            const transition = {
              ready,
              finished,
              origin: position,
              skip: vi.fn(),
              update: () => {
                if (!updated) {
                  updated = true;
                  callback();
                }
              },
            };
            transitions.push(transition);
            if (immediateUpdate) transition.update();
            return {
              ready: ready.promise,
              finished: finished.promise,
              updateCallbackDone: Promise.resolve(),
              skipTransition: transition.skip,
            };
          })
        : undefined,
    },
  } as unknown as HTMLElement;
  let owner: HTMLElement | null = scroller;
  let enabled = true;
  const started = vi.fn(() => order.push('start'));
  const settled = vi.fn();
  const options = {
    getScroller: () => owner,
    getPageExtent: () => pageExtent,
    isEnabled: () => enabled,
    shouldPrearm: () => false,
    onInteractionStart: started,
    preparePage: preparePage
      ? (direction: -1 | 1, signal: AbortSignal) => {
          order.push('prepare');
          return preparePage(direction, signal);
        }
      : undefined,
    onSettled: settled,
  };
  const gesture = stacked
    ? createStackedPageScrollGesture(options)
    : createHorizontalPageScrollGesture(options);
  const wheel = (deltaX: number, extra: Partial<WheelEvent> = {}) =>
    gesture.handleWheel({
      deltaX,
      deltaY: 0,
      deltaMode: 0,
      preventDefault: vi.fn(),
      ...extra,
    } as unknown as WheelEvent);
  const stepFrame = (milliseconds = 16) => {
    vi.advanceTimersByTime(milliseconds);
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  };
  const settleFrames = (stopAtCommit = false) => {
    for (let index = 0; index < 240 && frames.size > 0; index += 1) {
      stepFrame();
      if (stopAtCommit && settled.mock.calls.length > 0) break;
    }
  };
  const presentation = () => {
    const animation = animations.at(-1);
    if (!stacked || !animation || animation.cancelled) return scroller.scrollLeft - 2_000;
    const endpoint = Number(
      /translate3d\(([-.\d]+)px/.exec(String(animation.keyframes[1]?.transform))?.[1] ?? '0',
    );
    return (-endpoint * animation.currentTime) / 1_000;
  };
  const ready = async () => {
    transitions.at(-1)?.ready.resolve();
    await microtasks();
  };
  return {
    scroller,
    gesture,
    wheel,
    ready,
    transitions,
    animations,
    frames,
    classes,
    rootClasses,
    started,
    settled,
    order,
    writes,
    stepFrame,
    settleFrames,
    presentation,
    setOwner: (value: HTMLElement | null) => {
      owner = value;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setThrowAnimation: (value: boolean) => {
      animationFails = value;
    },
  };
}

describe('continuous page gesture', () => {
  it('directly follows input and commits once after settling', () => {
    const f = fixture({ stacked: false });
    f.wheel(180);
    expect(f.scroller.scrollLeft).toBe(2_180);
    expect(f.order[0]).toBe('start');
    vi.advanceTimersByTime(100);
    f.settleFrames();
    expect(f.scroller.scrollLeft).toBe(3_000);
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(1);
    f.gesture.dispose();
  });

  it('starts a later gesture from a renderer-rebased visible page', () => {
    const f = fixture({ stacked: false });
    f.wheel(120);
    vi.advanceTimersByTime(100);
    f.scroller.scrollLeft = 3_000;
    f.wheel(120);
    vi.advanceTimersByTime(100);
    f.settleFrames();
    expect(f.scroller.scrollLeft).toBe(4_000);
    expect(f.settled.mock.calls).toEqual([[0], [1]]);
    f.gesture.dispose();
  });

  it('invalidates an old spring without pulling a later navigation back', () => {
    const f = fixture({ stacked: false });
    f.wheel(180);
    vi.advanceTimersByTime(100);
    const staleFrames = [...f.frames.values()];
    f.gesture.invalidate?.();
    expect(f.scroller.scrollLeft).toBe(2_000);
    f.scroller.scrollLeft = 4_000;
    staleFrames.forEach((callback) => callback(performance.now() + 16));
    vi.runAllTimers();
    expect(f.scroller.scrollLeft).toBe(4_000);
    expect(f.settled).not.toHaveBeenCalled();
    f.gesture.dispose();
  });

  it('notifies cancellation once when a live renderer rebase abandons a spring', () => {
    const f = fixture({ stacked: false });
    f.wheel(180);
    vi.advanceTimersByTime(100);
    const staleFrames = [...f.frames.values()];
    f.scroller.scrollLeft = 4_000;
    f.stepFrame();
    expect(f.scroller.scrollLeft).toBe(4_000);
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(0);
    staleFrames.forEach((callback) => callback(performance.now() + 16));
    vi.runAllTimers();
    expect(f.scroller.scrollLeft).toBe(4_000);
    expect(f.frames.size).toBe(0);
    expect(f.settled).toHaveBeenCalledTimes(1);
    f.gesture.dispose();
  });

  it('commits a fresh forward burst after a reversed preview has cancelled', () => {
    const f = fixture({ stacked: false });
    f.wheel(180);
    f.wheel(-180);
    vi.advanceTimersByTime(100);
    f.settleFrames();
    expect(f.scroller.scrollLeft).toBe(2_000);
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(0);
    for (let index = 0; index < 10; index += 1) {
      f.wheel(55);
      vi.advanceTimersByTime(16);
    }
    expect(f.scroller.scrollLeft).toBe(2_550);
    vi.advanceTimersByTime(100);
    f.settleFrames();
    expect(f.scroller.scrollLeft).toBe(3_000);
    expect(f.settled.mock.calls).toEqual([[0], [1]]);
    expect(f.started).toHaveBeenCalledTimes(2);
    f.gesture.dispose();
  });

  it('finishes a slide spring even when the browser quantizes scrollLeft to integer pixels', () => {
    const f = fixture({ stacked: false, integerScroll: true, pageExtent: 938 });
    for (let index = 0; index < 10; index += 1) {
      f.wheel(938 * 0.055);
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(100);
    f.settleFrames();
    expect(f.scroller.scrollLeft).toBe(2_938);
    expect(f.frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(1);
    f.gesture.dispose();
  });

  it.each([1, -1])(
    'takes over an integer slide from within one pixel of the visible position (%i)',
    (direction) => {
      const f = fixture({ stacked: false, integerScroll: true, pageExtent: 938 });
      f.wheel(direction * 180);
      vi.advanceTimersByTime(100);
      f.stepFrame();
      const before = f.scroller.scrollLeft;
      const staleFrames = [...f.frames.values()];
      f.wheel(direction * 8);
      expect(Math.abs(f.scroller.scrollLeft - before - direction * 8)).toBeLessThanOrEqual(1);
      expect(f.settled).not.toHaveBeenCalled();
      const takenOver = f.scroller.scrollLeft;
      staleFrames.forEach((callback) => callback(performance.now() + 16));
      expect(f.scroller.scrollLeft).toBe(takenOver);
      vi.advanceTimersByTime(100);
      f.settleFrames();
      expect(f.scroller.scrollLeft).toBe(2_000 + direction * 938);
      expect(f.settled).toHaveBeenCalledExactlyOnceWith(direction);
      f.gesture.dispose();
    },
  );
});

describe('stacked page gesture', () => {
  it('captures on input, directly tracks the top sheet, and commits underneath once', async () => {
    const f = fixture();
    f.gesture.prepare?.();
    expect(f.transitions).toHaveLength(0);
    f.wheel(420);
    expect(f.order[0]).toBe('start');
    expect(f.transitions[0]?.origin).toBe(2_000);
    await f.ready();
    expect(f.presentation()).toBe(420);
    f.wheel(80);
    expect(f.presentation()).toBe(500);
    expect(f.scroller.scrollLeft).toBe(3_000);
    vi.advanceTimersByTime(180);
    f.settleFrames();
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.classes.size).toBe(0);
    expect(f.scroller.style.viewTransitionName).toBe('original');
    f.gesture.dispose();
  });

  it.each([1, -1])('reverses after ready around the same origin (%i)', async (direction) => {
    const f = fixture();
    f.wheel(direction * 40);
    await f.ready();
    f.wheel(direction * -80);
    expect(f.scroller.scrollLeft).toBe(2_000);
    expect(f.transitions[0]?.skip).toHaveBeenCalledOnce();
    f.stepFrame();
    await f.ready();
    expect(f.presentation()).toBe(direction * -40);
    expect(f.scroller.scrollLeft).toBe(2_000 - direction * 1_000);
    expect(f.transitions).toHaveLength(2);
    expect(f.transitions[0]?.origin).toBe(2_000);
    expect(f.transitions[1]?.origin).toBe(2_000);
    expect(f.animations[0]?.cancelled).toBe(true);
    f.wheel(direction);
    expect(f.presentation()).toBe(direction * -39);
    expect(f.settled).not.toHaveBeenCalled();
    f.gesture.dispose();
  });

  it.each([1, -1])(
    'consumes signed input before ready without the old direction resurfacing (%i)',
    async (direction) => {
      const f = fixture();
      f.wheel(direction * 40);
      f.wheel(direction * -80);
      await f.ready();
      f.stepFrame();
      await f.ready();
      expect(f.presentation()).toBe(direction * -40);
      expect(f.scroller.scrollLeft).toBe(2_000 - direction * 1_000);
      expect(f.transitions).toHaveLength(2);
      f.gesture.dispose();
    },
  );

  it('uses latest signed input when the update callback itself is delayed', async () => {
    const f = fixture({ immediateUpdate: false });
    f.wheel(40);
    f.wheel(-80);
    expect(f.scroller.scrollLeft).toBe(2_000);
    f.transitions[0]?.update();
    expect(f.scroller.scrollLeft).toBe(1_000);
    await f.ready();
    expect(f.presentation()).toBe(-40);
    f.gesture.dispose();
  });

  it('crosses zero repeatedly and does not confuse the last delta with net direction', async () => {
    const f = fixture();
    f.wheel(40);
    await f.ready();
    f.wheel(-40);
    expect(f.presentation()).toBe(0);
    expect(f.scroller.scrollLeft).toBe(2_000);
    f.wheel(-40);
    f.stepFrame();
    await f.ready();
    expect(f.presentation()).toBe(-40);
    f.wheel(100);
    f.stepFrame();
    await f.ready();
    expect(f.presentation()).toBe(60);
    expect(f.scroller.scrollLeft).toBe(3_000);
    f.wheel(-1);
    expect(f.presentation()).toBe(59);
    expect(f.transitions).toHaveLength(3);
    expect(f.started).toHaveBeenCalledTimes(1);
    f.gesture.dispose();
  });

  it.each([1, -1])(
    'takes over a settling sheet from its live presentation in both input directions (%i)',
    async (direction) => {
      const f = fixture();
      f.wheel(direction * 220);
      await f.ready();
      vi.advanceTimersByTime(180);
      f.stepFrame();
      const before = f.presentation();
      const staleFrames = [...f.frames.values()];
      f.wheel(direction * 8);
      expect(f.presentation()).toBeCloseTo(before + direction * 8, 5);
      expect(f.settled).not.toHaveBeenCalled();
      expect(f.transitions).toHaveLength(1);
      staleFrames.forEach((callback) => callback(performance.now() + 16));
      expect(f.presentation()).toBeCloseTo(before + direction * 8, 5);
      f.wheel(direction * -16);
      expect(f.presentation()).toBeCloseTo(before - direction * 8, 5);
      vi.advanceTimersByTime(180);
      f.settleFrames();
      expect(f.settled).toHaveBeenCalledTimes(1);
      f.gesture.dispose();
    },
  );

  it('cancels to its origin without exposing the opposite page from spring overshoot', async () => {
    const f = fixture();
    f.wheel(20);
    await f.ready();
    f.wheel(-18);
    vi.advanceTimersByTime(180);
    f.writes.length = 0;
    f.settleFrames();
    expect(f.scroller.scrollLeft).toBe(2_000);
    expect(f.writes.every((value) => value >= 2_000)).toBe(true);
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(0);
    f.gesture.dispose();
  });

  it('falls back from a finished transition at the live spring position', async () => {
    const f = fixture();
    f.wheel(220);
    await f.ready();
    vi.advanceTimersByTime(180);
    f.stepFrame();
    const before = f.presentation();
    expect(before).toBeGreaterThan(220);
    const staleFrames = [...f.frames.values()];
    f.transitions[0]?.finished.resolve();
    await microtasks();
    expect(f.scroller.scrollLeft).toBeCloseTo(2_000 + before, 5);
    expect(f.classes.size).toBe(0);
    expect(f.rootClasses.size).toBe(0);
    expect(f.scroller.style.viewTransitionName).toBe('original');
    staleFrames.forEach((callback) => callback(performance.now() + 16));
    expect(f.scroller.scrollLeft).toBeCloseTo(2_000 + before, 5);
    f.settleFrames();
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
    f.gesture.dispose();
  });

  it('preserves the applied takeover delta when reversing WAAPI creation throws', async () => {
    const f = fixture();
    f.wheel(220);
    await f.ready();
    vi.advanceTimersByTime(180);
    f.stepFrame();
    const before = f.presentation();
    const staleFrames = [...f.frames.values()];
    f.setThrowAnimation(true);
    f.wheel(-before - 40);
    f.stepFrame();
    await f.ready();
    expect(f.scroller.scrollLeft).toBeCloseTo(1_960, 5);
    expect(f.classes.size).toBe(0);
    expect(f.rootClasses.size).toBe(0);
    expect(f.scroller.style.viewTransitionName).toBe('original');
    staleFrames.forEach((callback) => callback(performance.now() + 16));
    expect(f.scroller.scrollLeft).toBeCloseTo(1_960, 5);
    expect(f.settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    f.settleFrames();
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(-1);
    expect(vi.getTimerCount()).toBe(0);
    f.gesture.dispose();
  });

  it('keeps input across a reversed recapture and rejects the old snapshot callbacks', async () => {
    const f = fixture();
    f.wheel(100);
    await f.ready();
    f.wheel(-200);
    f.wheel(-20);
    const old = f.transitions[0];
    old?.ready.resolve();
    old?.finished.resolve();
    await microtasks();
    expect(f.transitions).toHaveLength(2);
    expect(f.transitions[1]?.origin).toBe(2_000);
    f.wheel(-30);
    await f.ready();
    expect(f.presentation()).toBe(-150);
    expect(f.scroller.scrollLeft).toBe(1_000);
    expect(f.started).toHaveBeenCalledTimes(1);
    expect(f.settled).not.toHaveBeenCalled();
    vi.advanceTimersByTime(180);
    f.settleFrames();
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(-1);
    f.gesture.dispose();
  });

  it('invalidates a pending reversed recapture without reviving its buffered input', async () => {
    const f = fixture();
    f.wheel(100);
    await f.ready();
    f.wheel(-200);
    const staleFrames = [...f.frames.values()];
    f.gesture.invalidate?.();
    f.scroller.scrollLeft = 4_000;
    staleFrames.forEach((callback) => callback(performance.now() + 16));
    f.transitions[0]?.finished.resolve();
    await microtasks();
    vi.runAllTimers();
    expect(f.scroller.scrollLeft).toBe(4_000);
    expect(f.transitions).toHaveLength(1);
    expect(f.classes.size).toBe(0);
    expect(f.rootClasses.size).toBe(0);
    expect(f.frames.size).toBe(0);
    expect(f.settled).not.toHaveBeenCalled();
    f.gesture.dispose();
  });

  it('bounds ready waiting, drops late callbacks, and accepts the next gesture', async () => {
    const f = fixture({ immediateUpdate: false });
    f.wheel(40);
    vi.advanceTimersByTime(260);
    expect(f.classes.size).toBe(0);
    const before = f.scroller.scrollLeft;
    f.transitions[0]?.update();
    await f.ready();
    expect(f.scroller.scrollLeft).toBe(before);
    expect(f.animations).toHaveLength(0);
    f.settleFrames();
    expect(f.settled).toHaveBeenCalledTimes(1);
    f.stepFrame();
    f.wheel(40);
    expect(f.transitions).toHaveLength(2);
    f.gesture.dispose();
  });

  it.each(['reject', 'capture-throw', 'animation-throw'] as const)(
    'cleans a %s and uses the same invalidatable fallback',
    async (failure) => {
      const f = fixture({
        throwCapture: failure === 'capture-throw',
        throwAnimation: failure === 'animation-throw',
      });
      f.wheel(40);
      if (failure === 'reject') {
        f.transitions[0]?.ready.reject(new Error('ready failed'));
        await microtasks();
      } else if (failure === 'animation-throw') await f.ready();
      expect(f.classes.size).toBe(0);
      expect(f.scroller.scrollLeft).toBe(2_040);
      f.gesture.invalidate?.();
      expect(f.scroller.scrollLeft).toBe(2_000);
      vi.runAllTimers();
      f.settleFrames();
      expect(f.settled).not.toHaveBeenCalled();
      f.gesture.dispose();
    },
  );

  it('does not let a late update, ready or finished mutate an externally navigated page', async () => {
    const f = fixture({ immediateUpdate: false });
    f.wheel(40);
    f.gesture.invalidate?.();
    f.scroller.scrollLeft = 4_000;
    f.transitions[0]?.update();
    f.transitions[0]?.ready.resolve();
    f.transitions[0]?.finished.resolve();
    await microtasks();
    vi.runAllTimers();
    f.settleFrames();
    expect(f.scroller.scrollLeft).toBe(4_000);
    expect(f.animations).toHaveLength(0);
    expect(f.settled).not.toHaveBeenCalled();
    f.gesture.dispose();
  });

  it('releases a permanently pending finished after a frame and buffers signed next input', async () => {
    const f = fixture();
    f.wheel(420);
    await f.ready();
    vi.advanceTimersByTime(180);
    f.settleFrames(true);
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(1);
    f.wheel(40);
    f.wheel(-80);
    f.stepFrame();
    expect(f.transitions).toHaveLength(2);
    await f.ready();
    expect(f.presentation()).toBe(-40);
    expect(f.scroller.scrollLeft).toBe(2_000);
    f.gesture.dispose();
  });

  it('does not replay closing input after invalidation or mode changes', async () => {
    const f = fixture();
    f.wheel(420);
    await f.ready();
    vi.advanceTimersByTime(180);
    f.settleFrames(true);
    f.wheel(40);
    f.gesture.invalidate?.();
    f.setEnabled(false);
    f.scroller.scrollLeft = 4_000;
    vi.runAllTimers();
    f.settleFrames();
    f.transitions[0]?.finished.resolve();
    await microtasks();
    expect(f.scroller.scrollLeft).toBe(4_000);
    expect(f.transitions).toHaveLength(1);
    expect(f.settled).toHaveBeenCalledTimes(1);
    f.gesture.dispose();
  });

  it.each(['wheel', 'timer'] as const)(
    'releases a disabled active snapshot without explicit invalidation (%s)',
    async (trigger) => {
      const f = fixture({ immediateUpdate: false });
      f.wheel(40);
      f.setEnabled(false);
      if (trigger === 'wheel') f.wheel(10);
      else vi.advanceTimersByTime(180);
      expect(f.scroller.scrollLeft).toBe(2_000);
      expect(f.classes.size).toBe(0);
      expect(f.rootClasses.size).toBe(0);
      expect(f.scroller.style.viewTransitionName).toBe('original');
      expect(vi.getTimerCount()).toBe(0);
      f.transitions[0]?.update();
      f.transitions[0]?.ready.resolve();
      f.transitions[0]?.finished.resolve();
      await microtasks();
      f.settleFrames();
      expect(f.scroller.scrollLeft).toBe(2_000);
      expect(f.animations).toHaveLength(0);
      expect(f.settled).not.toHaveBeenCalled();
      f.setEnabled(true);
      f.wheel(40);
      expect(f.transitions).toHaveLength(2);
      f.gesture.dispose();
    },
  );

  it('cleans its owned scroller and never writes into a replacement', async () => {
    const f = fixture();
    f.wheel(40);
    f.setOwner(null);
    f.gesture.invalidate?.();
    f.transitions[0]?.ready.resolve();
    f.transitions[0]?.update();
    await microtasks();
    expect(f.classes.size).toBe(0);
    expect(f.scroller.style.viewTransitionName).toBe('original');
    expect(f.settled).not.toHaveBeenCalled();
    f.gesture.dispose();
  });

  it('keeps net input while preparing both requested directions before capture', async () => {
    const preparations: Array<{
      direction: number;
      signal: AbortSignal;
      gate: ReturnType<typeof deferred>;
    }> = [];
    const f = fixture({
      preparePage: (direction, signal) => {
        const gate = deferred();
        preparations.push({ direction, signal, gate });
        return gate.promise;
      },
    });
    f.wheel(40);
    f.wheel(-80);
    expect(f.transitions).toHaveLength(0);
    expect(f.order.slice(0, 2)).toEqual(['start', 'prepare']);
    preparations[0]?.gate.resolve();
    await microtasks();
    expect(preparations.map((item) => item.direction)).toEqual([1, -1]);
    preparations[1]?.gate.resolve();
    await microtasks();
    expect(preparations.every((item) => !item.signal.aborted)).toBe(true);
    expect(f.transitions).toHaveLength(1);
    await f.ready();
    expect(f.presentation()).toBe(-40);
    expect(f.scroller.scrollLeft).toBe(1_000);
    expect(f.started).toHaveBeenCalledTimes(1);
    f.gesture.dispose();
    expect(preparations.every((item) => item.signal.aborted)).toBe(true);
  });

  it('reads rebased pixels only after neighbour preparation', async () => {
    const f: ReturnType<typeof fixture> = fixture({
      preparePage: () => {
        Object.defineProperty(f.scroller, 'scrollWidth', {
          value: f.scroller.scrollWidth + 1_000,
          writable: true,
        });
        f.scroller.scrollLeft += 1_000;
      },
    });
    f.wheel(-40);
    await f.ready();
    expect(f.transitions[0]?.origin).toBe(3_000);
    expect(f.scroller.scrollLeft).toBe(2_000);
    expect(f.presentation()).toBe(-40);
    f.gesture.dispose();
  });

  it.each(['timeout', 'invalidate', 'dispose'] as const)(
    'aborts preparation on %s and ignores late completion',
    async (reason) => {
      const gate = deferred();
      let signal!: AbortSignal;
      const f = fixture({
        preparePage: (_direction, nextSignal) => {
          signal = nextSignal;
          return gate.promise;
        },
      });
      f.wheel(40);
      if (reason === 'timeout') vi.advanceTimersByTime(260);
      else if (reason === 'invalidate') f.gesture.invalidate?.();
      else f.gesture.dispose();
      expect(signal.aborted).toBe(true);
      const before = f.scroller.scrollLeft;
      gate.resolve();
      await microtasks();
      expect(f.scroller.scrollLeft).toBe(before);
      expect(f.transitions).toHaveLength(0);
      f.gesture.dispose();
    },
  );

  it.each(['reduced-motion', 'no-VT'] as const)(
    'retains cancellation semantics in %s fallback',
    (mode) => {
      const f = fixture({
        viewTransitions: mode !== 'no-VT',
        reducedMotion: mode === 'reduced-motion',
      });
      f.wheel(40);
      expect(f.scroller.scrollLeft).toBe(2_040);
      f.gesture.invalidate?.();
      expect(f.scroller.scrollLeft).toBe(2_000);
      expect(f.started).toHaveBeenCalledTimes(1);
      expect(f.settled).not.toHaveBeenCalled();
      expect(f.transitions).toHaveLength(0);
      expect(f.animations).toHaveLength(0);
      f.gesture.dispose();
    },
  );

  it('ignores zoom modifiers and normalizes page-sized wheel input', async () => {
    const f = fixture();
    f.wheel(1, { ctrlKey: true });
    f.wheel(1, { metaKey: true });
    expect(f.started).not.toHaveBeenCalled();
    f.wheel(0.2, { deltaMode: 2 });
    await f.ready();
    expect(f.presentation()).toBe(200);
    f.gesture.dispose();
  });

  it('ends a sub-threshold gesture without leaving a pending session', () => {
    const f = fixture();
    f.wheel(1);
    vi.advanceTimersByTime(180);
    expect(f.settled).toHaveBeenCalledExactlyOnceWith(0);
    f.wheel(40);
    expect(f.started).toHaveBeenCalledTimes(2);
    f.gesture.dispose();
  });
});
