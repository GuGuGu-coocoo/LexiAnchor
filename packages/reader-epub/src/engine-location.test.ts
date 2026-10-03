import type { Book, Contents, Rendition } from 'epubjs';
import type * as ReaderCore from '@lexianchor/reader-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  defaultReaderPreferences,
  type HorizontalPageScrollGestureOptions,
  type ReaderLocator,
} from '@lexianchor/reader-core';

const mock = vi.hoisted(() => {
  const defaultDisplay: (
    manager: object,
    section: unknown,
    target?: string | number,
  ) => Promise<void> = () => Promise.resolve();
  return {
    createBook: () => ({}) as Book,
    defaultDisplay,
    gestures: [] as {
      options: HorizontalPageScrollGestureOptions;
      controller: {
        handleWheel: (event: WheelEvent) => void;
        prepare?: () => void;
        invalidate?: () => void;
        dispose: () => void;
      };
    }[],
  };
});

vi.mock('epubjs', () => ({ default: () => mock.createBook() }));
vi.mock('epubjs/src/managers/continuous/index.js', () => ({
  default: class {
    settings = { offset: 0, offsetDelta: 0 };
    constructor(options: object) {
      Object.assign(this, options);
    }
  },
}));
vi.mock('epubjs/src/managers/default/index.js', () => ({
  default: class {
    display(section: unknown, target?: string | number) {
      return mock.defaultDisplay(this, section, target);
    }
    setLayout() {}
  },
}));
vi.mock('@lexianchor/reader-core', async (importOriginal) => {
  const original = await importOriginal<typeof ReaderCore>();
  const create = (options: HorizontalPageScrollGestureOptions) => {
    const controller = {
      handleWheel: vi.fn(),
      prepare: vi.fn(),
      invalidate: vi.fn(),
      dispose: vi.fn(),
    };
    mock.gestures.push({ options, controller });
    return controller;
  };
  return {
    ...original,
    createHorizontalPageScrollGesture: create,
    createStackedPageScrollGesture: create,
  };
});

import { EpubJsReaderEngine } from './index';

interface Location {
  start: { href: string; cfi: string; displayed: { page: number; total: number } };
  end?: { cfi: string };
}

function location(cfi: string, href = 'chapter.xhtml', page = 1): Location {
  return { start: { href, cfi, displayed: { page, total: 12 } } };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function harness(ownedQueue = false) {
  let managerClass:
    | (new (options: object) => {
        prepareAdjacent(
          direction: -1 | 1,
          signal: AbortSignal,
          isCurrent: () => boolean,
        ): Promise<void>;
        invalidatePreparation(): void;
        display(section: unknown, target?: string | number): Promise<void>;
        withDisplayOwner<T>(isCurrent: () => boolean, display: () => T): T;
        setContentWidthPercent(percent: number): void;
        setLayout(layout: {
          pageWidth: number;
          format(contents: {
            css(name: string, value: string, priority: boolean): unknown;
          }): unknown;
        }): void;
      })
    | undefined;
  let live = location('cfi-a');
  let indexed = false;
  const generated = deferred();
  const listeners = new Map<string, (value: unknown) => void>();
  const hooks: ((contents: unknown) => void)[] = [];
  const manager = {
    layout: { delta: 938, pageWidth: 938 },
    settings: { offset: 0, offsetDelta: 0 },
    prepareAdjacent: vi.fn(() => Promise.resolve()),
    invalidatePreparation: vi.fn(),
    trimPreparedViews: vi.fn(),
    withDisplayOwner: <T>(_isCurrent: () => boolean, display: () => T) => display(),
  };
  const rendition = {
    manager,
    started: Promise.resolve(),
    hooks: {
      content: { register: (callback: (contents: unknown) => void) => hooks.push(callback) },
    },
    on: (event: string, callback: (value: unknown) => void) => listeners.set(event, callback),
    currentLocation: vi.fn(() => live),
    // Deliberately not a barrier: old reports can emit after a newer display.
    reportLocation: vi.fn(() => Promise.resolve()),
    display: vi.fn((target?: string) => {
      if (target)
        live = location(target, target.includes('.xhtml') ? target.split('#')[0] : 'chapter.xhtml');
      return Promise.resolve();
    }),
    next: vi.fn(() => {
      live = location('cfi-next', 'chapter.xhtml', 2);
      return Promise.resolve();
    }),
    prev: vi.fn(() => {
      live = location('cfi-prev');
      return Promise.resolve();
    }),
    resize: vi.fn(),
    destroy: vi.fn(),
    flow: vi.fn(),
    spread: vi.fn(),
    themes: { override: vi.fn() },
    getContents: vi.fn<() => Contents[]>(() => []),
    epubcfi: {
      parse: vi.fn((cfi: string) => {
        const match = /^epubcfi\(\/6\/(\d+)!\/4\/(\d+):0\)$/.exec(cfi);
        if (!match) throw new Error('Invalid test CFI');
        return { spinePos: Number(match[1]) / 2 - 1 };
      }),
      compare: vi.fn((one: string, two: string) => {
        const position = (cfi: string) => Number(cfi.match(/!\/4\/(\d+):0/)?.[1]);
        return position(one) - position(two);
      }),
    },
  };
  let queueTail = Promise.resolve<unknown>(undefined);
  let queueHold: Promise<void> | null = null;
  const internalDisplay = vi.fn(rendition.display);
  if (ownedQueue)
    Object.assign(rendition, {
      q: {
        enqueue: (task: (target?: string) => Promise<unknown> | undefined, target?: string) => {
          const scheduled = queueTail.then(async () => {
            if (queueHold) await queueHold;
            return task(target);
          });
          queueTail = scheduled.catch(() => undefined);
          return scheduled;
        },
      },
      _display: internalDisplay,
    });
  const renderTo = vi.fn((_container: unknown, options: { manager: typeof managerClass }) => {
    managerClass = options.manager;
    return rendition as unknown as Rendition;
  });
  const destroyBook = vi.fn();
  const book = {
    ready: Promise.resolve(),
    renderTo,
    locations: {
      generate: () =>
        generated.promise.then(() => {
          indexed = true;
        }),
      percentageFromCfi: (cfi: string) => (indexed ? (cfi === 'cfi-next' ? 0.6 : 0.2) : NaN),
      locationFromCfi: () => (indexed ? 5 : -1),
      length: () => (indexed ? 20 : 0),
    },
    destroy: destroyBook,
  } as unknown as Book;
  mock.createBook = () => book;
  const callbacks = {
    onLocationChange: vi.fn<(locator: ReaderLocator) => void>(),
    onSelection: vi.fn(),
    onError: vi.fn(),
    onPageInteraction: vi.fn(),
    onPageInteractionStart: vi.fn(),
    onPaginationReady: vi.fn(),
  };
  const engine = new EpubJsReaderEngine(callbacks);
  return {
    book,
    renderTo,
    destroyBook,
    engine,
    callbacks,
    rendition,
    manager,
    generated,
    hooks,
    internalDisplay,
    holdQueue: () => {
      const pending = deferred();
      queueHold = pending.promise;
      return () => {
        queueHold = null;
        pending.resolve();
      };
    },
    setLive: (value: Location) => {
      live = value;
    },
    emit: (value: Location) => listeners.get('relocated')?.(value),
    getManagerClass: () => managerClass!,
  };
}

async function open(fixture: ReturnType<typeof harness>) {
  await fixture.engine.open({} as HTMLElement, {
    name: 'isolated.epub',
    data: 'mock',
    format: 'epub',
  });
  await fixture.engine.setPreferences(defaultReaderPreferences);
  fixture.callbacks.onLocationChange.mockClear();
}

const exactCfi = (position: number, spine = 0) =>
  `epubcfi(/6/${(spine + 1) * 2}!/4/${position * 2}:0)`;

function semanticContents(f: ReturnType<typeof harness>) {
  const rectangle = (left: number, right: number, top = 20, bottom = 40) =>
    ({ left, right, top, bottom, width: right - left, height: bottom - top }) as DOMRect;
  let point = rectangle(980, 994);
  const frame = {
    isConnected: true,
    getBoundingClientRect: () => rectangle(0, 1000, 0, 600),
  };
  const scroller = {
    getBoundingClientRect: () => rectangle(0, 1000, 0, 600),
    contains: vi.fn(() => true),
  };
  Object.assign(f.manager, { container: scroller });
  Object.assign(f.book, {
    spine: { get: (index: number) => ({ href: index === 0 ? 'chapter.xhtml' : 'other.xhtml' }) },
  });
  const text = { nodeType: 3, textContent: '  Precise target' };
  const element = { nodeType: 1, childNodes: [text] };
  const range = {
    setStart: vi.fn(),
    setEnd: vi.fn(),
    getClientRects: () => [point],
  };
  const contents = {
    sectionIndex: 0,
    document: {
      defaultView: { frameElement: frame },
      createRange: () => range,
      getElementById: () => element,
    },
    range: vi.fn<() => Pick<Range, 'startContainer' | 'startOffset'>>(() => ({
      startContainer: element as unknown as Node,
      startOffset: 0,
    })),
    cfiFromNode: vi.fn(() => exactCfi(30)),
  };
  f.rendition.getContents.mockReturnValue([contents as unknown as Contents]);
  f.rendition.display.mockImplementation(() => Promise.resolve());
  return {
    contents,
    text,
    range,
    frame,
    scroller,
    setPoint: (left: number, right: number, top = 20, bottom = 40) => {
      point = rectangle(left, right, top, bottom);
    },
  };
}

beforeEach(() => {
  mock.gestures.length = 0;
  mock.defaultDisplay = () => Promise.resolve();
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('EPUB committed locator ownership', () => {
  it('immediate close cancels open before any book, rendition, or callback is created', async () => {
    const f = harness();
    const createBook = vi.fn(() => f.book);
    mock.createBook = createBook;
    const opening = f.engine.open({} as HTMLElement, {
      name: 'canceled.epub',
      data: 'mock',
      format: 'epub',
    });
    await f.engine.close();
    await opening;
    expect(createBook).not.toHaveBeenCalled();
    expect(f.renderTo).not.toHaveBeenCalled();
    expect(f.rendition.destroy).not.toHaveBeenCalled();
    expect(mock.gestures).toHaveLength(0);
    for (const callback of Object.values(f.callbacks)) expect(callback).not.toHaveBeenCalled();
  });

  it('overlapping same-engine opens create only the latest session', async () => {
    const old = harness();
    const openingOld = old.engine.open({} as HTMLElement, {
      name: 'old.epub',
      data: 'mock',
      format: 'epub',
    });
    const current = harness();
    current.setLive(location('current-session'));
    const createBook = vi.fn(() => current.book);
    mock.createBook = createBook;
    const openingCurrent = old.engine.open({} as HTMLElement, {
      name: 'current.epub',
      data: 'mock',
      format: 'epub',
    });
    await Promise.all([openingOld, openingCurrent]);
    expect(createBook).toHaveBeenCalledTimes(1);
    expect(old.renderTo).not.toHaveBeenCalled();
    expect(current.renderTo).toHaveBeenCalledTimes(1);
    expect(current.rendition.destroy).not.toHaveBeenCalled();
    expect(old.callbacks.onLocationChange.mock.calls.map(([locator]) => locator.cfi)).toEqual([
      'current-session',
    ]);
  });

  it('a closed session stops at book.ready without accessing rendition.started', async () => {
    const f = harness();
    const pending = deferred();
    Object.assign(f.book, { ready: pending.promise });
    const started = vi.fn(() => Promise.resolve());
    Object.defineProperty(f.rendition, 'started', { get: started });
    const opening = f.engine.open({} as HTMLElement, {
      name: 'closed.epub',
      data: 'mock',
      format: 'epub',
    });
    await Promise.resolve();
    await f.engine.close();
    pending.resolve();
    await opening;
    expect(started).not.toHaveBeenCalled();
    expect(f.rendition.display).not.toHaveBeenCalled();
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    expect(f.callbacks.onError).not.toHaveBeenCalled();
  });

  it('a closed session stops after rendition.started without displaying or publishing', async () => {
    const f = harness();
    const pending = deferred();
    f.rendition.started = pending.promise;
    const opening = f.engine.open({} as HTMLElement, {
      name: 'closed.epub',
      data: 'mock',
      format: 'epub',
    });
    await Promise.resolve();
    await Promise.resolve();
    await f.engine.close();
    pending.resolve();
    await opening;
    expect(f.rendition.display).not.toHaveBeenCalled();
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    expect(f.callbacks.onError).not.toHaveBeenCalled();
  });

  it.each(['ready', 'started'] as const)(
    'a late old %s rejection neither reports an error nor closes the newer session',
    async (stage) => {
      const old = harness();
      const pending = deferred();
      Object.assign(stage === 'ready' ? old.book : old.rendition, { [stage]: pending.promise });
      const openingOld = old.engine.open({} as HTMLElement, {
        name: 'old.epub',
        data: 'mock',
        format: 'epub',
      });
      await Promise.resolve();
      if (stage === 'started') await Promise.resolve();
      expect(old.renderTo).toHaveBeenCalledTimes(1);
      const current = harness();
      current.setLive(location('current-session'));
      await old.engine.open({} as HTMLElement, {
        name: 'current.epub',
        data: 'mock',
        format: 'epub',
      });
      old.callbacks.onLocationChange.mockClear();
      pending.reject(new Error('Destroyed old session'));
      await expect(openingOld).resolves.toBeUndefined();
      expect(old.callbacks.onError).not.toHaveBeenCalled();
      expect(old.callbacks.onLocationChange).not.toHaveBeenCalled();
      expect(current.rendition.destroy).not.toHaveBeenCalled();
      expect(current.destroyBook).not.toHaveBeenCalled();
      await old.engine.next();
      expect(current.rendition.next).toHaveBeenCalledTimes(1);
      expect(old.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe('cfi-next');
    },
  );

  it('retains a completed in-interval semantic CFI through typography and late metadata, not page turns', async () => {
    const f = harness();
    await open(f);
    semanticContents(f);
    const live = { ...location(exactCfi(10), 'chapter.xhtml', 3), end: { cfi: exactCfi(40) } };
    f.setLive(live);
    await f.engine.goTo({ href: 'chapter.xhtml', cfi: exactCfi(30) });
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0]).toMatchObject({
      cfi: exactCfi(30),
      pageNumber: 3,
      pageCount: 12,
    });
    f.generated.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    f.emit(location('stale-metadata', 'chapter.xhtml', 11));
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0]).toMatchObject({
      cfi: exactCfi(30),
      pageNumber: 3,
      totalPageCount: 20,
    });
    await f.engine.setPreferences({ ...defaultReaderPreferences, fontSizePercent: 130 });
    expect(f.rendition.display).toHaveBeenLastCalledWith(exactCfi(30));
    const gesture = mock.gestures[1]!.options;
    gesture.onInteractionStart?.();
    f.setLive(location(exactCfi(50), 'chapter.xhtml', 4));
    gesture.onSettled?.(0);
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(30));
    gesture.onInteractionStart?.();
    gesture.onSettled?.(1);
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(50));
    await f.engine.previous();
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe('cfi-prev');
    await f.engine.next();
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe('cfi-next');
  });

  it('accepts a real right-edge character missed by the interval and resolves a completed child href', async () => {
    const f = harness();
    await open(f);
    const proof = semanticContents(f);
    f.setLive({ ...location(exactCfi(10), 'chapter.xhtml', 3), end: { cfi: exactCfi(20) } });
    await f.engine.goTo({ href: 'chapter.xhtml', cfi: exactCfi(30) });
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(30));
    expect(proof.contents.range).toHaveBeenLastCalledWith(exactCfi(30), 'lexianchor-focus');
    expect(proof.range.setStart).toHaveBeenLastCalledWith(proof.text, 2);
    expect(proof.range.setEnd).toHaveBeenLastCalledWith(proof.text, 3);
    await f.engine.goTo({ href: 'chapter.xhtml#precise-child' });
    expect(proof.contents.cfiFromNode).toHaveBeenLastCalledWith(
      expect.anything(),
      'lexianchor-focus',
    );
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(30));
  });

  it.each([
    'horizontal',
    'vertical',
    'detached',
    'neighbor',
    'wrong-document',
    'wrong-spine',
    'parse-error',
    'range-error',
  ])(
    'rejects a semantic candidate with %s proof failure even if its parent box would intersect',
    async (failure) => {
      const f = harness();
      await open(f);
      const proof = semanticContents(f);
      f.setLive({
        ...location(exactCfi(10)),
        end: { cfi: exactCfi(failure === 'wrong-spine' ? 40 : 20) },
      });
      let target = exactCfi(30);
      if (failure === 'horizontal') proof.setPoint(1005, 1020);
      if (failure === 'vertical') proof.setPoint(400, 420, 605, 625);
      if (failure === 'detached') proof.frame.isConnected = false;
      if (failure === 'neighbor') proof.scroller.contains.mockReturnValue(false);
      if (failure === 'wrong-document') proof.contents.sectionIndex = 1;
      if (failure === 'wrong-spine') target = exactCfi(30, 1);
      if (failure === 'parse-error')
        f.rendition.epubcfi.parse.mockImplementation(() => {
          throw new Error('invalid');
        });
      if (failure === 'range-error')
        proof.contents.range.mockImplementation(() => {
          throw new Error('invalid');
        });
      await f.engine.goTo({ href: 'chapter.xhtml', cfi: target });
      expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(10));
    },
  );

  it('proves the requested text offset rather than the beginning of its parent, including one Unicode glyph', async () => {
    const f = harness();
    await open(f);
    const proof = semanticContents(f);
    f.setLive({ ...location(exactCfi(10)), end: { cfi: exactCfi(20) } });
    proof.contents.range.mockReturnValue({
      startContainer: proof.text as unknown as Node,
      startOffset: 5,
    });
    await f.engine.goTo({ href: 'chapter.xhtml', cfi: exactCfi(30) });
    expect(proof.range.setStart).toHaveBeenLastCalledWith(proof.text, 5);
    expect(proof.range.setEnd).toHaveBeenLastCalledWith(proof.text, 6);
    proof.text.textContent = '🙂 focus';
    proof.contents.range.mockReturnValue({
      startContainer: proof.text as unknown as Node,
      startOffset: 0,
    });
    await f.engine.goTo({ href: 'chapter.xhtml', cfi: exactCfi(30) });
    expect(proof.range.setEnd).toHaveBeenLastCalledWith(proof.text, 2);
  });

  it('a newer gesture and synchronous freeze reject an asynchronously completed exact candidate', async () => {
    const f = harness();
    await open(f);
    semanticContents(f);
    f.setLive({ ...location(exactCfi(10)), end: { cfi: exactCfi(40) } });
    const pending = deferred();
    f.rendition.display.mockImplementationOnce(() => pending.promise);
    const navigation = f.engine.goTo({ href: 'chapter.xhtml', cfi: exactCfi(30) });
    await Promise.resolve();
    await Promise.resolve();
    const gesture = mock.gestures[0]!.options;
    gesture.onInteractionStart?.();
    f.setLive(location(exactCfi(50)));
    gesture.onSettled?.(1);
    expect(f.engine.freezeLocation()?.cfi).toBe(exactCfi(50));
    pending.resolve();
    await navigation;
    f.emit(location(exactCfi(10)));
    expect(
      f.callbacks.onLocationChange.mock.calls.every(([locator]) => locator.cfi !== exactCfi(30)),
    ).toBe(true);
  });

  it('keeps an initial exact semantic point and ignores a same-page scrolled report until actual movement', async () => {
    const f = harness();
    semanticContents(f);
    f.setLive({ ...location(exactCfi(10)), end: { cfi: exactCfi(40) } });
    await f.engine.open(
      {} as HTMLElement,
      { name: 'isolated.epub', data: 'mock', format: 'epub' },
      { href: 'chapter.xhtml', cfi: exactCfi(30) },
    );
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(30));
    await f.engine.setPreferences({ ...defaultReaderPreferences, flow: 'scrolled' });
    f.callbacks.onPageInteraction.mockClear();
    f.emit(location('queued-pre-layout'));
    expect(f.callbacks.onPageInteraction).not.toHaveBeenCalled();
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(30));
    f.setLive(location(exactCfi(50), 'chapter.xhtml', 2));
    f.emit(location('queued-pre-layout'));
    expect(f.callbacks.onPageInteraction).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe(exactCfi(50));
  });

  it('a queued display loses ownership before rendition work executes, but the next target still runs', async () => {
    const f = harness(true);
    await open(f);
    f.internalDisplay.mockClear();
    const release = f.holdQueue();
    const stale = f.rendition.display('chapter.xhtml#stale-layout');
    await Promise.resolve();
    mock.gestures[0]!.options.onInteractionStart?.();
    const current = f.engine.goTo({ href: 'chapter.xhtml#latest' });
    release();
    await Promise.all([stale, current]);
    expect(
      f.internalDisplay.mock.calls.some(([target]) => target === 'chapter.xhtml#stale-layout'),
    ).toBe(false);
    expect(f.internalDisplay).toHaveBeenLastCalledWith('chapter.xhtml#latest');
    expect(f.engine.freezeLocation()?.cfi).toBe('chapter.xhtml#latest');
  });

  it('resolves concurrent child TOC CFIs from each load document after the parent unloads', async () => {
    const f = harness();
    await open(f);
    const start = { id: 'start' } as Element;
    const children = ['window', 'path', 'bookmark'].map((id) => ({ id }) as Element);
    const document = {
      body: { firstElementChild: start },
      getElementById: (id: string) => children.find((element) => element.id === id),
    } as unknown as Document;
    const contents = { ownerDocument: document } as Element;
    const section = {
      cfiBase: 'base',
      document: document as Document | undefined,
      load: vi.fn(() => Promise.resolve(contents)),
      unload: vi.fn(() => {
        section.document = undefined;
      }),
      cfiFromElement: vi.fn((element: Element) => `cfi-${element.id}`),
    };
    Object.assign(f.book, {
      load: vi.fn(),
      spine: { get: () => section },
      loaded: {
        navigation: Promise.resolve({
          toc: [
            {
              id: 'parent',
              href: 'chapter.xhtml',
              label: 'Parent',
              subitems: children.map((element) => ({
                id: element.id,
                href: `chapter.xhtml#${element.id}`,
                label: element.id,
                subitems: [],
              })),
            },
          ],
        }),
      },
    });
    vi.spyOn(f.book.locations, 'locationFromCfi').mockImplementation(
      (cfi) =>
        ['cfi-start', 'cfi-window', 'cfi-path', 'cfi-bookmark'].indexOf(
          String(cfi),
        ) as unknown as ReturnType<Book['locations']['locationFromCfi']>,
    );
    const toc = await f.engine.getTableOfContents();
    expect(section.unload).toHaveBeenCalledTimes(1);
    expect(section.document).toBeUndefined();
    expect(toc[0]?.pageNumber).toBe(1);
    expect(toc[0]?.subitems.map((item) => [item.cfi, item.pageNumber])).toEqual([
      ['cfi-window', 2],
      ['cfi-path', 3],
      ['cfi-bookmark', 4],
    ]);
    // Successful child positions must not have been poisoned by empty cache entries.
    expect(await f.engine.getTableOfContents()).toEqual(toc);
    expect(section.load).toHaveBeenCalledTimes(4);
  });

  it('suppresses preview/cancel reports and commits live settled location exactly once', async () => {
    const f = harness();
    await open(f);
    const gesture = mock.gestures[0]!.options;
    gesture.onInteractionStart?.();
    expect(f.callbacks.onPageInteractionStart).toHaveBeenCalledTimes(1);
    f.setLive(location('cfi-preview', 'chapter.xhtml', 2));
    f.emit(location('cfi-preview', 'chapter.xhtml', 2));
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    gesture.onSettled?.(0);
    f.emit(location('cfi-preview', 'chapter.xhtml', 2));
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    expect(f.callbacks.onPageInteraction).not.toHaveBeenCalled();

    gesture.onInteractionStart?.();
    f.setLive(location('cfi-next', 'chapter.xhtml', 2));
    gesture.onSettled?.(1);
    f.emit(location('cfi-preview', 'chapter.xhtml', 2));
    f.emit(location('cfi-next', 'chapter.xhtml', 2));
    expect(f.callbacks.onLocationChange).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onLocationChange.mock.calls[0]?.[0].cfi).toBe('cfi-next');
    expect(f.callbacks.onPageInteraction.mock.invocationCallOrder[0]).toBeLessThan(
      f.callbacks.onLocationChange.mock.invocationCallOrder[0]!,
    );
    expect(f.rendition.reportLocation).not.toHaveBeenCalled();
  });

  it('a newer child TOC target wins over queued reports and a superseded target', async () => {
    const f = harness();
    await open(f);
    const old = f.engine.goTo({ href: 'chapter.xhtml#parent' });
    const latest = f.engine.goTo({ href: 'chapter.xhtml#child' });
    await Promise.all([old, latest]);
    f.emit(location('old-parent', 'chapter.xhtml'));
    expect(f.engine.freezeLocation()?.cfi).toBe('chapter.xhtml#child');
    expect(f.callbacks.onLocationChange).toHaveBeenCalledTimes(1);
    expect(f.rendition.display).toHaveBeenLastCalledWith('chapter.xhtml#child');
  });

  it('successful explicit child navigation commits even when its page CFI is unchanged', async () => {
    const f = harness();
    await open(f);
    f.rendition.display.mockImplementation(() => Promise.resolve());
    await f.engine.goTo({ href: 'chapter.xhtml#child-in-current-spread' });
    expect(f.callbacks.onLocationChange).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onLocationChange.mock.calls[0]?.[0].cfi).toBe('cfi-a');
  });

  it('a cancelled preview supersedes a pending child before preferences choose their anchor', async () => {
    const f = harness();
    await open(f);
    const pending = deferred();
    f.rendition.display.mockImplementationOnce(() => pending.promise);
    const navigation = f.engine.goTo({ href: 'chapter.xhtml#pending-child' });
    await Promise.resolve();
    await Promise.resolve();
    const gesture = mock.gestures[0]!.options;
    gesture.onInteractionStart?.();
    gesture.onSettled?.(0);
    expect(f.callbacks.onPageInteractionStart).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onPageInteraction).not.toHaveBeenCalled();
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    const preferences = f.engine.setPreferences({
      ...defaultReaderPreferences,
      fontSizePercent: 130,
    });
    pending.resolve();
    await Promise.all([navigation, preferences]);
    expect(f.engine.freezeLocation()?.cfi).toBe('cfi-a');
    expect(f.rendition.display).toHaveBeenLastCalledWith('cfi-a');
    expect(
      f.callbacks.onLocationChange.mock.calls.every(
        ([locator]) => locator.cfi !== 'chapter.xhtml#pending-child',
      ),
    ).toBe(true);
  });

  it('invalidates both effect controllers and rejects all callbacks after synchronous freeze', async () => {
    const f = harness();
    await open(f);
    const gesture = mock.gestures[1]!.options;
    gesture.onInteractionStart?.();
    f.setLive(location('uncommitted'));
    const frozen = f.engine.freezeLocation();
    expect(frozen?.cfi).toBe('cfi-a');
    for (const item of mock.gestures) expect(item.controller.invalidate).toHaveBeenCalled();
    gesture.onSettled?.(1);
    f.emit(location('uncommitted'));
    f.generated.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    expect(f.callbacks.onPaginationReady).not.toHaveBeenCalled();
    await f.engine.next();
    expect(f.rendition.next).not.toHaveBeenCalled();
  });

  it('late index generation waits for gesture commit, never publishing preview metadata', async () => {
    const f = harness();
    await open(f);
    await f.engine.next();
    const gesture = mock.gestures[0]!.options;
    gesture.onInteractionStart?.();
    f.setLive(location('preview-old'));
    f.generated.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const last = f.callbacks.onLocationChange.mock.calls.at(-1)?.[0];
    expect(last?.cfi).toBe('cfi-next');
    expect(last?.totalProgression).toBeUndefined();
    f.setLive(location('cfi-next'));
    gesture.onSettled?.(1);
    expect(f.callbacks.onLocationChange.mock.calls.at(-1)?.[0].totalProgression).toBe(0.6);
  });

  it('index completion cannot publish an old CFI while a newer child navigation is pending', async () => {
    const f = harness();
    await open(f);
    const pending = deferred();
    f.rendition.display.mockImplementationOnce(() => pending.promise);
    const navigation = f.engine.goTo({ href: 'chapter.xhtml#child' });
    await Promise.resolve();
    await Promise.resolve();
    f.generated.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    pending.resolve();
    await navigation;
    expect(f.callbacks.onLocationChange).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onLocationChange.mock.calls[0]?.[0]).toMatchObject({
      cfi: 'chapter.xhtml#child',
      totalPageCount: 20,
    });
  });

  it('an explicit committed layout anchor cancels a pending child TOC destination', async () => {
    const f = harness();
    await open(f);
    const pending = deferred();
    f.rendition.display.mockImplementationOnce(() => pending.promise);
    const navigation = f.engine.goTo({ href: 'chapter.xhtml#pending-child' });
    await Promise.resolve();
    await Promise.resolve();
    f.engine.preserveLocationForLayoutChange({ href: 'chapter.xhtml', cfi: 'cfi-a' });
    const preferences = f.engine.setPreferences({
      ...defaultReaderPreferences,
      fontSizePercent: 130,
    });
    pending.resolve();
    await Promise.all([navigation, preferences]);
    expect(f.engine.freezeLocation()?.cfi).toBe('cfi-a');
    expect(
      f.callbacks.onLocationChange.mock.calls.every(
        ([locator]) => locator.cfi !== 'chapter.xhtml#pending-child',
      ),
    ).toBe(true);
    expect(f.rendition.display).toHaveBeenLastCalledWith('cfi-a');
  });

  it('ignores old-session reports after reopen and lets scrolled flow commit current-session scroll', async () => {
    const old = harness();
    await open(old);
    // Reuse the first engine while retaining the first rendition's event closure.
    await old.engine.close();
    const newBook = harness();
    await old.engine.open({} as HTMLElement, { name: 'new.epub', data: 'mock', format: 'epub' });
    await old.engine.setPreferences({ ...defaultReaderPreferences, flow: 'scrolled' });
    old.callbacks.onLocationChange.mockClear();
    old.emit(location('stale-session'));
    expect(old.callbacks.onLocationChange).not.toHaveBeenCalled();
    newBook.setLive(location('current-scroll'));
    newBook.emit(location('current-scroll'));
    expect(old.callbacks.onLocationChange.mock.calls.at(-1)?.[0].cfi).toBe('current-scroll');
  });

  it('scrolled movement clears a completed TOC anchor from authoritative live CFI, not a queued report', async () => {
    const f = harness();
    await open(f);
    await f.engine.setPreferences({ ...defaultReaderPreferences, flow: 'scrolled' });
    await f.engine.goTo({ href: 'chapter.xhtml#child' });
    f.callbacks.onLocationChange.mockClear();
    f.callbacks.onPageInteraction.mockClear();
    f.emit(location('queued-old-scroll'));
    expect(f.callbacks.onPageInteraction).not.toHaveBeenCalled();
    expect(f.callbacks.onLocationChange).not.toHaveBeenCalled();
    f.setLive(location('current-scrolled-page', 'chapter.xhtml', 4));
    // The event itself is deliberately stale; only the live rendition owns
    // the new scroll position and the clearing of the explicit TOC anchor.
    f.emit(location('queued-old-scroll'));
    expect(f.callbacks.onPageInteraction).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onLocationChange).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onLocationChange.mock.calls[0]?.[0].cfi).toBe('current-scrolled-page');
    expect(f.callbacks.onPageInteraction.mock.invocationCallOrder[0]).toBeLessThan(
      f.callbacks.onLocationChange.mock.invocationCallOrder[0]!,
    );
    f.emit(location('another-old-report'));
    expect(f.callbacks.onPageInteraction).toHaveBeenCalledTimes(1);
    expect(f.callbacks.onLocationChange).toHaveBeenCalledTimes(1);
  });
});

interface TestSection {
  index: number;
  prev(): TestSection | null;
  next(): TestSection | null;
}

interface TestView {
  section: TestSection;
  expanded: boolean;
  width: number;
  position(): { left: number };
  onDisplayed(): void;
  on(event: string, callback: (value: unknown) => void): void;
  display(): Promise<void>;
  expand(): void;
  show: () => void;
  destroy(): void;
  emitResize(): void;
}

function adjacentRuntime(blockDisplay = false, clampCounter = false) {
  const section = (index: number): TestSection => ({
    index,
    prev: () => (index > 0 ? section(index - 1) : null),
    next: () => (index < 2 ? section(index + 1) : null),
  });
  const scroller = { clientWidth: 100, scrollLeft: 0, scrollWidth: 100 };
  const pending = deferred();
  const created: TestView[] = [];
  const all: TestView[] = [];
  function createView(item: TestSection): TestView {
    const events = new Map<string, (value: unknown) => void>();
    const view = {
      section: item,
      expanded: false,
      width: 0,
      position: () => ({
        left:
          all.slice(0, all.indexOf(view)).reduce((sum, previous) => sum + previous.width, 0) -
          scroller.scrollLeft,
      }),
      onDisplayed: () => undefined as void,
      on: (event: string, callback: (value: unknown) => void) => events.set(event, callback),
      display: vi.fn(async () => {
        if (blockDisplay) await pending.promise;
        view.width = 100;
        scroller.scrollWidth += 100;
        events.get('resized')?.({ widthDelta: 100 });
        view.onDisplayed();
      }),
      show: vi.fn(),
      expand: vi.fn(),
      destroy: vi.fn(),
      emitResize: () => events.get('resized')?.({ widthDelta: 100 }),
    };
    created.push(view);
    return view;
  }
  const initial = createView(section(1));
  initial.width = 100;
  all.push(initial);
  const runtime = {
    settings: { offset: 0, offsetDelta: 0 },
    layout: { delta: 100 },
    container: scroller,
    request: undefined,
    views: {
      first: () => all[0],
      last: () => all.at(-1),
      all: () => all,
      indexOf: (view: typeof initial) => all.indexOf(view),
      append: (view: typeof initial) => all.push(view),
      prepend: (view: typeof initial) => all.unshift(view),
    },
    createView,
    visible: () => all.filter((view) => view.section.index === 1),
    counter: vi.fn((bounds: { widthDelta: number }) => {
      if (!clampCounter) scroller.scrollLeft += bounds.widthDelta;
    }),
    erase: vi.fn((view: typeof initial, above: boolean) => {
      all.splice(all.indexOf(view), 1);
      scroller.scrollWidth -= view.width;
      if (above) scroller.scrollLeft -= view.width;
    }),
    updateAxis: vi.fn(),
    updateWritingMode: vi.fn(),
    afterDisplayed: vi.fn(),
  };
  return { runtime, all, scroller, pending, created };
}

describe('bounded EPUB adjacent view preparation', () => {
  it('an already-running display cannot move or show its view after a new gesture owns the strip', async () => {
    const f = harness();
    await open(f);
    const r = adjacentRuntime();
    const scrollTo = vi.fn();
    const moveTo = vi.fn();
    const show = vi.fn();
    Object.assign(r.runtime, { scrollTo, moveTo });
    Object.assign(r.runtime.views, { show });
    const pending = deferred();
    mock.defaultDisplay = async (scope) => {
      await pending.promise;
      const runtime = scope as {
        scrollTo(...args: unknown[]): void;
        moveTo(...args: unknown[]): void;
        views: { show(): void };
      };
      runtime.moveTo({ left: 938, top: 0 }, 938);
      runtime.scrollTo(938, 0, true);
      runtime.views.show();
    };
    const manager = new (f.getManagerClass())(r.runtime);
    let current = true;
    const stale = manager.withDisplayOwner(
      () => current,
      () => manager.display({}, 'old-cfi'),
    );
    current = false;
    r.scroller.scrollLeft = 120;
    pending.resolve();
    await stale;
    expect(moveTo).not.toHaveBeenCalled();
    expect(scrollTo).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
    expect(r.scroller.scrollLeft).toBe(120);
    await manager.withDisplayOwner(
      () => true,
      () => manager.display({}, 'new-cfi'),
    );
    expect(moveTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'rebases the same visible page when prepend counter clamps=%s',
    async (clampCounter) => {
      const f = harness();
      await open(f);
      const r = adjacentRuntime(false, clampCounter);
      const manager = new (f.getManagerClass())(r.runtime);
      await manager.prepareAdjacent(-1, new AbortController().signal, () => true);
      expect(r.all.map((view) => view.section.index)).toEqual([0, 1, 2]);
      expect(r.scroller.scrollLeft).toBe(100);
      expect(r.created).toHaveLength(3);
      expect(r.runtime.counter).toHaveBeenCalledTimes(1);
      expect(r.all[1]?.position().left).toBe(0);
    },
  );

  it('keeps fixed margins relative to a single column through width and layout changes', async () => {
    const f = harness();
    await open(f);
    const r = adjacentRuntime();
    const manager = new (f.getManagerClass())(r.runtime);
    const css = vi.fn();
    const contents = { css };
    const format = vi.fn();
    const layout = { pageWidth: 938, format };
    manager.setLayout(layout);
    layout.format(contents);
    expect(format).toHaveBeenCalledWith(contents);
    expect(css.mock.calls).toEqual([
      ['padding-left', '46.9px', true],
      ['padding-right', '46.9px', true],
      ['padding-top', '0', true],
      ['padding-bottom', '0', true],
    ]);
    manager.setContentWidthPercent(70);
    layout.format(contents);
    expect(css).toHaveBeenCalledWith('padding-left', '140.7px', true);
    // A double-page spread is 938 px but each column is only 469 px.
    layout.pageWidth = 469;
    manager.setLayout(layout);
    layout.format(contents);
    expect(css).toHaveBeenCalledWith('padding-left', '70.35px', true);
    layout.pageWidth = 350;
    layout.format(contents);
    expect(css).toHaveBeenCalledWith('padding-left', '52.5px', true);
    expect(format).toHaveBeenCalledTimes(4);
  });

  it('abort removes an in-flight prepend synchronously and forbids late strip rebase/show', async () => {
    const f = harness();
    await open(f);
    const r = adjacentRuntime(true);
    const manager = new (f.getManagerClass())(r.runtime);
    const abort = new AbortController();
    const prepare = manager.prepareAdjacent(-1, abort.signal, () => true);
    expect(r.all).toHaveLength(2);
    abort.abort();
    expect(r.all).toHaveLength(1);
    r.created.at(-1)?.emitResize();
    expect(r.runtime.counter).not.toHaveBeenCalled();
    r.pending.resolve();
    await prepare;
    expect(r.runtime.afterDisplayed).not.toHaveBeenCalled();
    expect(r.created.at(-1)?.show).not.toHaveBeenCalled();
    expect(r.created).toHaveLength(2);
  });

  it('navigation generation invalidation cleans pending preparation before its promise resolves', async () => {
    const f = harness();
    await open(f);
    const r = adjacentRuntime(true);
    const manager = new (f.getManagerClass())(r.runtime);
    const prepare = manager.prepareAdjacent(1, new AbortController().signal, () => true);
    manager.invalidatePreparation();
    expect(r.all).toHaveLength(1);
    r.pending.resolve();
    await prepare;
    expect(r.runtime.afterDisplayed).not.toHaveBeenCalled();
    expect(r.created.at(-1)?.show).not.toHaveBeenCalled();
  });
});
