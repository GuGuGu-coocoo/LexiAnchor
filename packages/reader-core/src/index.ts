export type ReaderFlow = 'paginated' | 'scrolled';
export type ReaderPageSpread = 'single' | 'double';
export type ReaderPageTurnEffect = 'slide' | 'stack';
export type DocumentFormat = 'epub' | 'pdf';
export type FocusStrength = 'light' | 'medium' | 'strong';
export type ReaderFontFamily = 'serif' | 'sans-serif';
export type ReaderTextAlignment = 'start' | 'justify';

export interface ReaderLocator {
  readonly href: string;
  readonly cfi?: string;
  readonly progression?: number;
  readonly totalProgression?: number;
  readonly pageNumber?: number;
}

export interface ReaderPreferences {
  readonly flow: ReaderFlow;
  readonly pageSpread: ReaderPageSpread;
  readonly pageTurnEffect: ReaderPageTurnEffect;
  readonly fontSizePercent: number;
  readonly lineHeight: number;
  readonly wordSpacingEm: number;
  readonly letterSpacingEm: number;
  readonly fontFamily: ReaderFontFamily;
  readonly fontWeight: number;
  readonly contentWidthPercent: number;
  readonly textAlignment: ReaderTextAlignment;
  readonly foreground: string;
  readonly background: string;
  readonly focusMode: boolean;
  readonly focusStrength: FocusStrength;
}

export interface ReaderSelection {
  readonly text: string;
  readonly sentence: string;
  readonly cfiRange?: string;
  readonly pageNumber?: number;
  readonly anchorRect?: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
  };
}

export interface ReaderCallbacks {
  readonly onLocationChange: (locator: ReaderLocator) => void;
  readonly onSelection: (selection: ReaderSelection | null) => void;
  readonly onError: (error: Error) => void;
  readonly onNavigationCommand?: (command: 'next' | 'previous') => void;
}

export interface ReaderSource {
  readonly data: ArrayBuffer | string;
  readonly name: string;
  readonly format: DocumentFormat;
}

export interface ReaderEngine {
  readonly id: string;
  readonly label: string;
  open(container: HTMLElement, source: ReaderSource, initialLocator?: ReaderLocator): Promise<void>;
  close(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  goTo(locator: ReaderLocator): Promise<void>;
  setPreferences(preferences: ReaderPreferences): Promise<void>;
}

export interface HorizontalPageGestureOptions {
  readonly getVisualElement: () => HTMLElement | null;
  readonly isEnabled?: () => boolean;
  readonly onNext: () => void | Promise<void>;
  readonly onPrevious: () => void | Promise<void>;
}

export interface HorizontalPageGestureController {
  handleWheel(event: WheelEvent): void;
  dispose(): void;
}

export interface HorizontalPageScrollGestureOptions {
  readonly getScroller: () => HTMLElement | null;
  readonly getPageExtent?: () => number;
  readonly isEnabled?: () => boolean;
  readonly onSettled?: (direction: -1 | 0 | 1) => void;
}

function projectedDistance(velocity: number, decelerationRate = 0.99): number {
  return (velocity / 1000) * (decelerationRate / (1 - decelerationRate));
}

/**
 * Turns a horizontal trackpad stream into a directly manipulated page surface.
 * Content follows the gesture immediately, then settles with a critically damped
 * spring so a new gesture can interrupt it without a discontinuous jump.
 */
export function createHorizontalPageGesture(
  options: HorizontalPageGestureOptions,
): HorizontalPageGestureController {
  let position = 0;
  let velocity = 0;
  let lastInputAt = 0;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let animationFrame: number | null = null;
  let sequence = 0;

  const prefersReducedMotion = () =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  function visualWidth(): number {
    return Math.max(320, options.getVisualElement()?.clientWidth ?? 0);
  }

  function render(nextPosition: number): void {
    position = nextPosition;
    const visual = options.getVisualElement();

    if (!visual) {
      return;
    }

    const progress = Math.min(1, Math.abs(position) / Math.max(1, visualWidth() * 0.42));
    visual.style.transform = `translate3d(${position}px, 0, 0)`;
    visual.style.opacity = String(1 - progress * 0.16);
    visual.style.willChange = 'transform, opacity';
  }

  function stopAnimation(): void {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    sequence += 1;
  }

  function resetVisual(): void {
    render(0);
    const visual = options.getVisualElement();

    if (visual) {
      visual.style.removeProperty('transform');
      visual.style.removeProperty('opacity');
      visual.style.removeProperty('will-change');
    }
  }

  function springTo(
    target: number,
    initialVelocity: number,
    onSettled?: () => void,
    dampingRatio = 1,
  ): void {
    stopAnimation();
    const ownSequence = sequence;
    const response = 0.34;
    const stiffness = ((2 * Math.PI) / response) ** 2;
    const damping = 2 * dampingRatio * Math.sqrt(stiffness);
    let springVelocity = initialVelocity;
    let previousTime = performance.now();

    const tick = (time: number) => {
      if (ownSequence !== sequence) {
        return;
      }

      const elapsed = Math.min(0.032, Math.max(0.001, (time - previousTime) / 1000));
      previousTime = time;
      const acceleration = -stiffness * (position - target) - damping * springVelocity;
      springVelocity += acceleration * elapsed;
      render(position + springVelocity * elapsed);

      if (Math.abs(position - target) < 0.5 && Math.abs(springVelocity) < 5) {
        render(target);
        animationFrame = null;
        onSettled?.();
        return;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
  }

  function finishGesture(): void {
    endTimer = null;
    const width = visualWidth();
    const projected =
      position + Math.max(-width * 0.55, Math.min(width * 0.55, projectedDistance(velocity)));
    const direction =
      position < -10 && (projected < -width * 0.16 || velocity < -480)
        ? 1
        : position > 10 && (projected > width * 0.16 || velocity > 480)
          ? -1
          : 0;

    if (direction === 0) {
      springTo(0, velocity, resetVisual);
      return;
    }

    if (prefersReducedMotion()) {
      resetVisual();
      void Promise.resolve(direction > 0 ? options.onNext() : options.onPrevious()).catch(
        resetVisual,
      );
      return;
    }

    const exitPosition = direction > 0 ? -width * 0.22 : width * 0.22;
    springTo(
      exitPosition,
      velocity,
      () => {
        const navigationSequence = sequence;
        void Promise.resolve(direction > 0 ? options.onNext() : options.onPrevious()).then(() => {
          if (navigationSequence !== sequence) {
            return;
          }

          render(direction > 0 ? width * 0.08 : -width * 0.08);
          springTo(0, velocity * 0.08, resetVisual);
        }, resetVisual);
      },
      Math.abs(velocity) > 700 ? 0.86 : 1,
    );
  }

  function handleWheel(event: WheelEvent): void {
    if (
      options.isEnabled?.() === false ||
      Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.15
    ) {
      return;
    }

    event.preventDefault();
    const now = performance.now();
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
    const delta = event.deltaX * scale;
    const elapsed = lastInputAt > 0 ? Math.max(8, now - lastInputAt) : 16;
    lastInputAt = now;

    stopAnimation();
    const instantaneousVelocity = (-delta / elapsed) * 1000;
    velocity = velocity * 0.42 + instantaneousVelocity * 0.58;
    const limit = visualWidth() * 0.34;
    render(Math.max(-limit, Math.min(limit, position - delta)));

    if (endTimer !== null) {
      clearTimeout(endTimer);
    }
    endTimer = setTimeout(finishGesture, 90);
  }

  return {
    handleWheel,
    dispose() {
      stopAnimation();
      if (endTimer !== null) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      resetVisual();
    },
  };
}

/**
 * Directly scrolls a pre-rendered horizontal page strip. Unlike the transform
 * gesture above, this reveals the real adjacent page during the gesture.
 */
export function createHorizontalPageScrollGesture(
  options: HorizontalPageScrollGestureOptions,
): HorizontalPageGestureController {
  let origin = 0;
  let velocity = 0;
  let lastInputAt = 0;
  let isTracking = false;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let animationFrame: number | null = null;
  let animationSequence = 0;

  function stopAnimation(): void {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    animationSequence += 1;
  }

  function pageExtent(): number {
    return Math.max(1, options.getPageExtent?.() ?? options.getScroller()?.clientWidth ?? 1);
  }

  function settle(target: number, initialVelocity: number, direction: -1 | 0 | 1): void {
    stopAnimation();
    const ownSequence = animationSequence;
    const response = 0.32;
    const stiffness = ((2 * Math.PI) / response) ** 2;
    const damping = 2 * Math.sqrt(stiffness);
    let springVelocity = initialVelocity;
    let previousTime = performance.now();
    let expectedPosition = options.getScroller()?.scrollLeft ?? target;

    const tick = (time: number) => {
      if (ownSequence !== animationSequence) {
        return;
      }

      const scroller = options.getScroller();
      if (!scroller) {
        return;
      }

      const elapsed = Math.min(0.032, Math.max(0.001, (time - previousTime) / 1000));
      previousTime = time;
      const position = scroller.scrollLeft;

      // EPUB.js can rebase its continuous strip when it trims an off-screen
      // section. That preserves the visible page but changes scrollLeft. Stop
      // the old spring instead of pulling the reader back toward a stale pixel.
      if (Math.abs(position - expectedPosition) > pageExtent() * 0.45) {
        animationFrame = null;
        velocity = 0;
        options.onSettled?.(direction);
        return;
      }

      const acceleration = -stiffness * (position - target) - damping * springVelocity;
      springVelocity += acceleration * elapsed;
      scroller.scrollLeft = position + springVelocity * elapsed;
      expectedPosition = scroller.scrollLeft;

      if (Math.abs(scroller.scrollLeft - target) < 0.5 && Math.abs(springVelocity) < 5) {
        scroller.scrollLeft = target;
        animationFrame = null;
        velocity = 0;
        options.onSettled?.(direction);
        return;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
  }

  function finishGesture(): void {
    endTimer = null;
    const scroller = options.getScroller();

    if (!scroller) {
      isTracking = false;
      lastInputAt = 0;
      return;
    }

    // The wheel burst owns its origin only until input ends. A later gesture
    // interrupts the spring from the live presentation position and must not
    // inherit the page where an earlier gesture began.
    isTracking = false;
    lastInputAt = 0;
    const extent = pageExtent();
    const distance = scroller.scrollLeft - origin;
    const projected =
      distance + Math.max(-extent * 0.55, Math.min(extent * 0.55, projectedDistance(velocity)));
    const direction: -1 | 0 | 1 =
      distance > 10 && (projected > extent * 0.16 || velocity > 480)
        ? 1
        : distance < -10 && (projected < -extent * 0.16 || velocity < -480)
          ? -1
          : 0;
    const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const pageIndex =
      direction > 0
        ? Math.floor(origin / extent) + 1
        : direction < 0
          ? Math.ceil(origin / extent) - 1
          : Math.round(scroller.scrollLeft / extent);
    const target = Math.max(0, Math.min(maximum, pageIndex * extent));

    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      scroller.scrollLeft = target;
      velocity = 0;
      options.onSettled?.(target === origin ? 0 : direction);
      return;
    }

    settle(target, velocity, target === origin ? 0 : direction);
  }

  return {
    handleWheel(event: WheelEvent) {
      if (
        options.isEnabled?.() === false ||
        Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.15
      ) {
        return;
      }

      const scroller = options.getScroller();
      if (!scroller) {
        return;
      }

      event.preventDefault();
      const now = performance.now();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const delta = event.deltaX * scale;
      const elapsed = lastInputAt > 0 ? Math.max(8, now - lastInputAt) : 16;
      lastInputAt = now;

      if (!isTracking) {
        origin = scroller.scrollLeft;
        isTracking = true;
      }

      stopAnimation();
      const instantaneousVelocity = (delta / elapsed) * 1000;
      velocity = velocity * 0.42 + instantaneousVelocity * 0.58;
      scroller.scrollLeft += delta;

      if (endTimer !== null) {
        clearTimeout(endTimer);
      }
      endTimer = setTimeout(finishGesture, 90);
    },
    dispose() {
      stopAnimation();
      if (endTimer !== null) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      isTracking = false;
      velocity = 0;
    },
  };
}

/**
 * Treats the current viewport as the top sheet in a stack. Chromium's View
 * Transition snapshot keeps that sheet visually intact while the real
 * scroller is moved to the adjacent page underneath. The snapshot then tracks
 * the gesture 1:1 and settles with an interruptible, critically damped spring.
 */
export function createStackedPageScrollGesture(
  options: HorizontalPageScrollGestureOptions,
): HorizontalPageGestureController {
  let origin = 0;
  let target = 0;
  let distance = 0;
  let velocity = 0;
  let direction: -1 | 0 | 1 = 0;
  let progress = 0;
  let activeExtent = 1;
  let lastInputAt = 0;
  let isTracking = false;
  let isReady = false;
  let shouldFinishWhenReady = false;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let animationFrame: number | null = null;
  let transition: ViewTransition | null = null;
  let sheetAnimation: Animation | null = null;
  let sequence = 0;
  let previousTransitionName = '';

  const fallback = createHorizontalPageScrollGesture(options);

  function pageExtent(): number {
    return Math.max(1, options.getPageExtent?.() ?? options.getScroller()?.clientWidth ?? 1);
  }

  function stopAnimation(): void {
    if (animationFrame !== null) {
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    sequence += 1;
  }

  function render(nextProgress: number): void {
    progress = Math.max(0, Math.min(1, nextProgress));
    if (sheetAnimation) {
      sheetAnimation.currentTime = progress * 1_000;
    }
  }

  function cleanup(committedDirection: -1 | 0 | 1): void {
    const scroller = options.getScroller();
    stopAnimation();
    sheetAnimation?.cancel();
    sheetAnimation = null;
    transition?.skipTransition();
    transition = null;

    if (scroller) {
      scroller.style.viewTransitionName = previousTransitionName;
      scroller.classList.remove('epub-page-stack-transition');
    }

    isTracking = false;
    isReady = false;
    shouldFinishWhenReady = false;
    direction = 0;
    distance = 0;
    velocity = 0;
    lastInputAt = 0;
    progress = 0;
    activeExtent = 1;
    options.onSettled?.(committedDirection);
  }

  function settle(commit: boolean): void {
    if (!isReady) {
      shouldFinishWhenReady = true;
      return;
    }

    const scroller = options.getScroller();
    if (!scroller) {
      cleanup(0);
      return;
    }

    stopAnimation();
    const ownSequence = sequence;
    const destination = commit ? 1 : 0;
    const response = 0.34;
    const stiffness = ((2 * Math.PI) / response) ** 2;
    const damping = 2 * Math.sqrt(stiffness);
    let springVelocity = direction === 0 ? 0 : (velocity * direction) / activeExtent;
    let previousTime = performance.now();

    const tick = (time: number) => {
      if (ownSequence !== sequence) {
        return;
      }

      const elapsed = Math.min(0.032, Math.max(0.001, (time - previousTime) / 1000));
      previousTime = time;
      const acceleration = -stiffness * (progress - destination) - damping * springVelocity;
      springVelocity += acceleration * elapsed;
      render(progress + springVelocity * elapsed);

      if (Math.abs(progress - destination) < 0.001 && Math.abs(springVelocity) < 0.01) {
        render(destination);
        animationFrame = null;
        if (!commit) {
          scroller.scrollLeft = origin;
        }
        cleanup(commit ? direction : 0);
        return;
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
  }

  function finishGesture(): void {
    endTimer = null;
    if (!isTracking || direction === 0) {
      isTracking = false;
      return;
    }

    const extent = activeExtent;
    const projected =
      distance + Math.max(-extent * 0.55, Math.min(extent * 0.55, projectedDistance(velocity)));
    const commit =
      direction > 0
        ? projected > extent * 0.16 || velocity > 480
        : projected < -extent * 0.16 || velocity < -480;
    settle(commit);
  }

  function beginTransition(scroller: HTMLElement, nextDirection: -1 | 1): boolean {
    const document = scroller.ownerDocument;
    if (
      typeof document.startViewTransition !== 'function' ||
      globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      return false;
    }

    const extent = pageExtent();
    const maximum = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    origin = scroller.scrollLeft;
    target = Math.max(0, Math.min(maximum, origin + nextDirection * extent));
    if (Math.abs(target - origin) < 1) {
      return false;
    }

    direction = nextDirection;
    activeExtent = Math.abs(target - origin);
    previousTransitionName = scroller.style.viewTransitionName;
    scroller.style.viewTransitionName = 'lexianchor-page';
    scroller.classList.add('epub-page-stack-transition');
    const ownSequence = ++sequence;
    transition = document.startViewTransition(() => {
      scroller.scrollLeft = target;
    });

    void transition.ready.then(
      () => {
        if (ownSequence !== sequence || !transition) {
          return;
        }

        sheetAnimation = document.documentElement.animate(
          direction > 0
            ? [
                { transform: 'translate3d(0, 0, 0)' },
                { transform: `translate3d(${-activeExtent}px, 0, 0)` },
              ]
            : [
                { transform: 'translate3d(0, 0, 0)' },
                { transform: `translate3d(${activeExtent}px, 0, 0)` },
              ],
          {
            duration: 1_000,
            easing: 'linear',
            fill: 'both',
            pseudoElement: '::view-transition-old(lexianchor-page)',
          },
        );
        sheetAnimation.pause();
        isReady = true;
        render(Math.min(1, Math.abs(distance) / activeExtent));

        if (shouldFinishWhenReady) {
          settle(
            direction > 0
              ? distance > activeExtent * 0.16 || velocity > 480
              : distance < -activeExtent * 0.16 || velocity < -480,
          );
        }
      },
      () => {
        if (ownSequence === sequence) {
          scroller.scrollLeft = origin;
          cleanup(0);
        }
      },
    );
    return true;
  }

  return {
    handleWheel(event: WheelEvent) {
      if (
        options.isEnabled?.() === false ||
        Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.15
      ) {
        return;
      }

      const scroller = options.getScroller();
      if (!scroller) {
        return;
      }

      const document = scroller.ownerDocument;
      if (
        typeof document.startViewTransition !== 'function' ||
        globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      ) {
        fallback.handleWheel(event);
        return;
      }

      event.preventDefault();
      const now = performance.now();
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1;
      const delta = event.deltaX * scale;
      const elapsed = lastInputAt > 0 ? Math.max(8, now - lastInputAt) : 16;
      lastInputAt = now;

      if (!isTracking) {
        isTracking = true;
        origin = scroller.scrollLeft;
        distance = 0;
        velocity = 0;
      }

      shouldFinishWhenReady = false;
      if (animationFrame !== null) {
        stopAnimation();
      }
      distance += delta;
      const instantaneousVelocity = (delta / elapsed) * 1000;
      velocity = velocity * 0.42 + instantaneousVelocity * 0.58;

      if (direction === 0 && Math.abs(distance) >= 2) {
        if (!beginTransition(scroller, distance > 0 ? 1 : -1)) {
          isTracking = false;
          fallback.handleWheel(event);
          return;
        }
      }

      if (direction !== 0 && isReady) {
        const directionalDistance = Math.max(0, distance * direction);
        render(Math.min(1, directionalDistance / activeExtent));
      }

      if (endTimer !== null) {
        clearTimeout(endTimer);
      }
      endTimer = setTimeout(finishGesture, 160);
    },
    dispose() {
      fallback.dispose();
      stopAnimation();
      if (endTimer !== null) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      const scroller = options.getScroller();
      if (scroller && transition) {
        scroller.scrollLeft = origin;
      }
      if (transition) {
        cleanup(0);
      }
    },
  };
}

export const defaultReaderPreferences: ReaderPreferences = {
  flow: 'paginated',
  pageSpread: 'single',
  pageTurnEffect: 'slide',
  fontSizePercent: 100,
  lineHeight: 1.55,
  wordSpacingEm: 0,
  letterSpacingEm: 0,
  fontFamily: 'serif',
  fontWeight: 400,
  contentWidthPercent: 90,
  textAlignment: 'start',
  foreground: '#20211f',
  background: '#faf9f6',
  focusMode: false,
  focusStrength: 'medium',
};

const focusRatios: Readonly<Record<FocusStrength, number>> = {
  light: 0.34,
  medium: 0.45,
  strong: 0.58,
};

const focusWeights: Readonly<Record<FocusStrength, number>> = {
  light: 650,
  medium: 750,
  strong: 850,
};

export function focusPrefixLength(wordLength: number, strength: FocusStrength): number {
  const safeLength = Math.max(0, Math.floor(wordLength));

  if (safeLength === 0) {
    return 0;
  }

  if (safeLength <= 3) {
    return strength === 'strong' ? Math.min(2, safeLength) : 1;
  }

  return Math.min(safeLength, Math.ceil(safeLength * focusRatios[strength]));
}

export function focusFontWeight(strength: FocusStrength): number {
  return focusWeights[strength];
}
