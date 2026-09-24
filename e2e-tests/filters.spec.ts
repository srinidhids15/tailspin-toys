import { test, expect } from '@playwright/test';

test.describe('Game catalog filters', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('filters by category and publisher, then clears filters', async ({ page }) => {
    const cards = page.getByTestId('game-card');
    const categoryFilter = page.getByTestId('category-filter');
    const publisherFilter = page.getByTestId('publisher-filter');
    const count = page.getByTestId('game-count');

    await expect(cards).toHaveCount(21);
    await expect(count).toHaveText('Showing 21 of 21 games');

    await categoryFilter.selectOption({ label: 'Adventure' });
    await expect(cards.filter({ visible: true })).toHaveCount(4);
    await expect(count).toHaveText('Showing 4 of 21 games');

    await publisherFilter.selectOption({ label: 'CodeForge Studios' });
    await expect(cards.filter({ visible: true })).toHaveCount(1);
    await expect(count).toHaveText('Showing 1 of 21 games');

    await page.getByTestId('clear-filters').click();
    await expect(categoryFilter).toHaveValue('');
    await expect(publisherFilter).toHaveValue('');
    await expect(cards.filter({ visible: true })).toHaveCount(21);
    await expect(count).toHaveText('Showing 21 of 21 games');
  });
});
