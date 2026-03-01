import { expect, test, type Page } from "@playwright/test";
import { loginAsGuest } from "./helpers";

async function openNetworkTab(page: Page): Promise<void> {
  await page.getByText("My Network", { exact: true }).click();
  await expect(page.getByPlaceholder("Search your network")).toBeVisible();
}

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

  test("Network page loads user cards with Connect actions", async ({ page }) => {
    await openNetworkTab(page);

    const seededUsers = ["Avery Chen", "Devin Carter", "Sofia Morales"];
    for (const name of seededUsers) {
      const userCard = page.getByRole("button", { name: new RegExp(name) });
      await expect(userCard).toHaveCount(1);
      await expect(userCard.getByRole("button", { name: "Connect" })).toBeVisible();
    }
  });

  test("Network search filters users and clears back to full list", async ({ page }) => {
    await openNetworkTab(page);

    const searchInput = page.getByPlaceholder("Search your network");
    await searchInput.fill("Avery");

    await expect(page.getByRole("button", { name: /Avery Chen/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Devin Carter/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Sofia Morales/ })).toHaveCount(0);

    await searchInput.fill("");

    await expect(page.getByRole("button", { name: /Avery Chen/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Devin Carter/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Sofia Morales/ })).toHaveCount(1);
  });

  test("Network Connect button switches to Pending and becomes disabled", async ({ page }) => {
    await openNetworkTab(page);

    const averyCard = page.getByRole("button", { name: /Avery Chen/ });
    const connectButton = averyCard.getByRole("button", { name: "Connect" });
    await connectButton.click();

    const pendingButton = averyCard.getByRole("button", { name: "Pending" });
    await expect(pendingButton).toBeVisible();
    await expect(pendingButton).toBeDisabled();
  });
});
