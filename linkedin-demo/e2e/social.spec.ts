import { expect, test } from "@playwright/test";
import { loginAsGuest } from "./helpers";

test.describe("Social e2e", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsGuest(page);
  });

  test("Profile navigation opens user profile and returns to feed", async ({ page }) => {
    await page.getByRole("heading", { name: "Avery Chen", exact: true }).first().click();

    await expect(page.getByRole("button", { name: "Back to feed" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Avery Chen", exact: true }).first()).toBeVisible();
    await expect(
      page.getByText("Design Systems Lead @ Figma's Fever Dream").first(),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: "Posts" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "About" })).toBeVisible();

    await page.getByRole("button", { name: "Back to feed" }).click();
    await expect(page.getByPlaceholder("Start a post")).toBeVisible();
  });

  test("Profile About tab renders about text and experience section", async ({ page }) => {
    await page.getByRole("heading", { name: "Avery Chen", exact: true }).first().click();

    await page.getByRole("tab", { name: "About" }).click();

    await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
    await expect(page.getByText("No about information yet.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Experience", exact: true })).toBeVisible();
    await expect(page.getByText("No experience added yet.")).toBeVisible();
  });
});
