import { expect, test } from '@playwright/test';

test.describe('modeling pages', () => {
  test('home page links to the MDP and POMDP modeling pages', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('link', { name: 'Explore modeling' })).toHaveAttribute(
      'href',
      '/modeling/mdp/',
    );

    await expect(page.getByRole('heading', { name: /control logic visible/i })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open MDP model' })).toHaveAttribute(
      'href',
      '/modeling/mdp/',
    );
    await expect(page.getByRole('link', { name: 'Open POMDP model' })).toHaveAttribute(
      'href',
      '/modeling/pomdp/',
    );
  });

  test('MDP page explains the staged control model with Mermaid diagrams', async ({ page }) => {
    await page.goto('/modeling/mdp/');

    await expect(
      page.getByRole('heading', { name: 'The court as a Markov Decision Process.' }),
    ).toBeVisible();
    await expect(page.getByText('The MDP does not decide guilt.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Compare the POMDP' })).toHaveAttribute(
      'href',
      '/modeling/pomdp/',
    );
    await expect(page.locator('.chart-card svg')).toHaveCount(2);
    await expect(page.getByRole('columnheader', { name: 'Meaning for the court' })).toBeVisible();
  });

  test('POMDP page explains belief-based control under hidden state', async ({ page }) => {
    await page.goto('/modeling/pomdp/');

    await expect(
      page.getByRole('heading', { name: 'The court under partial observability.' }),
    ).toBeVisible();
    await expect(page.getByText('A POMDP makes uncertainty explicit.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Start with the MDP' })).toHaveAttribute(
      'href',
      '/modeling/mdp/',
    );
    await expect(page.locator('.chart-card svg')).toHaveCount(2);
    await expect(page.getByRole('columnheader', { name: 'POMDP response' })).toBeVisible();
  });
});
