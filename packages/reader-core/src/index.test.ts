import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHorizontalPageScrollGesture, focusFontWeight, focusPrefixLength } from './index';

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
    gesture.handleWheel(wheel);
    vi.advanceTimersByTime(90);

    let time = performance.now();
    for (let index = 0; index < 240 && frames.size > 0; index += 1) {
      const [id, callback] = frames.entries().next().value as [number, FrameRequestCallback];
      frames.delete(id);
      time += 16;
      callback(time);
    }

    expect(scroller.scrollLeft).toBe(1_120);
    gesture.dispose();
  });
});
