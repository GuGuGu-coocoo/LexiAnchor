import { useEffect, useRef, type RefObject } from 'react';

import { createHorizontalPageGesture } from '@lexianchor/reader-core';

interface HorizontalPageSwipeOptions {
  readonly enabled?: boolean;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
}

export function useHorizontalPageSwipe(
  targetRef: RefObject<HTMLElement | null>,
  visualRef: RefObject<HTMLElement | null>,
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

    const gesture = createHorizontalPageGesture({
      getVisualElement: () => visualRef.current,
      onNext: () => callbacksRef.current.onNext(),
      onPrevious: () => callbacksRef.current.onPrevious(),
    });
    const handleWheel = (event: WheelEvent) => gesture.handleWheel(event);

    target.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      target.removeEventListener('wheel', handleWheel);
      gesture.dispose();
    };
  }, [enabled, targetRef, visualRef]);
}
