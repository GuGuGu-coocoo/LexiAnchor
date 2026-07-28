import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test.beforeEach(async ({ context }) => {
  await context.route('https://en.wiktionary.org/**', (route) =>
    route.abort('internetdisconnected'),
  );
});

const freeDictFixture = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text><body>
    <entry>
      <form><orth>attentive</orth><pron>əˈtɛntɪv</pron></form>
      <gramGrp><pos>adj</pos></gramGrp>
      <sense><cit type="trans"><quote>attentif</quote></cit></sense>
    </entry>
  </body></text>
</TEI>`;

const freeDictChineseFixture = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <text><body>
    <entry>
      <form><orth>attentive</orth><pron>/əˈtɛntɪv/</pron></form>
      <gramGrp><pos>adj</pos></gramGrp>
      <sense>
        <cit type="trans" xml:lang="zh"><quote>細緻</quote></cit>
        <sense><def>Paying attention or listening closely.</def></sense>
      </sense>
    </entry>
  </body></text>
</TEI>`;

async function ensureServiceWorkerControl(page: Page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });

  if (!(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)))) {
    await page.reload();
  }

  await expect
    .poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
    .toBe(true);
}

async function expectEpubHeading(page: Page, name: string) {
  await expect
    .poll(async () => {
      for (const frame of page.frames()) {
        if (
          await frame
            .getByRole('heading', { name })
            .isVisible()
            .catch(() => false)
        ) {
          return true;
        }
      }
      return false;
    })
    .toBe(true);
}

async function currentEpubHref(page: Page): Promise<string> {
  return page.evaluate(() => {
    const key = Object.keys(localStorage).find((candidate) =>
      candidate.startsWith('lexianchor:epub-location:'),
    );
    if (!key) {
      return '';
    }

    try {
      return (JSON.parse(localStorage.getItem(key) ?? '{}') as { href?: string }).href ?? '';
    } catch {
      return '';
    }
  });
}

async function installFreeDictFixtures(page: Page) {
  await page.evaluate(
    async (fixtures) => {
      const root = await navigator.storage.getDirectory();
      const appDirectory = await root.getDirectoryHandle('lexianchor', { create: true });
      const dictionaryDirectory = await appDirectory.getDirectoryHandle('dictionaries', {
        create: true,
      });

      for (const [id, content] of fixtures) {
        const file = await dictionaryDirectory.getFileHandle(`${id}.tei`, {
          create: true,
        });
        const writer = await file.createWritable();

        try {
          await writer.write(content);
        } finally {
          await writer.close();
        }
      }
    },
    [
      ['freedict-eng-fra-0.1.6', freeDictFixture],
      ['freedict-eng-zho-2025.11.23', freeDictChineseFixture],
    ],
  );
}

function starDictFixtureFiles() {
  const article = Buffer.from('A careful reader who gives close attention.', 'utf8');
  const term = Buffer.from('attentive', 'utf8');
  const index = Buffer.alloc(term.byteLength + 1 + 8);
  term.copy(index);
  index.writeUInt32BE(0, term.byteLength + 1);
  index.writeUInt32BE(article.byteLength, term.byteLength + 5);
  const info = Buffer.from(
    [
      "StarDict's dict ifo file",
      'version=2.4.2',
      'bookname=My Reading Dictionary',
      'wordcount=1',
      `idxfilesize=${index.byteLength}`,
      'sametypesequence=m',
      '',
    ].join('\n'),
    'utf8',
  );

  return [
    { name: 'my-reader.ifo', mimeType: 'text/plain', buffer: info },
    { name: 'my-reader.idx', mimeType: 'application/octet-stream', buffer: index },
    { name: 'my-reader.dict', mimeType: 'application/octet-stream', buffer: article },
  ];
}

test('shows the shared LexiAnchor home surface', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('LexiAnchor', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '38');
});

test('moves between the library and word-card sections', async ({ page }) => {
  await page.goto('/');

  const libraryLabel = /Library|书库|Bibliothèque/;
  const cardsLabel = /Word cards|词卡|Fiches de mots/;

  await page.getByRole('button', { name: libraryLabel }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /library|书库|bibliothèque/i }),
  ).toBeVisible();

  await page.getByRole('button', { name: cardsLabel }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: /word cards|词卡|fiches/i }),
  ).toBeVisible();
});

test('shows optional English-French and English-Chinese local translation models', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();

  const frenchModel = page.locator('article[data-translation-model="fr"]');
  const chineseModel = page.locator('article[data-translation-model="zh"]');

  await expect(frenchModel).toContainText('Mozilla Bergamot English–French');
  await expect(frenchModel).toContainText(/25\.8 MB/);
  await expect(frenchModel).toContainText(/MPL|Mozilla Public License/);
  await expect(
    frenchModel.getByRole('button', { name: /Install model|安装模型|Installer le modèle/ }),
  ).toBeVisible();

  await expect(chineseModel).toContainText('Mozilla Bergamot English–Chinese');
  await expect(chineseModel).toContainText(/36\.7 MB/);
  await expect(chineseModel).toContainText(/MPL|Mozilla Public License/);
  await expect(
    chineseModel.getByRole('button', { name: /Install model|安装模型|Installer le modèle/ }),
  ).toBeVisible();
});

test('shows browser quota and requests persistent local storage', async ({ page }) => {
  await page.addInitScript(() => {
    let isPersisted = false;
    const storage = navigator.storage;

    Object.defineProperties(storage, {
      persisted: {
        configurable: true,
        value: () => Promise.resolve(isPersisted),
      },
      persist: {
        configurable: true,
        value: () => {
          isPersisted = true;
          return Promise.resolve(true);
        },
      },
      estimate: {
        configurable: true,
        value: () => Promise.resolve({ usage: 12_500_000, quota: 100_000_000 }),
      },
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();

  const storageCard = page.getByTestId('storage-health');
  await expect(storageCard).toContainText(/Browser-managed storage|由浏览器管理|géré par/);
  await expect(storageCard).toContainText(/13 MB/);
  await expect(storageCard).toContainText(/100 MB/);
  await storageCard
    .getByRole('button', { name: /Protect local data|保护本地数据|Protéger/ })
    .click();
  await expect(storageCard).toContainText(
    /Protected from automatic cleanup|已防止自动清理|Protégé/,
  );
  await page.screenshot({ path: 'test-results/storage-health.png', fullPage: true });
});

test('falls back to page immersive mode when the Fullscreen API is unavailable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();

  await page.getByRole('button', { name: /^Full screen$|^全屏$|^Plein écran$/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-immersive', 'on');
  await expect(page.locator('aside.reader-settings')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(page.locator('html')).not.toHaveAttribute('data-immersive', 'on');
  await expect(
    page.getByRole('button', { name: /^Full screen$|^全屏$|^Plein écran$/ }),
  ).toBeVisible();
});

test('exports and restores a self-contained application backup', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('.import-button input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-text.pdf'));
  await expect(page.locator('.pdf-page')).toBeVisible();
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/2.*3.*67%/);
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();

  await page.getByRole('combobox', { name: /Appearance|外观|Apparence/ }).selectOption('eye-care');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eye-care');
  await page
    .getByRole('checkbox', {
      name: /Include book files|包含书籍文件|Inclure les fichiers/,
    })
    .check();

  const downloadPromise = page.waitForEvent('download');
  await page
    .getByRole('button', {
      name: /Export app backup|导出应用备份|Exporter la sauvegarde de l'application/,
    })
    .click();
  const backupPath = await (await downloadPromise).path();

  if (!backupPath) {
    throw new Error('The application backup download has no local path.');
  }

  await expect(page.getByRole('status')).toContainText(
    /Application backup downloaded|应用备份已下载|Sauvegarde de l'application téléchargée/,
  );
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const storedBook = page.locator('article[data-book-id]').filter({ hasText: 'lexianchor-text' });
  await storedBook
    .getByRole('button', {
      name: /Delete lexianchor-text|删除 lexianchor-text|Supprimer lexianchor-text/,
    })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {
      name: /Delete local copy|删除本地副本|Supprimer la copie locale/,
    })
    .click();
  await expect(storedBook).toHaveCount(0);

  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();
  await page.getByRole('combobox', { name: /Appearance|外观|Apparence/ }).selectOption('light');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.application-backup-import input[type="file"]').setInputFiles(backupPath);
  await expect(page.getByRole('status')).toContainText(
    /Backup restored|备份已恢复|Sauvegarde restaurée/,
  );
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eye-care');

  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const restoredBook = page.locator('article[data-book-id]').filter({ hasText: 'lexianchor-text' });
  await expect(restoredBook).toBeVisible();
  await expect(restoredBook.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '67');
  await restoredBook.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/2.*3.*67%/);
  await page.screenshot({ path: 'test-results/application-backup-restored.png', fullPage: true });
});

test('opens the EPUB spike and validates selection and focus markup', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();

  const bookFrame = page.locator('.epub-container iframe').first().contentFrame();
  await expect(bookFrame.getByRole('heading', { name: 'A Quiet Beginning' })).toBeVisible();
  const embeddedImage = bookFrame.getByRole('img', {
    name: 'A reading lamp illuminating an open book',
  });
  await expect(embeddedImage).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() =>
      embeddedImage.evaluate(
        (image) =>
          (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);

  const readerSidebar = page.locator('aside.reader-settings');
  const appearancePanel = page.locator('details.reader-appearance-panel');
  await appearancePanel.locator('summary').click();
  const appearance = page.getByRole('combobox', {
    name: /Appearance|外观|Apparence/,
  });
  await appearance.selectOption('eye-care');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'eye-care');
  await expect
    .poll(() =>
      bookFrame
        .locator('body')
        .evaluate(
          (body) => body.ownerDocument.defaultView?.getComputedStyle(body).backgroundColor ?? '',
        ),
    )
    .toBe('rgb(248, 243, 229)');

  const chapterBeforeSidebarResize = await currentEpubHref(page);
  await page
    .getByRole('button', { name: /Hide reader sidebar|隐藏阅读侧栏|Masquer le panneau/ })
    .click();
  await expect(readerSidebar).toBeHidden();
  await expect(page.locator('.reader-workspace')).toHaveClass(/reader-workspace--sidebar-hidden/);
  await page
    .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
    .click();
  await expect(readerSidebar).toBeVisible();
  await expect.poll(() => currentEpubHref(page)).toBe(chapterBeforeSidebarResize);

  const progressBeforeFullscreen = await page.locator('.reader-engine-label').textContent();
  await page.getByRole('button', { name: /^Full screen$|^全屏$|^Plein écran$/ }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(readerSidebar).toBeHidden();
  await expect(page.locator('.reader-engine-label')).toHaveText(progressBeforeFullscreen ?? '');
  await expect(page.locator('.reader-page')).toHaveClass(/reader-page--toolbar-hidden/, {
    timeout: 3_000,
  });
  await page.mouse.move(((await page.viewportSize())?.width ?? 600) / 2, 1);
  await expect(page.locator('.reader-page')).not.toHaveClass(/reader-page--toolbar-hidden/);
  await page
    .getByRole('button', { name: /^Exit full screen$|^退出全屏$|^Quitter le plein écran$/ })
    .click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
  await page
    .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
    .click();
  await appearance.selectOption('light');

  await page
    .getByRole('button', {
      name: /Open table of contents|打开目录|Ouvrir le sommaire/,
    })
    .click();
  const tableOfContents = page.getByRole('navigation', {
    name: /Contents|目录|Sommaire/,
  });
  const firstChapter = tableOfContents.getByRole('button', { name: 'A Quiet Beginning' });
  const secondChapter = tableOfContents.getByRole('button', { name: 'Finding an Anchor' });
  await expect(firstChapter).toHaveAttribute('aria-current', 'location');
  await expect(tableOfContents.getByRole('button').first()).toHaveText('A Quiet Beginning');
  await secondChapter.click();
  await expect.poll(() => currentEpubHref(page)).toContain('chapter-2.xhtml');
  await expectEpubHeading(page, 'Finding an Anchor');
  await page
    .getByRole('button', {
      name: /Open table of contents|打开目录|Ouvrir le sommaire/,
    })
    .click();
  await expect(secondChapter).toHaveAttribute('aria-current', 'location');
  await expect(tableOfContents.getByRole('button').first()).toHaveText('Finding an Anchor');
  await firstChapter.click();
  await expect.poll(() => currentEpubHref(page)).toContain('chapter-1.xhtml');
  await expectEpubHeading(page, 'A Quiet Beginning');
  await page
    .getByRole('button', {
      name: /Open table of contents|打开目录|Ouvrir le sommaire/,
    })
    .click();
  await expect(firstChapter).toHaveAttribute('aria-current', 'location');
  await expect(secondChapter).not.toHaveAttribute('aria-current', 'location');
  await page.locator('.reader-title-group').hover();
  await page.screenshot({ path: 'test-results/epub-table-of-contents.png', fullPage: true });
  await page
    .getByRole('button', {
      name: /Open table of contents|打开目录|Ouvrir le sommaire/,
    })
    .click();

  await bookFrame.locator('em').evaluate((element) => {
    const selection = element.ownerDocument.defaultView?.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  await expect(page.locator('.selection-word')).toHaveText('attentive');
  await expect(page.locator('.selection-sentence')).toContainText(
    'Select the word attentive, or select this entire sentence',
  );
  await expect(page.getByText(/giving care or attention/i)).toBeVisible();
  await expect(page.locator('.dictionary-attribution')).toContainText('WordNet');
  const sidebarSenseCount = await page
    .locator('aside.reader-settings .dictionary-result')
    .first()
    .locator('.dictionary-senses > li')
    .count();
  expect(sidebarSenseCount).toBeGreaterThan(1);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dictionary = document.querySelector('aside.reader-settings .dictionary-result');
        const sentenceTranslation = document.querySelector(
          'aside.reader-settings .local-translation-panel',
        );
        return Boolean(
          dictionary &&
          sentenceTranslation &&
          dictionary.compareDocumentPosition(sentenceTranslation) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    )
    .toBe(true);
  await expect(page.getByText(/Local translation|本地翻译|Traduction locale/)).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: /Translation target|翻译目标语言|Langue cible/ }),
  ).toHaveValue(/zh|fr/);
  await expect(
    page.getByText(
      /Install this language model in Settings|请先在设置中安装|Installez ce modèle linguistique/,
    ),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const selectionTools = document.querySelector('.selection-inspector');
        const appearanceSettings = document.querySelector('.reader-appearance-panel');
        return Boolean(
          selectionTools &&
          appearanceSettings &&
          selectionTools.compareDocumentPosition(appearanceSettings) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    )
    .toBe(true);

  await page.getByRole('button', { name: /^Full screen$|^全屏$|^Plein écran$/ }).click();
  await expect(page.locator('.selection-popover-shell')).toBeVisible();
  await expect(page.locator('.selection-popover-shell .selection-word')).toHaveText('attentive');
  await expect(page.locator('.selection-popover-shell .dictionary-result').first()).toBeVisible();
  await expect(
    page
      .locator('.selection-popover-shell .dictionary-result')
      .first()
      .locator('.dictionary-senses > li'),
  ).toHaveCount(sidebarSenseCount);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const dictionary = document.querySelector('.selection-popover-shell .dictionary-result');
        const sentenceTranslation = document.querySelector(
          '.selection-popover-shell .local-translation-panel',
        );
        return Boolean(
          dictionary &&
          sentenceTranslation &&
          dictionary.compareDocumentPosition(sentenceTranslation) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        );
      }),
    )
    .toBe(true);
  await expect(page.locator('.selection-popover-shell .selection-inspector')).toHaveCSS(
    'overflow-y',
    'scroll',
  );
  const popoverScrollTop = await page
    .locator('.selection-popover-shell .selection-inspector')
    .evaluate((popover) => {
      popover.style.maxHeight = '120px';
      popover.scrollTop = 80;
      const scrollTop = popover.scrollTop;
      popover.style.removeProperty('max-height');
      return scrollTop;
    });
  expect(popoverScrollTop).toBeGreaterThan(0);
  const fullscreenReaderWidth = await page.getByTestId('epub-container').evaluate((container) => {
    return container.getBoundingClientRect().width;
  });
  await page.screenshot({ path: 'test-results/epub-selection-popover.png', fullPage: true });
  await page
    .getByRole('button', { name: /^Exit full screen$|^退出全屏$|^Quitter le plein écran$/ })
    .click();
  await page
    .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
    .click();
  await expect
    .poll(() =>
      page
        .getByTestId('epub-container')
        .evaluate((container) => container.getBoundingClientRect().width),
    )
    .toBeLessThan(fullscreenReaderWidth - 200);
  await expect(appearancePanel).toHaveAttribute('open', '');

  await page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }).check();
  await expect(bookFrame.locator('[data-lexianchor-focus="anchor"]').first()).toBeVisible();
  await expect(bookFrame.getByRole('main')).toBeVisible();

  const focusStrength = page.getByRole('combobox', {
    name: /Focus strength|焦点强度|Intensité/,
  });
  await focusStrength.selectOption('light');
  const attentiveAnchor = bookFrame
    .locator('[data-lexianchor-focus="word"]', { hasText: 'attentive' })
    .locator('[data-lexianchor-focus="anchor"]');
  await expect(attentiveAnchor).toHaveText('atte');
  await expect(attentiveAnchor).toHaveCSS('font-weight', '650');
  await focusStrength.selectOption('strong');
  await expect(attentiveAnchor).toHaveText('attent');
  await expect(attentiveAnchor).toHaveCSS('font-weight', '850');

  await page.getByRole('combobox', { name: /^(Font|字体|Police)$/ }).selectOption('sans-serif');
  await page.getByRole('slider', { name: /Text weight|正文字重|Graisse du texte/ }).fill('550');
  await page
    .getByRole('slider', { name: /Letter spacing|字间距|Espacement des lettres/ })
    .fill('0.08');
  await page.getByRole('slider', { name: /Text width|正文宽度|Largeur du texte/ }).fill('70');
  await page
    .getByRole('combobox', { name: /Alignment|文字对齐|Alignement/ })
    .selectOption('justify');
  await expect
    .poll(() =>
      bookFrame.locator('body').evaluate((body) => {
        const style = body.ownerDocument.defaultView?.getComputedStyle(body);
        return {
          fontFamily: style?.fontFamily ?? '',
          fontWeight: style?.fontWeight ?? '',
          letterSpacing: Number.parseFloat(style?.letterSpacing ?? '0'),
          paddingLeft: Number.parseFloat(style?.paddingLeft ?? '0'),
          textAlign: style?.textAlign ?? '',
        };
      }),
    )
    .toMatchObject({
      fontWeight: '550',
      textAlign: 'justify',
    });
  const bodyPresentation = await bookFrame.locator('body').evaluate((body) => {
    const style = body.ownerDocument.defaultView?.getComputedStyle(body);
    return {
      fontFamily: style?.fontFamily ?? '',
      letterSpacing: Number.parseFloat(style?.letterSpacing ?? '0'),
      paddingLeft: Number.parseFloat(style?.paddingLeft ?? '0'),
    };
  });
  expect(bodyPresentation.fontFamily.toLowerCase()).toContain('sans');
  expect(bodyPresentation.letterSpacing).toBeGreaterThan(0);
  expect(bodyPresentation.paddingLeft).toBeGreaterThan(0);
  await expect(bookFrame.getByRole('heading', { name: 'A Quiet Beginning' })).toBeVisible();

  await page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }).uncheck();
  await expect(bookFrame.locator('[data-lexianchor-focus="anchor"]')).toHaveCount(0);
  await expect(bookFrame.locator('em')).toHaveText('attentive');

  await bookFrame.locator('body').click({ position: { x: 24, y: 24 } });
  const continuousSwipe = await bookFrame.locator('body').evaluate((body) => {
    const frame = body.ownerDocument.defaultView?.frameElement;
    const reader = frame?.ownerDocument.querySelector<HTMLElement>(
      '[data-testid="epub-container"]',
    );
    const scroller = reader?.querySelector<HTMLElement>('.epub-container');
    const before = scroller?.scrollLeft ?? 0;
    body.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 120,
        deltaY: 2,
      }),
    );
    return {
      before,
      after: scroller?.scrollLeft ?? 0,
      clientWidth: scroller?.clientWidth ?? 0,
      scrollWidth: scroller?.scrollWidth ?? 0,
      renderedViews: scroller?.querySelectorAll('.epub-view').length ?? 0,
    };
  });
  expect(continuousSwipe.after - continuousSwipe.before).toBeGreaterThan(100);
  expect(continuousSwipe.scrollWidth).toBeGreaterThan(continuousSwipe.clientWidth);
  expect(continuousSwipe.renderedViews).toBeGreaterThan(0);
  await page.waitForTimeout(500);

  const pageTurnEffect = page.getByRole('combobox', {
    name: /Page turn effect|翻页效果|Effet de changement de page/,
  });
  await pageTurnEffect.selectOption('stack');
  await page.waitForTimeout(250);
  const stackedScroller = page.getByTestId('epub-container').locator(':scope > .epub-container');
  const stackedStart = await stackedScroller.evaluate((scroller) => scroller.scrollLeft);
  await page
    .locator('.epub-container iframe')
    .last()
    .contentFrame()
    .locator('body')
    .dispatchEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: 0,
      deltaX: 420,
      deltaY: 2,
    });
  await expect(stackedScroller).toHaveClass(/epub-page-stack-transition/);
  await page.waitForTimeout(30);
  await page.screenshot({ path: 'test-results/epub-stacked-page-turn.png', fullPage: true });
  await expect
    .poll(() => stackedScroller.evaluate((scroller) => scroller.scrollLeft))
    .toBeGreaterThan(stackedStart + 100);
  await expect(stackedScroller).not.toHaveClass(/epub-page-stack-transition/);

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();
  await expect(
    page.locator('.epub-container iframe').first().contentFrame().getByRole('heading', {
      name: 'A Quiet Beginning',
    }),
  ).toBeVisible();
  await page.locator('details.reader-appearance-panel summary').click();
  await expect(
    page.getByRole('combobox', { name: /Focus strength|焦点强度|Intensité/ }),
  ).toHaveValue('strong');
  await expect(page.getByRole('combobox', { name: /^(Font|字体|Police)$/ })).toHaveValue(
    'sans-serif',
  );
  await expect(
    page.getByRole('slider', { name: /Text width|正文宽度|Largeur du texte/ }),
  ).toHaveValue('70');
  await expect(
    page.getByRole('combobox', {
      name: /Page turn effect|翻页效果|Effet de changement de page/,
    }),
  ).toHaveValue('stack');

  await page.screenshot({ path: 'test-results/epub-spike.png', fullPage: true });
});

test('saves, overwrites, restores, and reloads a reading preset with page columns', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();

  await page.locator('details.reader-appearance-panel summary').click();
  const presetSelect = page.getByRole('combobox', {
    name: /Current preset|当前预设|Préréglage actuel/,
  });
  const pageColumns = page.getByRole('combobox', {
    name: /Page columns|页面分栏|Colonnes de page/,
  });
  const fontSize = page.getByRole('slider', {
    name: /Text size|文字大小|Taille du texte/,
  });
  const pageTurnEffect = page.getByRole('combobox', {
    name: /Page turn effect|翻页效果|Effet de changement de page/,
  });

  await expect(presetSelect).toHaveValue('default');
  await pageColumns.selectOption('double');
  await pageTurnEffect.selectOption('stack');
  await fontSize.fill('125');
  await page
    .getByRole('button', {
      name: /Save as preset|保存为预设|Enregistrer comme préréglage/,
    })
    .click();
  const savedPresetId = await presetSelect.inputValue();
  expect(savedPresetId).not.toBe('default');

  await fontSize.fill('135');
  await page
    .getByRole('button', {
      name: /Overwrite current preset|覆盖当前预设|Remplacer le préréglage actuel/,
    })
    .click();

  await page.reload();
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();
  await page.locator('details.reader-appearance-panel summary').click();
  await expect(
    page.getByRole('combobox', {
      name: /Current preset|当前预设|Préréglage actuel/,
    }),
  ).toHaveValue(savedPresetId);
  await expect(
    page.getByRole('combobox', {
      name: /Page columns|页面分栏|Colonnes de page/,
    }),
  ).toHaveValue('double');
  await expect(
    page.getByRole('slider', {
      name: /Text size|文字大小|Taille du texte/,
    }),
  ).toHaveValue('135');
  await expect(
    page.getByRole('combobox', {
      name: /Page turn effect|翻页效果|Effet de changement de page/,
    }),
  ).toHaveValue('stack');

  await page
    .getByRole('button', {
      name: /Restore default settings|回归到默认设置|Rétablir les réglages par défaut/,
    })
    .click();
  await expect(
    page.getByRole('combobox', {
      name: /Current preset|当前预设|Préréglage actuel/,
    }),
  ).toHaveValue('default');
  await expect(
    page.getByRole('combobox', {
      name: /Page columns|页面分栏|Colonnes de page/,
    }),
  ).toHaveValue('single');
  await expect(
    page.getByRole('slider', {
      name: /Text size|文字大小|Taille du texte/,
    }),
  ).toHaveValue('100');
});

test('imports a DRM-free EPUB 2 file from the local device', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();

  await page
    .locator('input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-epub2.epub'));

  await expect(
    page
      .locator('.epub-container iframe')
      .first()
      .contentFrame()
      .getByRole('heading', { name: 'Compatibility Note' }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: /Open table of contents|打开目录|Ouvrir le sommaire/,
    })
    .click();
  await expect(
    page
      .getByRole('navigation', { name: /Contents|目录|Sommaire/ })
      .getByRole('button', { name: 'Compatibility Note' }),
  ).toHaveAttribute('aria-current', 'location');
});

test('imports and reads a text-layer PDF with zoom, selection, gestures, and restored progress', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();

  const pdfPath = resolve('packages/test-fixtures/generated/lexianchor-text.pdf');
  await page.locator('input[type="file"]').setInputFiles(pdfPath);

  const pdfPage = page.locator('.pdf-page');
  const textLayer = page.locator('.pdf-text-layer');
  await expect(pdfPage).toBeVisible();
  await expect(textLayer.locator('span').first()).toBeVisible();
  await expect(page.locator('.reader-engine-label')).toContainText(/1.*3.*33%/);

  const pdfLinks = page.locator('.pdf-annotation-link');
  await expect(pdfLinks).toHaveCount(2);
  await page.context().route('https://example.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<title>LexiAnchor link</title>',
    }),
  );
  const externalPopupPromise = page.waitForEvent('popup');
  await page.locator('.pdf-annotation-link[data-external-url]').click();
  const externalPage = await externalPopupPromise;
  await expect(externalPage).toHaveURL('https://example.com/lexianchor');
  await externalPage.close();

  await page.locator('.pdf-annotation-link[data-internal-page="3"]').click();
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);
  await page.getByRole('spinbutton', { name: /Page|页码|Page/ }).fill('1');
  await expect(page.locator('.reader-engine-label')).toContainText(/1.*3.*33%/);

  const pdfSidebar = page.locator('aside.reader-settings');
  await page.getByRole('combobox', { name: /Appearance|外观|Apparence/ }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page
    .getByRole('button', { name: /Hide reader sidebar|隐藏阅读侧栏|Masquer le panneau/ })
    .click();
  await expect(pdfSidebar).toBeHidden();
  await expect(pdfPage).toBeVisible();
  await page
    .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
    .click();
  await expect(pdfSidebar).toBeVisible();

  await textLayer
    .locator('span', { hasText: 'resilient' })
    .first()
    .evaluate((element) => {
      const textNode = [...element.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('resilient'),
      );

      if (!textNode?.textContent) {
        throw new Error('The resilient text run was not found.');
      }

      const start = textNode.textContent.indexOf('resilient');
      const range = element.ownerDocument.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 'resilient'.length);

      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

  await expect(page.locator('.selection-word')).toHaveText('resilient');
  await expect(page.locator('.selection-sentence')).toContainText(
    'A resilient reader keeps the page steady',
  );
  await expect(page.getByText(/recovering readily from adversity/i)).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Online translation|在线翻译|Traduction/ }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Search on Web|网页搜索|Rechercher/ }),
  ).toBeVisible();
  await expect(page.getByText('recovering readily from adversity')).toBeVisible();
  await expect(page.locator('.dictionary-attribution')).toContainText(
    'Princeton WordNet 3.1 database · © 2006 Princeton University.',
  );
  await page.screenshot({ path: 'test-results/dictionary-panel.png', fullPage: true });

  await page.getByRole('button', { name: /^Full screen$|^全屏$|^Plein écran$/ }).click();
  await expect(page.locator('.selection-popover-shell')).toBeVisible();
  await expect(page.locator('.selection-popover-shell .selection-word')).toHaveText('resilient');
  await page
    .getByRole('button', { name: /^Exit full screen$|^退出全屏$|^Quitter le plein écran$/ })
    .click();
  await page
    .getByRole('button', { name: /Show reader sidebar|显示阅读侧栏|Afficher le panneau/ })
    .click();

  await page
    .getByRole('button', { name: /Online translation|在线翻译|Traduction en ligne/ })
    .click();
  await expect(page.getByRole('alert')).toContainText('resilient');
  await page.getByRole('button', { name: /Cancel|取消|Annuler/ }).click();

  await page
    .context()
    .route('https://www.google.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Search</title>' }),
    );
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('button', { name: /Search on Web|在网页中搜索|Rechercher/ }).click();
  const searchPage = await popupPromise;
  await expect(searchPage).toHaveURL(/google\.com\/search\?q=resilient/);
  await searchPage.close();

  await expect(
    page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }),
  ).toHaveCount(0);
  await expect(page.locator('.pdf-focus-prefix')).toHaveCount(0);

  const zoomControl = page.getByRole('slider', { name: /Zoom|缩放/ });
  await zoomControl.fill('1.5');
  await expect(page.locator('.reader-control output')).toHaveText('150%');

  const pdfGestureTransform = await page.locator('.pdf-reader-stage').evaluate((stage) => {
    stage.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        deltaX: 120,
        deltaY: 2,
      }),
    );
    return stage.querySelector<HTMLElement>('[data-testid="pdf-container"]')?.style.transform ?? '';
  });
  expect(pdfGestureTransform).toContain('translate3d(-120px');
  await expect(page.locator('.reader-engine-label')).toContainText(/2.*3.*67%/);
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page.locator('input[type="file"]').setInputFiles(pdfPath);
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);
  await expect(page.locator('.reader-control output')).toHaveText('150%');
  await expect(
    page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }),
  ).toHaveCount(0);

  await page.screenshot({ path: 'test-results/pdf-text-reader.png', fullPage: true });
});

test('opens an optional 100 MB PDF stress fixture', async ({ page }) => {
  const largePdfPath = process.env.LEXIANCHOR_LARGE_PDF;
  test.skip(!largePdfPath, 'Set LEXIANCHOR_LARGE_PDF to run the large-file stress check.');
  test.setTimeout(90_000);

  if (!largePdfPath) {
    return;
  }

  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page.locator('.import-button input[type="file"]').setInputFiles(largePdfPath);
  await expect(page.locator('.pdf-page')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.reader-engine-label')).toContainText(/1.*3.*33%/);
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/2.*3.*67%/);
});

test('keeps an image-only PDF readable and disables text-only features', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-scan.pdf'));

  await expect(page.locator('.pdf-canvas')).toBeVisible();
  await expect(page.locator('.pdf-text-layer span')).toHaveCount(0);
  await expect(
    page.getByText(/Image-only page|纯图片页面|Page en image/, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }),
  ).toHaveCount(0);

  await page.screenshot({ path: 'test-results/pdf-image-only-reader.png', fullPage: true });
});

test('persists an imported book and its reading progress in local SQLite and OPFS', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-storage', 'opfs-sahpool');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-text.pdf'));

  await expect(page.locator('.pdf-page')).toBeVisible();
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();

  const savedBook = page
    .locator('article[data-book-id]')
    .filter({ hasText: 'lexianchor-text' })
    .first();
  await expect(savedBook).toBeVisible();
  await expect(savedBook.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await page.screenshot({ path: 'test-results/library-persisted.png', fullPage: true });

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-storage', 'opfs-sahpool');
  const recentBook = page
    .locator('article[data-book-id]')
    .filter({ hasText: 'lexianchor-text' })
    .first();
  await expect(recentBook).toBeVisible();
  await expect(recentBook.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');

  await ensureServiceWorkerControl(page);
  await page.context().setOffline(true);
  await page.reload();
  await expect(recentBook).toBeVisible();
  await recentBook.getByRole('button', { name: /Continue|继续|Continuer/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);
});

test('batch imports books and edits persistent library metadata', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const [pdf, epub] = await Promise.all([
    readFile(resolve('packages/test-fixtures/generated/lexianchor-text.pdf')),
    readFile(resolve('packages/test-fixtures/generated/lexianchor-spike.epub')),
  ]);
  await page.evaluate(
    ({ pdfBase64, epubBase64 }) => {
      const decode = (value: string) =>
        Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([decode(pdfBase64)], 'lexianchor-text.pdf', { type: 'application/pdf' }),
      );
      transfer.items.add(
        new File([decode(epubBase64)], 'lexianchor-spike.epub', {
          type: 'application/epub+zip',
        }),
      );
      const pageElement = document.querySelector<HTMLElement>('.library-page');

      if (!pageElement) {
        throw new Error('The library drop target is missing.');
      }

      pageElement.dispatchEvent(
        new DragEvent('dragenter', { bubbles: true, dataTransfer: transfer }),
      );
      pageElement.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    },
    {
      pdfBase64: pdf.toString('base64'),
      epubBase64: epub.toString('base64'),
    },
  );

  const savedBooks = page.locator('article[data-book-id]');
  await expect(savedBooks).toHaveCount(2);
  await expect(page.locator('.reader-page')).toHaveCount(0);
  await expect(
    page.getByText(/Books imported: 2|已导入书籍： 2|Livres importés : 2/),
  ).toBeVisible();

  const epubBook = savedBooks.filter({ hasText: 'lexianchor-spike' });
  await epubBook
    .getByRole('button', {
      name: /Edit details lexianchor-spike|编辑信息 lexianchor-spike|Modifier les informations lexianchor-spike/,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: /Title|书名|Titre/ }).fill('A Personal Reading Copy');
  await dialog.getByRole('textbox', { name: /Author|作者|Auteur/ }).fill('LexiAnchor Tester');
  await dialog.getByRole('textbox', { name: /Book language|书籍语言|Langue du livre/ }).fill('en');
  await dialog.getByRole('button', { name: /Save changes|保存修改|Enregistrer/ }).click();

  const editedBook = savedBooks.filter({ hasText: 'A Personal Reading Copy' });
  await expect(dialog).toHaveCount(0);
  await expect(editedBook).toContainText('LexiAnchor Tester');
  await page.reload();
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await expect(
    page.locator('article[data-book-id]').filter({ hasText: 'A Personal Reading Copy' }),
  ).toContainText('LexiAnchor Tester');
});

test('searches, sorts, and safely deletes books from the local library', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const importInput = page.locator('.import-button input[type="file"]');

  await importInput.setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-text.pdf'));
  await expect(page.locator('.pdf-page')).toBeVisible();
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();

  await importInput.setInputFiles(
    resolve('packages/test-fixtures/generated/lexianchor-spike.epub'),
  );
  await expect(
    page.locator('.epub-container iframe').first().contentFrame().getByRole('heading', {
      name: 'A Quiet Beginning',
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();

  const savedBooks = page.locator('article[data-book-id]');
  const pdfBook = savedBooks.filter({ hasText: 'lexianchor-text' });
  const epubBook = savedBooks.filter({ hasText: 'lexianchor-spike' });
  await expect(savedBooks).toHaveCount(2);

  const search = page.getByRole('searchbox', {
    name: /Search library|搜索书库|Rechercher dans la bibliothèque/,
  });
  await search.fill('lexianchor-text');
  await expect(pdfBook).toBeVisible();
  await expect(epubBook).toBeHidden();
  await search.fill('does-not-exist');
  await expect(
    page.getByRole('heading', {
      name: /No matching books|没有匹配的书籍|Aucun livre correspondant/,
    }),
  ).toBeVisible();
  await search.fill('');

  await page
    .getByRole('combobox', { name: /Sort books|书籍排序|Trier les livres/ })
    .selectOption('title');
  await expect(savedBooks.first()).toContainText('lexianchor-spike');

  const bookId = await pdfBook.getAttribute('data-book-id');

  if (!bookId?.startsWith('book-')) {
    throw new Error('The imported PDF has no content-addressed book id.');
  }

  await pdfBook
    .getByRole('button', {
      name: /Delete lexianchor-text|删除 lexianchor-text|Supprimer lexianchor-text/,
    })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('lexianchor-text');
  await dialog
    .getByRole('checkbox', {
      name: /Keep reading progress|保留阅读进度|Conserver la progression/,
    })
    .check();
  await expect(
    dialog.getByRole('checkbox', {
      name: /Keep word cards|保留词卡|Conserver les fiches/,
    }),
  ).toBeChecked();
  await page.screenshot({ path: 'test-results/library-delete-dialog.png', fullPage: true });
  await dialog
    .getByRole('button', {
      name: /Delete local copy|删除本地副本|Supprimer la copie locale/,
    })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(pdfBook).toHaveCount(0);
  await expect(epubBook).toBeVisible();

  const contentStillExists = await page.evaluate(async (hash) => {
    const root = await navigator.storage.getDirectory();
    const appDirectory = await root.getDirectoryHandle('lexianchor');
    const booksDirectory = await appDirectory.getDirectoryHandle('books');

    try {
      await booksDirectory.getFileHandle(hash);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') {
        return false;
      }

      throw error;
    }
  }, bookId.slice('book-'.length));
  expect(contentStillExists).toBe(false);

  await page.reload();
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await expect(
    page.locator('article[data-book-id]').filter({ hasText: 'lexianchor-text' }),
  ).toHaveCount(0);

  await page
    .locator('.import-button input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-text.pdf'));
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);
});

test('restores an imported EPUB locator from SQLite after localStorage is cleared', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-spike.epub'));

  const bookFrame = page.locator('.epub-container iframe').first().contentFrame();
  await expect(bookFrame.getByRole('heading', { name: 'A Quiet Beginning' })).toBeVisible();
  await page
    .getByRole('button', {
      name: /Open table of contents|打开目录|Ouvrir le sommaire/,
    })
    .click();
  await page
    .getByRole('navigation', { name: /Contents|目录|Sommaire/ })
    .getByRole('button', { name: 'Finding an Anchor' })
    .click();
  await expectEpubHeading(page, 'Finding an Anchor');
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const recentBook = page
    .locator('article[data-book-id]')
    .filter({ hasText: 'lexianchor-spike' })
    .first();
  await expect(recentBook).toBeVisible();
  await recentBook.getByRole('button', { name: /Continue|继续|Continuer/ }).click();

  await expectEpubHeading(page, 'Finding an Anchor');
});

test('keeps the PDF reader usable in a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-text.pdf'));

  await expect(page.locator('.pdf-canvas')).toBeVisible();
  await expect(page.getByRole('slider', { name: /Zoom|缩放/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Next|下一页|Suivant/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/pdf-reader-narrow.png', fullPage: true });
});

test('looks up a WordNet entry while the Web app is offline', async ({ page }) => {
  await page.goto('/');
  await ensureServiceWorkerControl(page);
  await page.context().setOffline(true);

  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const samplePdf = page.getByRole('article').filter({ hasText: 'Anchored Pages' });
  await samplePdf.getByRole('button', { name: /Continue|继续|Continuer/ }).click();

  const textLayer = page.locator('.pdf-text-layer');
  await expect(textLayer.locator('span').first()).toBeVisible();
  await textLayer
    .locator('span', { hasText: 'resilient' })
    .first()
    .evaluate((element) => {
      const textNode = [...element.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('resilient'),
      );

      if (!textNode?.textContent) {
        throw new Error('The resilient text run was not found.');
      }

      const start = textNode.textContent.indexOf('resilient');
      const range = element.ownerDocument.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 'resilient'.length);
      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

  await expect(page.getByText('recovering readily from adversity')).toBeVisible();
});

test('looks up a selected word from the full offline WordNet package', async ({
  context,
  page,
}) => {
  await page.goto('/');
  await ensureServiceWorkerControl(page);
  await context.setOffline(true);

  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const samplePdfCard = page.locator('article').filter({ hasText: 'Anchored Pages' });
  await samplePdfCard.getByRole('button', { name: /Continue|继续|Continuer/ }).click();

  const textLayer = page.locator('.pdf-text-layer');
  await expect(textLayer.locator('span').first()).toBeVisible();
  await textLayer
    .locator('span', { hasText: 'resilient' })
    .first()
    .evaluate((element) => {
      const textNode = [...element.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('resilient'),
      );

      if (!textNode?.textContent) {
        throw new Error('The resilient text run was not found.');
      }

      const start = textNode.textContent.indexOf('resilient');
      const range = element.ownerDocument.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 'resilient'.length);
      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

  await expect(page.getByText(/recovering readily from adversity/i)).toBeVisible();
  await expect(page.locator('.dictionary-attribution')).toContainText('Princeton WordNet');
});

test('reorders, disables, and uses installed bilingual dictionaries offline', async ({ page }) => {
  await page.goto('/');
  await installFreeDictFixtures(page);
  await page.reload();

  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();
  const freeDictCard = page.locator('article[data-dictionary-id="freedict-eng-fra-0.1.6"]').first();
  const chineseDictionaryCard = page
    .locator('article[data-dictionary-id="freedict-eng-zho-2025.11.23"]')
    .first();
  await expect(freeDictCard).toContainText(/Installed|已安装|Installé/);
  await expect(freeDictCard.getByRole('checkbox')).toBeChecked();
  await expect(chineseDictionaryCard).toContainText(/Installed|已安装|Installé/);
  await expect(chineseDictionaryCard.getByRole('checkbox')).toBeChecked();
  await expect(chineseDictionaryCard).toContainText(
    /Automatically generated|自动生成|Généré automatiquement/,
  );

  await freeDictCard
    .getByRole('button', {
      name: /Move up FreeDict|上移 FreeDict|Monter FreeDict/,
    })
    .click();
  await expect(page.locator('article[data-dictionary-id]').first()).toHaveAttribute(
    'data-dictionary-id',
    'freedict-eng-fra-0.1.6',
  );

  await page.reload();
  const settingsNavigation = page.getByRole('button', { name: /Settings|设置|Réglages/ });
  await settingsNavigation.click();
  await expect(settingsNavigation).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: /Home|首页|Accueil/ })).not.toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.locator('article[data-dictionary-id]').first()).toHaveAttribute(
    'data-dictionary-id',
    'freedict-eng-fra-0.1.6',
  );
  await page.getByRole('heading', { level: 1, name: /Settings|设置|Réglages/ }).hover();
  await page.screenshot({
    path: 'test-results/dictionary-settings.png',
    fullPage: true,
    animations: 'disabled',
  });

  async function openAndSelectAttentive() {
    await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
    await page
      .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
      .click();

    const bookFrame = page.locator('.epub-container iframe').first().contentFrame();
    const attentive = bookFrame.locator('em');
    await expect(attentive).toBeVisible();
    await attentive.evaluate((element) => {
      const selection = element.ownerDocument.defaultView?.getSelection();
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.ownerDocument.dispatchEvent(new Event('selectionchange'));
    });
  }

  await ensureServiceWorkerControl(page);
  await page.context().setOffline(true);
  await openAndSelectAttentive();
  await expect(page.locator('.dictionary-result').first()).toContainText('FreeDict');
  await expect(page.locator('.dictionary-result').first()).toContainText('attentif');
  await expect(page.locator('.dictionary-result')).toHaveCount(3);
  await expect(page.locator('.dictionary-result').last()).toContainText('細緻');
  await expect(page.locator('.dictionary-result').last()).toContainText(
    'Paying attention or listening closely.',
  );
  await page.screenshot({
    path: 'test-results/dictionary-multi-provider.png',
    fullPage: true,
    animations: 'disabled',
  });

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();
  await freeDictCard.getByRole('checkbox').uncheck();
  await chineseDictionaryCard.getByRole('checkbox').uncheck();

  await openAndSelectAttentive();
  await expect(page.locator('.dictionary-result').filter({ hasText: 'FreeDict' })).toHaveCount(0);
  await expect(page.locator('.dictionary-result')).toHaveCount(1);
  await expect(page.locator('.dictionary-result')).toContainText('Princeton WordNet');

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await chineseDictionaryCard.getByRole('button', { name: /Remove|移除|Supprimer/ }).click();
  await expect(chineseDictionaryCard).toContainText(/Not installed|未安装|Non installé/);
});

test('imports, queries, and removes a user StarDict dictionary', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();
  const card = page.locator('article[data-dictionary-id="user-stardict"]');
  await expect(card).toContainText(/Not installed|未安装|Non installé/);

  await card.locator('input[type="file"]').setInputFiles(starDictFixtureFiles());
  await expect(card).toContainText('My Reading Dictionary');
  await expect(card).toContainText(/Installed|已安装|Installé/);
  await expect(card.getByRole('checkbox')).toBeChecked();
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: 'test-results/stardict-settings.png',
    fullPage: true,
    animations: 'disabled',
  });

  await page.reload();
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();
  await expect(card).toContainText('My Reading Dictionary');

  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();
  const bookFrame = page.locator('.epub-container iframe').first().contentFrame();
  const attentive = bookFrame.locator('em');
  await expect(attentive).toBeVisible();
  await attentive.evaluate((element) => {
    const selection = element.ownerDocument.defaultView?.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
  });
  await expect(
    page.locator('.dictionary-result').filter({ hasText: 'My Reading Dictionary' }),
  ).toContainText('A careful reader who gives close attention.');

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page.getByRole('button', { name: /Settings|设置|Réglages/ }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: /Remove|移除|Supprimer/ }).click();
  await expect(card).toContainText(/Not installed|未安装|Non installé/);
});

test('saves, searches, and deletes a persistent word card', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  const samplePdfCard = page.locator('article').filter({ hasText: 'Anchored Pages' });
  await samplePdfCard.getByRole('button', { name: /Continue|继续|Continuer/ }).click();

  const textLayer = page.locator('.pdf-text-layer');
  await expect(textLayer.locator('span').first()).toBeVisible();
  await textLayer
    .locator('span', { hasText: 'resilient' })
    .first()
    .evaluate((element) => {
      const textNode = [...element.childNodes].find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('resilient'),
      );

      if (!textNode?.textContent) {
        throw new Error('The resilient text run was not found.');
      }

      const start = textNode.textContent.indexOf('resilient');
      const range = element.ownerDocument.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, start + 'resilient'.length);
      const selection = element.ownerDocument.defaultView?.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

  await expect(page.getByText(/recovering readily from adversity/i)).toBeVisible();
  await page
    .getByRole('button', { name: /Add to word cards|添加到词卡|Ajouter aux fiches/ })
    .click();
  await expect(
    page.getByRole('button', {
      name: /Saved to word cards|已添加到词卡|Enregistré dans les fiches/,
    }),
  ).toBeDisabled();

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  const cardsNavigation = page.getByRole('button', {
    name: /Word cards|词卡|Fiches de mots/,
  });
  await cardsNavigation.click();
  await expect(cardsNavigation).toHaveAttribute('aria-current', 'page');

  const savedCard = page.locator('article[data-word-card-id]').filter({ hasText: 'resilient' });
  await expect(savedCard).toBeVisible();
  await expect(savedCard).toContainText('recovering readily from adversity');
  await expect(savedCard).toContainText(/English definition|英语释义|Définition anglaise/);
  await savedCard
    .getByRole('button', { name: /View details resilient|查看详情 resilient|Voir les détails/ })
    .click();
  const cardDetails = page.locator('.word-card-detail-dialog');
  await expect(cardDetails).toBeVisible();
  await expect(cardDetails).toContainText('Anchored Pages');
  await expect(cardDetails).toContainText('A resilient reader keeps the page steady');
  await expect(cardDetails).toContainText('Princeton WordNet 3.1');
  await expect
    .poll(() => cardDetails.locator('.word-card-english-definition li').count())
    .toBeGreaterThan(1);
  await expect(cardDetails).toContainText(
    /Not provided by this dictionary|该词典未提供|Non fourni par ce dictionnaire/,
  );
  await page.screenshot({ path: 'test-results/word-cards.png', fullPage: true });
  await cardDetails.getByRole('button', { name: /Close|关闭|Fermer/ }).click();

  await ensureServiceWorkerControl(page);
  await page.context().setOffline(true);
  await page.reload();
  await page.getByRole('button', { name: /Word cards|词卡|Fiches de mots/ }).click();
  await expect(savedCard).toBeVisible();

  const search = page.getByRole('searchbox', {
    name: /Search word cards|搜索词卡|Rechercher dans les fiches/,
  });
  await search.fill('adversity');
  await expect(savedCard).toBeVisible();
  await search.fill('does-not-exist');
  await expect(
    page.getByRole('heading', {
      name: /No matching word cards|没有匹配的词卡|Aucune fiche correspondante/,
    }),
  ).toBeVisible();
  await search.fill('');
  await expect(savedCard).toBeVisible();

  await savedCard
    .getByRole('button', { name: /Edit resilient|编辑 resilient|Modifier resilient/ })
    .click();
  const editor = savedCard.locator('form.word-card-editor');
  await editor
    .getByLabel(/English definition|英语释义|Définition anglaise/)
    .fill('Able to recover and keep going.');
  await editor
    .getByLabel(/Root or etymology|词根或词源|Racine ou étymologie/)
    .fill('Latin resilire');
  await editor
    .getByLabel(/Original sentence|原句|Phrase originale/)
    .fill('A resilient reader returns to the page.');
  await page.screenshot({ path: 'test-results/word-card-editor.png', fullPage: true });
  await editor.getByRole('button', { name: /Save changes|保存修改|Enregistrer/ }).click();
  await expect(savedCard).toContainText('Able to recover and keep going.');
  await savedCard
    .getByRole('button', { name: /View details resilient|查看详情 resilient|Voir les détails/ })
    .click();
  await expect(cardDetails).toContainText('Latin resilire');
  await expect(cardDetails).toContainText('A resilient reader returns to the page.');
  await cardDetails.getByRole('button', { name: /Close|关闭|Fermer/ }).click();

  await search.fill('latin');
  await expect(savedCard).toBeVisible();
  await search.fill('');

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: /Export backup|导出备份|Exporter la sauvegarde/ }).click();
  const download = await downloadPromise;
  const exportPath = await download.path();

  if (!exportPath) {
    throw new Error('The word-card backup download has no local path.');
  }

  const backup = JSON.parse(await readFile(exportPath, 'utf8')) as {
    format: string;
    schemaVersion: number;
    cards: Array<{ term: string; rootOrEtymology: string | null }>;
  };
  expect(backup.format).toBe('lexianchor.word-cards');
  expect(backup.schemaVersion).toBe(1);
  expect(backup.cards).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ term: 'resilient', rootOrEtymology: 'Latin resilire' }),
    ]),
  );

  await savedCard
    .getByRole('button', { name: /Delete resilient|删除 resilient|Supprimer resilient/ })
    .click();
  await expect(savedCard).toHaveCount(0);

  await page.locator('.card-transfer-actions input[type="file"]').setInputFiles(exportPath);
  await expect(savedCard).toBeVisible();
  await expect(savedCard).toContainText('Able to recover and keep going.');

  await savedCard
    .getByRole('button', { name: /Delete resilient|删除 resilient|Supprimer resilient/ })
    .click();
  await expect(savedCard).toHaveCount(0);
  await page.getByRole('button', { name: /Undo|撤销|Annuler/ }).click();
  await expect(savedCard).toBeVisible();

  await savedCard
    .getByRole('button', { name: /Delete resilient|删除 resilient|Supprimer resilient/ })
    .click();
  await expect(savedCard).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: /Word cards|词卡|Fiches de mots/ }).click();
  await expect(page.locator('article[data-word-card-id]')).toHaveCount(0);
});

test('opens English word-card details and swipes between cards', async ({ page }) => {
  const timestamp = '2026-07-28T08:00:00.000Z';
  const card = (
    id: string,
    term: string,
    definitions: readonly string[],
    sentence: string,
    createdAt: string,
  ) => ({
    id,
    term,
    normalizedTerm: term.toLocaleLowerCase('en-US'),
    partOfSpeech: 'adjective',
    definition: definitions[0],
    definitions,
    rootOrEtymology: null,
    dictionarySource: 'Princeton WordNet 3.1',
    sourceBookId: null,
    sourceBookTitle: 'Gesture Reading',
    sourceSentence: sentence,
    createdAt,
    updatedAt: timestamp,
    deletedAt: null,
    version: 1,
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Word cards|词卡|Fiches de mots/ }).click();
  await page.locator('.card-transfer-actions input[type="file"]').setInputFiles({
    name: 'word-card-carousel.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        format: 'lexianchor.word-cards',
        schemaVersion: 1,
        exportedAt: timestamp,
        cards: [
          card(
            'carousel-1',
            'attentive',
            ['Giving care and close attention.', 'Taking thoughtful notice of details.'],
            'Stay attentive.',
            '2026-07-27T08:00:00.000Z',
          ),
          card(
            'carousel-2',
            'resilient',
            ['Able to recover quickly.', 'Returning to a stable shape after pressure.'],
            'Remain resilient.',
            '2026-07-28T08:00:00.000Z',
          ),
        ],
      }),
    ),
  });

  const visibleCards = page.locator('article[data-word-card-id]');
  await expect(visibleCards.first()).toHaveAttribute('data-word-card-id', 'carousel-2');
  await page
    .getByRole('combobox', { name: /Sort word cards|词卡排序|Trier les fiches/ })
    .selectOption('oldest');
  await expect(visibleCards.first()).toHaveAttribute('data-word-card-id', 'carousel-1');

  const attentiveCard = page
    .locator('article[data-word-card-id="carousel-1"]')
    .getByRole('button', { name: /View details attentive|查看详情 attentive|Voir les détails/ });
  await expect(attentiveCard).toContainText('Giving care and close attention.');
  await attentiveCard.click();

  const dialog = page.locator('.word-card-detail-dialog');
  const viewport = dialog.locator('.word-card-detail-viewport');
  await expect(dialog.locator('.word-card-detail-toolbar h2')).toHaveText('attentive');
  await expect(dialog).toContainText('Giving care and close attention.');
  await expect(dialog).toContainText('Taking thoughtful notice of details.');
  await viewport.hover();
  await page.mouse.wheel(760, 0);
  await expect(dialog.locator('.word-card-detail-toolbar h2')).toHaveText('resilient');
  await expect(dialog).toContainText('Able to recover quickly.');
  await page.keyboard.press('ArrowLeft');
  await expect(dialog.locator('.word-card-detail-toolbar h2')).toHaveText('attentive');
});
