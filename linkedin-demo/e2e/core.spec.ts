import { expect, test, type Page } from "@playwright/test";
import { loginAsGuest } from "./helpers";

async function waitForFeedPosts(page: Page) {
  await expect(page.locator('[id^="post-"]').first()).toBeVisible({ timeout: 15_000 });
}

test("Guest login", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("button", { name: /Continue as Guest/i })).toBeVisible();
  await page.getByRole("button", { name: /Continue as Guest/i }).click();

  await expect(page.getByPlaceholder("Start a post")).toBeVisible();
  await expect(page.getByRole("button", { name: "Post" })).toBeVisible();
  await waitForFeedPosts(page);

  expect(await page.locator('[id^="post-"]').count()).toBeGreaterThan(0);
});

test.describe("Feed", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsGuest(page);
  });

  test("Feed loads posts", async ({ page }) => {
    await waitForFeedPosts(page);

    const posts = page.locator('[id^="post-"]');
    expect(await posts.count()).toBeGreaterThanOrEqual(2);

    const firstPost = posts.first();
    await expect(firstPost.getByRole("heading").first()).toBeVisible();
    await expect(firstPost.getByText(/ago$/i).first()).toBeVisible();

    const firstPostDescription = (await firstPost.locator("p").nth(1).textContent())?.trim() ?? "";
    expect(firstPostDescription.length).toBeGreaterThan(0);
  });
});
