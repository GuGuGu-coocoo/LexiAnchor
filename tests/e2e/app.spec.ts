import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

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
