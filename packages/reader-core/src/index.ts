export type ReaderFlow = 'paginated' | 'scrolled';
export type ReaderPageSpread = 'single' | 'double';
export type ReaderPageTurnEffect = 'slide' | 'stack';
export type DocumentFormat = 'epub' | 'pdf';
export type FocusStrength = 'light' | 'medium' | 'strong';
export type ReaderFontFamily = 'system' | 'serif' | 'sans-serif' | 'custom';
export type ReaderTextAlignment = 'start' | 'justify';

export interface ReaderLocator {
  readonly href: string;
  readonly cfi?: string;
  readonly layoutSignature?: string;
  readonly navigationHref?: string;
  readonly navigationCfi?: string;
  readonly progression?: number;
  readonly totalProgression?: number;
  readonly pageNumber?: number;
  readonly pageCount?: number;
  readonly totalPageNumber?: number;
  readonly totalPageCount?: number;
  readonly chapterPagesRemaining?: number;
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
  readonly customFontFamily: string;
  readonly fontWeight: number;
  readonly selectionFontSizePercent: number;
  readonly selectionPopoverWidthPx: number;
  readonly selectionPopoverHeightPx: number;
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
  readonly onNavigationCommand?: (command: 'next' | 'previous' | 'escape' | 'fullscreen') => void;
  readonly onPageInteraction?: () => void;
  readonly onLinkNavigation?: (origin: ReaderLocator) => void;
  readonly onPaginationReady?: () => void;
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
  prepare?(): void;
  invalidate?(): void;
  dispose(): void;
}

export interface HorizontalPageScrollGestureOptions {
  readonly getScroller: () => HTMLElement | null;
  readonly getPageExtent?: () => number;
  readonly isEnabled?: () => boolean;
  readonly shouldPrearm?: () => boolean;
  readonly onInteractionStart?: () => void;
  readonly preparePage?: (direction: -1 | 1, signal: AbortSignal) => void | Promise<void>;
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
      position < -6 && (projected < -width * 0.04 || velocity < -140)
        ? 1
        : position > 6 && (projected > width * 0.04 || velocity > 140)
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
    invalidate() {
      stopAnimation();
      if (endTimer !== null) {
        clearTimeout(endTimer);
        endTimer = null;
      }
      velocity = 0;
      lastInputAt = 0;
      resetVisual();
    },
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
 * Both presentations share one uncommitted gesture origin and lifecycle.
 * The stack is an origin snapshot over a live adjacent page; slide renders
 * one adjacent screen from the live strip. Both keep input and presentation
 * within one page of the uncommitted origin; neither commits during input.
 */
export function createHorizontalPageScrollGesture(
  options: HorizontalPageScrollGestureOptions,
): HorizontalPageGestureController {
  return createPageScrollGesture(options, false);
}

export function createStackedPageScrollGesture(
  options: HorizontalPageScrollGestureOptions,
): HorizontalPageGestureController {
  return createPageScrollGesture(options, true);
}

interface PageScrollSession {
  readonly id: number;
  readonly scroller: HTMLElement;
  origin: number;
  extent: number;
  distance: number;
  presentation: number;
  velocity: number;
  lastInputAt: number;
  direction: -1 | 0 | 1;
  target: number;
  stack: boolean;
  started: boolean;
  preparing: boolean;
  prepared: Set<number>;
  prepareAborts: Set<AbortController>;
  prepareRevision: number;
  captureRevision: number;
  ready: boolean;
  finishRequested: boolean;
  settling: boolean;
  springRevision: number;
  frame: number | null;
  endTimer: ReturnType<typeof setTimeout> | null;
  prepareTimer: ReturnType<typeof setTimeout> | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  transition: ViewTransition | null;
  animation: Animation | null;
  animationDirection: -1 | 0 | 1;
  animationExtent: number;
  snapshotDirection: -1 | 0 | 1;
  previousTransitionName: string;
}

function createPageScrollGesture(
  options: HorizontalPageScrollGestureOptions,
  stacked: boolean,
): HorizontalPageGestureController {
  // A recovery ceiling, not an input-latency target. Normal preparation/ready
  // completes immediately; a missing browser/adapter promise cannot lock input.
  const preparationTimeout = 250;
  const idleDelay = stacked ? 170 : 90;
  let active: PageScrollSession | null = null;
  let generation = 0;
  let disposed = false;
  let closing: {
    scroller: HTMLElement;
    frame: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  } | null = null;

  const reducedMotion = () =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const extent = () =>
    Math.max(1, options.getPageExtent?.() ?? options.getScroller()?.clientWidth ?? 1);
  const sign = (value: number): -1 | 0 | 1 => (value > 0 ? 1 : value < 0 ? -1 : 0);
  const clamp = (scroller: HTMLElement, value: number) =>
    Math.max(0, Math.min(Math.max(0, scroller.scrollWidth - scroller.clientWidth), value));
  const pageDistance = (session: PageScrollSession, value: number) =>
    Math.max(-session.extent, Math.min(session.extent, value));

  function valid(session: PageScrollSession): boolean {
    if (disposed || active !== session || session.id !== generation) return false;
    if (options.getScroller() !== session.scroller || options.isEnabled?.() === false) {
      invalidate();
      return false;
    }
    return true;
  }

  function stopSpring(session: PageScrollSession): void {
    session.springRevision += 1;
    if (session.frame !== null) {
      cancelAnimationFrame(session.frame);
      session.frame = null;
    }
    session.settling = false;
  }

  function clearTimers(session: PageScrollSession): void {
    for (const name of ['endTimer', 'prepareTimer', 'readyTimer'] as const) {
      if (session[name] !== null) {
        clearTimeout(session[name]);
        session[name] = null;
      }
    }
  }

  function removeSnapshot(session: PageScrollSession): ViewTransition | null {
    session.captureRevision += 1;
    if (session.readyTimer !== null) {
      clearTimeout(session.readyTimer);
      session.readyTimer = null;
    }
    session.animation?.cancel();
    session.animation = null;
    session.animationDirection = 0;
    session.ready = false;
    session.snapshotDirection = 0;
    const transition = session.transition;
    session.transition = null;
    const scroller = session.scroller;
    scroller.style.viewTransitionName = session.previousTransitionName;
    scroller.classList.remove('epub-page-stack-transition');
    scroller.ownerDocument.documentElement.classList?.remove('epub-page-stack-prepared');
    scroller.ownerDocument.documentElement.classList?.remove('epub-page-stack-active');
    try {
      transition?.skipTransition();
    } catch {
      // Cleanup is still required if the browser has already discarded it.
    }
    return transition;
  }

  function clearClosing(): void {
    if (!closing) return;
    if (closing.frame !== null) cancelAnimationFrame(closing.frame);
    if (closing.timer !== null) clearTimeout(closing.timer);
    closing = null;
  }

  function waitForClosing(transition: ViewTransition, scroller: HTMLElement): void {
    clearClosing();
    const record = {
      scroller,
      frame: null as number | null,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    closing = record;
    const release = () => {
      if (closing !== record) return;
      clearClosing();
      if (active && valid(active)) advance(active);
    };
    // rAF is a lifecycle yield, not proof that a paint completed. A timer also
    // releases a hidden/throttled window whose rAF does not execute.
    record.frame = requestAnimationFrame(release);
    record.timer = setTimeout(release, preparationTimeout);
    void transition.finished.then(release, release);
  }

  function end(session: PageScrollSession, direction: -1 | 0 | 1, notify: boolean): void {
    if (active !== session) return;
    const ownsScroller = options.getScroller() === session.scroller;
    clearTimers(session);
    stopSpring(session);
    session.prepareRevision += 1;
    for (const abort of session.prepareAborts) abort.abort();
    session.prepareAborts.clear();
    if (ownsScroller) {
      session.scroller.scrollLeft = direction === 0 ? session.origin : session.target;
    }
    const transition = removeSnapshot(session);
    active = null;
    generation += 1;
    if (transition && !disposed) waitForClosing(transition, session.scroller);
    if (notify && ownsScroller) options.onSettled?.(direction);
  }

  function fallback(
    session: PageScrollSession,
    requested = session.ready ? session.presentation : session.distance,
  ): void {
    if (!valid(session)) return;
    stopSpring(session);
    session.distance = requested;
    removeSnapshot(session);
    session.scroller.scrollLeft = session.origin;
    session.stack = false;
    render(session, requested);
    if (session.finishRequested) finish(session);
  }

  function sheetAnimation(session: PageScrollSession, direction: -1 | 1, travel: number): void {
    if (session.animationDirection === direction && session.animationExtent === travel) return;
    session.animation?.cancel();
    session.animation = session.scroller.ownerDocument.documentElement.animate(
      [
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        { opacity: 1, transform: 'translate3d(' + -direction * travel + 'px, 0, 0)' },
      ],
      {
        duration: 1_000,
        easing: 'linear',
        fill: 'both',
        pseudoElement: '::view-transition-old(lexianchor-page)',
      },
    );
    session.animation.pause();
    session.animationDirection = direction;
    session.animationExtent = travel;
  }

  function recapture(session: PageScrollSession, requested: number): void {
    if (!valid(session)) return;
    stopSpring(session);
    session.distance = requested;
    const transition = removeSnapshot(session);
    session.scroller.scrollLeft = session.origin;
    session.presentation = 0;
    session.direction = 0;
    session.target = session.origin;
    session.started = false;
    // Named ::new is a captured neighbour, not a live strip. It cannot be
    // reused across zero for the other direction. Preserve the gesture origin
    // and buffered input, but acquire a fresh pair after the old one closes.
    if (transition) waitForClosing(transition, session.scroller);
    else advance(session);
  }

  function render(session: PageScrollSession, requested: number): void {
    if (!valid(session)) return;
    // A horizontal page turn is not a freely scrolling strip. This also
    // bounds spring overshoot and a failed snapshot's live-strip fallback.
    requested = pageDistance(session, requested);
    if (!session.stack) {
      const position = clamp(session.scroller, session.origin + requested);
      session.scroller.scrollLeft = position;
      // Some engines quantize scrollLeft. Keep fractional integration state:
      // rounding it back every frame creates a dead zone before the endpoint.
      session.presentation = position - session.origin;
      return;
    }
    if (!session.ready) return;
    const direction = sign(requested);
    if (direction !== 0 && session.snapshotDirection !== direction) {
      recapture(session, requested);
      return;
    }
    if (direction === 0) {
      session.presentation = 0;
      session.scroller.scrollLeft = session.origin;
      if (session.animation) session.animation.currentTime = 0;
      session.direction = 0;
      session.target = session.origin;
      return;
    }
    const target = clamp(session.scroller, session.origin + direction * session.extent);
    const travel = Math.abs(target - session.origin);
    if (travel < 1) {
      session.presentation = 0;
      session.scroller.scrollLeft = session.origin;
      if (session.animation) session.animation.currentTime = 0;
      session.direction = 0;
      session.target = session.origin;
      return;
    }
    try {
      sheetAnimation(session, direction, travel);
      session.direction = direction;
      session.target = target;
      session.scroller.scrollLeft = target;
      session.presentation = direction * Math.min(travel, Math.abs(requested));
      if (session.animation)
        session.animation.currentTime = (Math.abs(session.presentation) / travel) * 1_000;
    } catch {
      fallback(session, requested);
    }
  }

  function capture(session: PageScrollSession): void {
    if (!valid(session) || session.transition) return;
    const document = session.scroller.ownerDocument;
    const captureRevision = ++session.captureRevision;
    const current = () => valid(session) && session.captureRevision === captureRevision;
    session.previousTransitionName = session.scroller.style.viewTransitionName;
    session.scroller.style.viewTransitionName = 'lexianchor-page';
    session.scroller.classList.add('epub-page-stack-transition');
    document.documentElement.classList?.add('epub-page-stack-active');
    try {
      const transition = document.startViewTransition(() => {
        if (!current()) return;
        const direction = sign(session.distance);
        session.snapshotDirection = direction;
        session.target = clamp(session.scroller, session.origin + direction * session.extent);
        session.scroller.scrollLeft = session.target;
      });
      session.transition = transition;
      session.readyTimer = setTimeout(() => {
        if (current()) fallback(session);
      }, preparationTimeout);
      void transition.ready.then(
        () => {
          if (!current()) return;
          if (session.readyTimer !== null) clearTimeout(session.readyTimer);
          session.readyTimer = null;
          session.ready = true;
          advance(session);
        },
        () => {
          if (current()) fallback(session);
        },
      );
      void transition.finished.then(
        () => {
          if (current()) fallback(session);
        },
        () => {
          if (current()) fallback(session);
        },
      );
    } catch {
      fallback(session);
    }
  }

  function prepare(session: PageScrollSession, direction: -1 | 1): void {
    if (!valid(session) || session.preparing) return;
    session.preparing = true;
    const revision = ++session.prepareRevision;
    const abort = new AbortController();
    session.prepareAborts.add(abort);
    // A missing neighbour can rebase the strip. Expose the origin, not the
    // preview target, before asking the adapter to preserve that content.
    if (session.started) {
      render(session, 0);
      session.scroller.scrollLeft = session.origin;
    }
    const current = () =>
      valid(session) && session.prepareRevision === revision && !abort.signal.aborted;
    const complete = (failed: boolean) => {
      if (!current()) return;
      if (session.prepareTimer !== null) clearTimeout(session.prepareTimer);
      session.prepareTimer = null;
      session.preparing = false;
      // Read pixels only after the adapter has preserved/rebased the origin.
      session.origin = session.scroller.scrollLeft;
      session.extent = extent();
      session.distance = pageDistance(session, session.distance);
      session.prepared.add(direction);
      if (failed) {
        abort.abort();
        session.stack = false;
        removeSnapshot(session);
      }
      advance(session);
    };
    session.prepareTimer = setTimeout(() => complete(true), preparationTimeout);
    try {
      const result = options.preparePage?.(direction, abort.signal);
      if (result)
        void Promise.resolve(result).then(
          () => complete(false),
          () => complete(true),
        );
      else complete(false);
    } catch {
      complete(true);
    }
  }

  function advance(session: PageScrollSession): void {
    if (!valid(session) || session.preparing || closing) return;
    const direction = sign(session.distance);
    if (!session.started) {
      if (direction === 0 || Math.abs(session.distance) < 2) {
        if (session.finishRequested) end(session, 0, true);
        return;
      }
      if (!session.prepared.has(direction)) {
        prepare(session, direction);
        return;
      }
      session.started = true;
      if (session.stack) capture(session);
    }
    if (session.stack && session.transition && !session.ready) return;
    const requestedTarget = clamp(session.scroller, session.origin + direction * session.extent);
    if (
      direction !== 0 &&
      Math.abs(requestedTarget - session.origin) < 1 &&
      !session.prepared.has(direction)
    ) {
      prepare(session, direction);
      return;
    }
    render(session, session.distance);
    if (!valid(session)) return;
    if (!session.finishRequested && session.started && (!session.stack || session.ready)) {
      // Only discard unavailable travel after adjacent-page preparation.
      // Clamping against scrollWidth before that would block a previous
      // chapter at its first page. Do not leave overscroll debt at book edges.
      if (Math.abs(session.distance - session.presentation) > 0.5) session.velocity = 0;
      session.distance = session.presentation;
    }
    if (session.finishRequested) finish(session);
  }

  function finish(session: PageScrollSession): void {
    if (!valid(session)) return;
    session.endTimer = null;
    session.finishRequested = true;
    if (!session.started && !session.preparing && !closing) {
      end(session, 0, true);
      return;
    }
    if (session.settling) return;
    if (session.preparing || closing || (session.stack && !session.ready)) return;
    const threshold = session.stack ? 0.025 : 0.16;
    const speedThreshold = session.stack ? 120 : 480;
    const projected =
      session.distance +
      Math.max(
        -session.extent * 0.55,
        Math.min(session.extent * 0.55, projectedDistance(session.velocity)),
      );
    const direction = sign(session.distance);
    const commit =
      direction !== 0 &&
      (projected * direction > session.extent * threshold ||
        session.velocity * direction > speedThreshold);
    const target = commit
      ? clamp(session.scroller, session.origin + direction * session.extent)
      : session.origin;
    const settledDirection = target === session.origin ? 0 : direction;
    session.target = target;
    const destination = target - session.origin;
    if (reducedMotion()) {
      render(session, destination);
      end(session, settledDirection, true);
      return;
    }
    stopSpring(session);
    session.settling = true;
    const revision = session.springRevision;
    const stiffness = ((2 * Math.PI) / (session.stack ? 0.28 : 0.32)) ** 2;
    const damping = 2 * Math.sqrt(stiffness);
    let previousTime = performance.now();
    let expectedScroll = session.scroller.scrollLeft;
    const tick = (time: number) => {
      if (!valid(session) || revision !== session.springRevision) return;
      if (
        !session.stack &&
        Math.abs(session.scroller.scrollLeft - expectedScroll) > session.extent * 0.45
      ) {
        // A renderer rebase preserves content but invalidates old pixel targets.
        session.origin = session.scroller.scrollLeft;
        end(session, 0, true);
        return;
      }
      const elapsed = Math.min(0.032, Math.max(0.001, (time - previousTime) / 1000));
      previousTime = time;
      const acceleration =
        -stiffness * (session.presentation - destination) - damping * session.velocity;
      session.velocity += acceleration * elapsed;
      const next = session.presentation + session.velocity * elapsed;
      if (destination === 0 && next * session.presentation <= 0) {
        session.velocity = 0;
        render(session, 0);
        end(session, 0, true);
        return;
      }
      render(session, next);
      if (!valid(session) || revision !== session.springRevision) return;
      if (Math.abs(next - session.presentation) > 0.5) session.velocity = 0;
      expectedScroll = session.scroller.scrollLeft;
      if (Math.abs(session.presentation - destination) < 0.5 && Math.abs(session.velocity) < 5) {
        render(session, destination);
        session.frame = null;
        end(session, settledDirection, true);
        return;
      }
      session.frame = requestAnimationFrame(tick);
    };
    session.frame = requestAnimationFrame(tick);
  }

  function invalidate(): void {
    clearClosing();
    if (active) end(active, 0, false);
    clearClosing();
    generation += 1;
  }

  return {
    // Prearming held browser hit testing hostage. Capture only after an
    // interaction starts, even if an older caller still invokes prepare().
    prepare: () => undefined,
    invalidate,
    handleWheel(event) {
      if (disposed) return;
      if (active) valid(active);
      if (options.isEnabled?.() === false) {
        invalidate();
        return;
      }
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY) * 1.15)
        return;
      const scroller = options.getScroller();
      if (!scroller) return;
      if (
        active &&
        !active.stack &&
        !active.preparing &&
        active.started &&
        Math.abs(scroller.scrollLeft - active.origin - active.presentation) > active.extent * 0.45
      ) {
        active.origin = scroller.scrollLeft;
        end(active, 0, true);
      }
      event.preventDefault();
      const now = performance.now();
      if (!active) {
        const session: PageScrollSession = {
          id: ++generation,
          scroller,
          origin: scroller.scrollLeft,
          extent: extent(),
          distance: 0,
          presentation: 0,
          velocity: 0,
          lastInputAt: 0,
          direction: 0,
          target: scroller.scrollLeft,
          stack:
            stacked &&
            !reducedMotion() &&
            typeof scroller.ownerDocument?.startViewTransition === 'function',
          started: false,
          preparing: false,
          prepared: new Set(),
          prepareAborts: new Set(),
          prepareRevision: 0,
          captureRevision: 0,
          ready: false,
          finishRequested: false,
          settling: false,
          springRevision: 0,
          frame: null,
          endTimer: null,
          prepareTimer: null,
          readyTimer: null,
          transition: null,
          animation: null,
          animationDirection: 0,
          animationExtent: 0,
          snapshotDirection: 0,
          previousTransitionName: scroller.style?.viewTransitionName ?? '',
        };
        active = session;
        options.onInteractionStart?.();
        if (!valid(session)) return;
      }
      const session = active;
      if (!session) return;
      if (session.settling) {
        stopSpring(session);
        session.distance = session.presentation;
        session.lastInputAt = 0;
      }
      const delta =
        event.deltaX *
        (event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? 16
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? session.extent
            : 1);
      const elapsed = session.lastInputAt > 0 ? Math.max(8, now - session.lastInputAt) : 16;
      session.lastInputAt = now;
      // Keep the accumulator bounded too: limiting only the rendered page
      // stores invisible extra travel, making a reverse gesture feel stuck.
      session.distance = pageDistance(session, session.distance + delta);
      session.velocity =
        Math.abs(session.distance) === session.extent && delta * session.distance > 0
          ? 0
          : session.velocity * 0.42 + (delta / elapsed) * 1_000 * 0.58;
      session.finishRequested = false;
      if (session.endTimer !== null) clearTimeout(session.endTimer);
      session.endTimer = setTimeout(() => finish(session), idleDelay);
      advance(session);
    },
    dispose() {
      invalidate();
      disposed = true;
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
  customFontFamily: '',
  fontWeight: 400,
  selectionFontSizePercent: 100,
  selectionPopoverWidthPx: 360,
  selectionPopoverHeightPx: 430,
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
