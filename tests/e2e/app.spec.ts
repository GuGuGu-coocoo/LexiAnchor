import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

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

test('opens the EPUB spike and validates selection and focus markup', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();

  const bookFrame = page.locator('.epub-container iframe').first().contentFrame();
  await expect(bookFrame.getByRole('heading', { name: 'A Quiet Beginning' })).toBeVisible();

  await bookFrame.locator('em').evaluate((element) => {
    const selection = element.ownerDocument.defaultView?.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.ownerDocument.dispatchEvent(new Event('selectionchange'));
  });

  await expect(page.locator('.selection-word')).toHaveText('attentive');
  await expect(page.locator('.selection-sentence')).toContainText(
    'Select the word attentive, or select this entire sentence',
  );
  await expect(page.getByText(/giving care or attention/i)).toBeVisible();
  await expect(page.locator('.dictionary-attribution')).toContainText('WordNet');

  await page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }).check();
  await expect(bookFrame.locator('[data-lexianchor-focus="anchor"]').first()).toBeVisible();
  await expect(bookFrame.getByRole('main')).toBeVisible();

  await page.getByRole('checkbox', { name: /Focus emphasis|焦点加粗|Mise en évidence/ }).uncheck();
  await expect(bookFrame.locator('[data-lexianchor-focus="anchor"]')).toHaveCount(0);

  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(bookFrame.getByRole('heading', { name: 'Finding an Anchor' })).toBeVisible();

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page
    .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
    .click();
  await expect(
    page.locator('.epub-container iframe').first().contentFrame().getByRole('heading', {
      name: 'Finding an Anchor',
    }),
  ).toBeVisible();

  await page.screenshot({ path: 'test-results/epub-spike.png', fullPage: true });
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
});

test('imports and reads a text-layer PDF with zoom, selection, focus, and restored progress', async ({
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

  const focusToggle = page.getByRole('checkbox', {
    name: /Focus emphasis|焦点加粗|Mise en évidence/,
  });
  await focusToggle.check();
  await expect(page.locator('[data-lexianchor-focus="anchor"]').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/pdf-focus-reader.png', fullPage: true });

  const zoomControl = page.getByRole('slider', { name: /Zoom|缩放/ });
  await zoomControl.fill('1.5');
  await expect(page.locator('.reader-control output')).toHaveText('150%');

  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);

  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();
  await page.locator('input[type="file"]').setInputFiles(pdfPath);
  await expect(page.locator('.reader-engine-label')).toContainText(/3.*3.*100%/);
  await expect(page.locator('.reader-control output')).toHaveText('150%');

  await page.screenshot({ path: 'test-results/pdf-text-reader.png', fullPage: true });
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
  ).toBeDisabled();

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

test('restores an imported EPUB locator from SQLite after localStorage is cleared', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Library|书库|Bibliothèque/ }).click();
  await page
    .locator('input[type="file"]')
    .setInputFiles(resolve('packages/test-fixtures/generated/lexianchor-spike.epub'));

  let bookFrame = page.locator('.epub-container iframe').first().contentFrame();
  await expect(bookFrame.getByRole('heading', { name: 'A Quiet Beginning' })).toBeVisible();
  await page.getByRole('button', { name: /Next|下一页|Suivant/ }).click();
  await expect(bookFrame.getByRole('heading', { name: 'Finding an Anchor' })).toBeVisible();
  await page.getByRole('button', { name: /Library|返回书库|Bibliothèque/ }).click();

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const recentBook = page
    .locator('article[data-book-id]')
    .filter({ hasText: 'lexianchor-spike' })
    .first();
  await expect(recentBook).toBeVisible();
  await recentBook.getByRole('button', { name: /Continue|继续|Continuer/ }).click();

  bookFrame = page.locator('.epub-container iframe').first().contentFrame();
  await expect(bookFrame.getByRole('heading', { name: 'Finding an Anchor' })).toBeVisible();
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
  await expect(savedCard).toContainText('Anchored Pages');
  await expect(savedCard).toContainText('A resilient reader keeps the page steady');
  await expect(savedCard).toContainText('Princeton WordNet 3.1');
  await expect(savedCard).toContainText(
    /Not provided by this dictionary|该词典未提供|Non fourni par ce dictionnaire/,
  );
  await page.screenshot({ path: 'test-results/word-cards.png', fullPage: true });

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
