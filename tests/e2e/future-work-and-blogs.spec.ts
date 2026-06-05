import { expect, test } from '@playwright/test';

test.describe('future work and blogs pages', () => {
  test('home page links to future work and blogs', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('.nav-pill').filter({ hasText: 'Future Work' })).toHaveAttribute(
      'href',
      '/future-work/',
    );
    await expect(page.locator('.nav-pill').filter({ hasText: 'Blogs' })).toHaveAttribute(
      'href',
      '/blogs/',
    );
  });

  test('future work page summarizes research and court limits', async ({ page }) => {
    await page.goto('/future-work/');

    await expect(
      page.getByRole('heading', {
        name: 'What the last 15 years of anti-corruption experiments teach USACC.',
      }),
    ).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Why it matters for USACC' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Why existing courts cannot simply do the USACC job.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Supreme Court procedures - U.S. Courts' })).toBeVisible();
  });

  test('blogs page contains three authored essays', async ({ page }) => {
    await page.goto('/blogs/');

    await expect(page.getByRole('heading', { name: 'Three notes on what USACC is really trying to build.' })).toBeVisible();
    await expect(page.locator('.blog-post')).toHaveCount(3);
    await expect(page.getByText('By USACC Research Desk / May 16, 2026')).toHaveCount(3);
    await expect(
      page.locator('.blog-post h2').filter({ hasText: 'The Externality Docket' }),
    ).toBeVisible();
    await expect(page.locator('.blog-post h2').filter({ hasText: 'Proof-of-Process' })).toBeVisible();
    await expect(
      page.locator('.blog-post h2').filter({ hasText: 'Against the Hero Prosecutor' }),
    ).toBeVisible();
  });
});
