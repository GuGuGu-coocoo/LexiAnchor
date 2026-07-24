import { expect, test } from '@playwright/test';

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
