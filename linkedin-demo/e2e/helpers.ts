import { expect, type Page } from "@playwright/test";

export async function loginAsGuest(page: Page): Promise<void> {
  const composer = page.getByPlaceholder("Start a post");
  const guestButton = page.getByRole("button", {
    name: /Continue as (Guest|Turtle)/i,
  });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto("/", { waitUntil: "domcontentloaded" });

    if (await composer.isVisible().catch(() => false)) {
      return;
    }

    if (await guestButton.isVisible().catch(() => false)) {
      await guestButton.click({ timeout: 15_000 });
      if (await composer.isVisible().catch(() => false)) {
        return;
      }
    }

    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  }

  await expect(composer).toBeVisible({ timeout: 20_000 });
}
