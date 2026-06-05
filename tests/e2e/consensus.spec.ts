import { expect, test } from '@playwright/test';

test.describe('consensus page', () => {
  test('home page links to the Kleros-inspired consensus brief', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.nav-pill').filter({ hasText: 'Consensus' })).toHaveAttribute(
      'href',
      '/consensus/',
    );
    await expect(page.getByRole('link', { name: 'Consensus design' })).toHaveAttribute(
      'href',
      '/consensus/',
    );
  });

  test('consensus page explains the USACC translation with diagrams', async ({ page }) => {
    await page.goto('/consensus/');

    await expect(
      page.getByRole('heading', { name: 'Consensus as an anti-capture layer.' }),
    ).toBeVisible();
    await expect(page.getByText('Kleros is useful to USACC in two different ways')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'USACC translation' })).toBeVisible();
    await expect(
      page.getByRole('heading', {
        name: 'Where Kleros itself could help before USACC builds a custom system.',
      }),
    ).toBeVisible();
    await expect(page.locator('.chart-card svg')).toHaveCount(2);
  });
});
