import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const cases = [
  {
    locale: 'en',
    title: 'The reader could not start.',
    dataNotice:
      'This loading error does not clear your books, word cards, presets, or reading progress.',
    returnLabel: 'Return to library',
    libraryTitle: 'Your library',
  },
  {
    locale: 'zh-CN',
    title: '阅读器未能启动。',
    dataNotice: '这次加载错误不会清空书籍、词卡、预设或阅读记录。',
    returnLabel: '返回书库',
    libraryTitle: '你的书库',
  },
  {
    locale: 'fr',
    title: "Le lecteur n'a pas pu démarrer.",
    dataNotice:
      "Cette erreur de chargement n'efface ni vos livres, ni vos fiches de vocabulaire, ni vos préréglages, ni votre progression de lecture.",
    returnLabel: 'Retour à la bibliothèque',
    libraryTitle: 'Votre bibliothèque',
  },
];

for (const labels of cases) {
  test(`${labels.locale}: rejected reader chunk shows a safe library exit instead of a blank root`, async ({
    page,
    context,
  }) => {
    const saved = {
      'lexianchor:reader-preferences': JSON.stringify({
        fontSizePercent: 123,
        pageSpread: 'double',
      }),
      'lexianchor:reader-presets': JSON.stringify({ activePresetId: 'qa-kept', presets: [] }),
      'lexianchor:epub-location:qa-kept': JSON.stringify({
        href: 'kept.xhtml',
        cfi: 'qa-exact-cfi',
        pageNumber: 7,
      }),
    };
    await page.addInitScript(
      ({ locale, data }) => {
        localStorage.setItem('lexianchor:locale', locale);
        for (const [key, value] of Object.entries(data)) localStorage.setItem(key, value);
      },
      { locale: labels.locale, data: saved },
    );
    let rejectedReaderRequests = 0;
    await context.route('**/assets/reader-page-*.js', async (route) => {
      rejectedReaderRequests += 1;
      await route.abort('failed');
    });
    await page.goto('/');
    await page.getByRole('button', { name: /^Library$|^书库$|^Bibliothèque$/ }).click();
    await page
      .getByRole('button', { name: /Open test book|打开测试书|Ouvrir le livre test/ })
      .click();
    const fallback = page.getByTestId('reader-unavailable');
    await expect(fallback).toHaveAttribute('role', 'alert');
    await expect(fallback).toContainText(labels.title);
    await expect(fallback).toContainText(labels.dataNotice);
    expect(rejectedReaderRequests).toBeGreaterThan(0);
    await expect(page.locator('#root')).not.toBeEmpty();
    await expect(page.locator('.epub-container iframe')).toHaveCount(0);
    await fallback.getByRole('button', { name: labels.returnLabel, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: labels.libraryTitle, exact: true }),
    ).toBeVisible();
    await expect(fallback).toHaveCount(0);
    expect(
      await page.evaluate(
        (keys) => Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)])),
        Object.keys(saved),
      ),
    ).toEqual(saved);
  });
}

test('rejected PDF chunk also shows a safe exit without unmounting the app', async ({
  page,
  context,
}) => {
  let rejectedPdfRequests = 0;
  await context.route('**/assets/pdf-reader-page-*.js', async (route) => {
    rejectedPdfRequests += 1;
    await route.abort('failed');
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await page
    .locator('.book-card')
    .filter({ has: page.getByRole('heading', { name: 'Anchored Pages', exact: true }) })
    .getByRole('button')
    .click();
  const fallback = page.getByTestId('reader-unavailable');
  await expect(fallback).toContainText('The reader could not start.');
  expect(rejectedPdfRequests).toBeGreaterThan(0);
  await expect(page.locator('#root')).not.toBeEmpty();
  await fallback.getByRole('button', { name: 'Return to library', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your library', exact: true })).toBeVisible();
  await expect(fallback).toHaveCount(0);
});
