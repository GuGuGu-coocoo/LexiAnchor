import { expect, type Page } from '@playwright/test';

export interface EpubLayoutExpectation {
  pageSpread: 'single' | 'double';
  contentWidthPercent: number;
  fontSizePercent: number;
}

async function checkpoint(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((value) =>
      value.startsWith('lexianchor:epub-location:'),
    );
    try {
      return JSON.parse(key ? (localStorage.getItem(key) ?? '{}') : '{}') as {
        cfi?: string;
        layoutSignature?: string;
      };
    } catch {
      return {};
    }
  });
}

export async function waitForEpubOpen(page: Page) {
  await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.reader-error')).toHaveCount(0);
  await expect.poll(async () => (await checkpoint(page)).cfi ?? '').toMatch(/^epubcfi\(/);
}

export async function waitForEpubLayout(page: Page, expected: EpubLayoutExpectation) {
  await expect(page.getByTestId('epub-container')).toHaveAttribute('aria-busy', 'false');
  await expect
    .poll(async () => {
      try {
        return JSON.parse((await checkpoint(page)).layoutSignature ?? '{}');
      } catch {
        return null;
      }
    })
    .toMatchObject({ flow: 'paginated', ...expected });
  // Materialization barrier, not an ACK of the engine's entire resize/anchor
  // restoration promise. Keep physical column/crop assertions independent.
  await expect
    .poll(() =>
      page.evaluate(async ({ fontSizePercent }) => {
        const host = document.querySelector<HTMLElement>('[data-testid="epub-container"]');
        const scroller = host?.querySelector<HTMLElement>(':scope > .epub-container');
        if (!host || !scroller) return false;
        const viewport = scroller.getBoundingClientRect();
        const frame = Array.from(scroller.querySelectorAll('iframe')).find((candidate) => {
          const box = candidate.getBoundingClientRect();
          return box.right > viewport.left + 1 && box.left < viewport.right - 1;
        });
        const doc = frame?.contentDocument;
        const body = doc?.body;
        if (!frame || !doc || !body || !frame.contentWindow) return false;
        const ready = () => {
          const style = frame.contentWindow?.getComputedStyle(body);
          return Boolean(
            frame.isConnected &&
            frame.contentDocument === doc &&
            doc.readyState === 'complete' &&
            body.textContent?.trim() &&
            getComputedStyle(frame).visibility === 'visible' &&
            Math.abs(host.clientWidth - scroller.clientWidth) <= 1 &&
            Math.abs(host.clientHeight - scroller.clientHeight) <= 1 &&
            style &&
            Math.abs(parseFloat(style.width) - scroller.clientWidth) <= 1 &&
            Math.abs(parseFloat(style.height) - scroller.clientHeight) <= 1 &&
            body.style.fontSize === `${fontSizePercent}%`,
          );
        };
        const size = (element: HTMLElement) => [element.clientWidth, element.clientHeight];
        const geometry = () => {
          const style = frame.contentWindow?.getComputedStyle(body);
          return JSON.stringify({
            host: size(host),
            scroller: [...size(scroller), scroller.scrollLeft, scroller.scrollWidth],
            frame: frame.getBoundingClientRect().toJSON(),
            body: [style?.width, style?.height, style?.fontSize],
          });
        };
        if (!ready()) return false;
        const before = geometry();
        for (let index = 0; index < 4; index += 1)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return (
          ready() &&
          host.isConnected &&
          scroller.isConnected &&
          host.querySelector(':scope > .epub-container') === scroller &&
          before === geometry()
        );
      }, expected),
    )
    .toBe(true);
  await expect(page.locator('.reader-error')).toHaveCount(0);
}
