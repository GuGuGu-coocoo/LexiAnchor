import { useEffect, useRef, type RefObject } from 'react';

interface HorizontalPageSwipeOptions {
  readonly enabled?: boolean;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
}

export function useHorizontalPageSwipe(
  targetRef: RefObject<HTMLElement | null>,
  { enabled = true, onNext, onPrevious }: HorizontalPageSwipeOptions,
): void {
  const callbacksRef = useRef({ onNext, onPrevious });

  useEffect(() => {
    callbacksRef.current = { onNext, onPrevious };
  }, [onNext, onPrevious]);

  useEffect(() => {
    const target = targetRef.current;
    if (!target || !enabled) {
      return;
    }

    let accumulatedDeltaX = 0;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;
    let lastNavigationAt = 0;

    function handleWheel(event: WheelEvent) {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.15) {
        accumulatedDeltaX = 0;
        return;
      }

      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      accumulatedDeltaX += event.deltaX * scale;

      if (resetTimer !== null) {
        clearTimeout(resetTimer);
      }
      resetTimer = setTimeout(() => {
        accumulatedDeltaX = 0;
        resetTimer = null;
      }, 180);

      const now = Date.now();
      if (Math.abs(accumulatedDeltaX) < 72 || now - lastNavigationAt < 420) {
        return;
      }

      event.preventDefault();
      if (accumulatedDeltaX > 0) {
        callbacksRef.current.onNext();
      } else {
        callbacksRef.current.onPrevious();
      }
      accumulatedDeltaX = 0;
      lastNavigationAt = now;
    }

    target.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      target.removeEventListener('wheel', handleWheel);
      if (resetTimer !== null) {
        clearTimeout(resetTimer);
      }
    };
  }, [enabled, targetRef]);
}
