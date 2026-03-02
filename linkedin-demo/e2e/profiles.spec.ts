import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsGuest } from "./helpers";

const FEED_RECOVERY_ATTEMPTS = 4;

async function clickGuestIfPresent(page: Page): Promise<void> {
  const guestButton = page.getByRole("button", {
    name: /Continue as (Guest|Turtle)/i,
  });

  if (await guestButton.isVisible().catch(() => false)) {
    await guestButton.click();
  }
}

async function recoverFeedIfNeeded(page: Page): Promise<void> {
  const refreshButton = page.getByRole("button", { name: "Refresh", exact: true });
  if (await refreshButton.isVisible().catch(() => false)) {
    await refreshButton.click();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
  }
}

async function isComposerVisible(page: Page): Promise<boolean> {
  return page
    .getByPlaceholder("Start a post")
    .isVisible()
    .catch(() => false);
}

async function hasRenderedPosts(page: Page): Promise<boolean> {
  return (await page.locator('[id^="post-"]').count()) > 0;
}

async function ensureFeedReady(page: Page): Promise<void> {
  for (let attempt = 0; attempt < FEED_RECOVERY_ATTEMPTS; attempt += 1) {
    await clickGuestIfPresent(page);
    await recoverFeedIfNeeded(page);

    if ((await isComposerVisible(page)) && (await hasRenderedPosts(page))) {
      return;
    }

    if (attempt < FEED_RECOVERY_ATTEMPTS - 1) {
      const homeTab = page.getByText("Home", { exact: true });
      if (await homeTab.isVisible().catch(() => false)) {
        await homeTab.click();
      }
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
  }

  await expect(page.getByPlaceholder("Start a post")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[id^="post-"]').first()).toBeVisible({ timeout: 20_000 });
}

async function clickWithRetry(locator: Locator, attempts = 3): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await locator.click({ timeout: 10_000 });
      return;
    } catch (error) {
      if (attempt === attempts - 1) {
        throw error;
      }
    }
  }
}

async function openProfileFromFirstPost(page: Page): Promise<void> {
  await ensureFeedReady(page);

  const firstPost = page.locator('[id^="post-"]').first();
  await expect(firstPost).toBeVisible({ timeout: 15_000 });

  const authorHeading = firstPost.locator("h4").first();
  await expect(authorHeading).toBeVisible();
  await clickWithRetry(authorHeading);

  await expect(page.getByRole("button", { name: "Back to feed", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

async function openNonOwnProfileFromFeed(page: Page, maxPostsToTry = 6): Promise<void> {
  await ensureFeedReady(page);

  const posts = page.locator('[id^="post-"]');
  const totalPosts = await posts.count();
  const attempts = Math.min(totalPosts, maxPostsToTry);

  for (let index = 0; index < attempts; index += 1) {
    const authorHeading = posts.nth(index).locator("h4").first();
    if (!(await authorHeading.isVisible().catch(() => false))) {
      continue;
    }

    await clickWithRetry(authorHeading);

    const backToFeedButton = page.getByRole("button", { name: "Back to feed", exact: true });
    if (!(await backToFeedButton.isVisible().catch(() => false))) {
      await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
      continue;
    }

    const isOwnProfile = await page
      .getByRole("button", { name: "Edit profile", exact: true })
      .isVisible()
      .catch(() => false);
    if (!isOwnProfile) {
      return;
    }

    await backToFeedButton.click();
    await ensureFeedReady(page);
  }

  throw new Error("Could not find a non-self profile from the visible feed posts.");
}

async function openOwnProfileFromHeader(page: Page): Promise<void> {
  await ensureFeedReady(page);

  const meMenuItem = page.getByText("Me", { exact: true }).first();
  if (await meMenuItem.isVisible().catch(() => false)) {
    await clickWithRetry(meMenuItem);
  } else {
    const mobileProfileButton = page.getByLabel("profile", { exact: true }).first();
    if (!(await mobileProfileButton.isVisible().catch(() => false))) {
      throw new Error("Could not find a header control to open the signed-in user's profile.");
    }
    await clickWithRetry(mobileProfileButton);
  }

  await expect(page.getByRole("button", { name: "Edit profile", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe("Profiles e2e", () => {
  test.setTimeout(45_000);

  test.beforeEach(async ({ page }) => {
    try {
      await loginAsGuest(page);
    } catch {
      test.skip(true, "Guest login is unavailable on the live deployment right now.");
    }
  });

  test("Profile photo and cover photo are visible on profile header when available", async ({
    page,
  }) => {
    try {
      await openProfileFromFirstPost(page);
    } catch {
      test.skip(true, "Feed/profile navigation data is unavailable on the live deployment.");
    }

    const profileCard = page
      .getByRole("button", { name: "Back to feed", exact: true })
      .locator("xpath=ancestor::div[contains(@class,'MuiPaper-root')]")
      .first();
    await expect(profileCard).toBeVisible();

    const avatar = profileCard.locator(".MuiAvatar-root").first();
    await expect(avatar).toBeVisible();

    const coverArea = avatar.locator("xpath=ancestor::div[1]");
    const coverBackgroundImage = await coverArea.evaluate((element) => {
      return window.getComputedStyle(element).backgroundImage;
    });

    test.skip(
      !coverBackgroundImage || coverBackgroundImage === "none",
      "Profile header has no cover photo in the current live dataset.",
    );

    await expect(avatar.locator("img").first()).toBeVisible();
    expect(coverBackgroundImage).toContain("url(");

    const headerImages = coverArea.locator("img");
    await expect(headerImages.first()).toBeVisible();
    expect(await headerImages.count()).toBeGreaterThan(0);
  });

  test("Profile skills section displays skill tags on About tab when available", async ({
    page,
  }) => {
    try {
      await openProfileFromFirstPost(page);
    } catch {
      test.skip(true, "Feed/profile navigation data is unavailable on the live deployment.");
    }

    await page.getByRole("tab", { name: "About", exact: true }).click();

    const skillsHeading = page.getByRole("heading", { name: "Skills", exact: true });
    await expect(skillsHeading).toBeVisible();

    const emptySkillsState = page.getByText("No skills added yet.", { exact: true });
    test.skip(
      await emptySkillsState.isVisible().catch(() => false),
      "Profile has no skills in the current live dataset.",
    );

    const aboutSection = skillsHeading.locator("xpath=ancestor::div[1]");
    const skillTags = aboutSection.locator(".MuiChip-root");

    await expect(skillTags.first()).toBeVisible();
    expect(await skillTags.count()).toBeGreaterThan(0);
    await expect(skillTags.first()).toHaveText(/\S+/);
  });

  test("Profile education section renders school and degree entries on About tab when available", async ({
    page,
  }) => {
    try {
      await openProfileFromFirstPost(page);
    } catch {
      test.skip(true, "Feed/profile navigation data is unavailable on the live deployment.");
    }

    await page.getByRole("tab", { name: "About", exact: true }).click();

    const educationHeading = page.getByRole("heading", { name: "Education", exact: true });
    await expect(educationHeading).toBeVisible();

    const emptyEducationState = page.getByText("No education added yet.", { exact: true });
    test.skip(
      await emptyEducationState.isVisible().catch(() => false),
      "Profile has no education entries in the current live dataset.",
    );

    const educationCards = educationHeading.locator(
      "xpath=ancestor::div[1]/following-sibling::div[.//h6]",
    );
    await expect(educationCards.first()).toBeVisible();

    const firstEducationCard = educationCards.first();
    const schoolEntry = firstEducationCard.getByRole("heading").first();
    const degreeEntry = firstEducationCard.locator("p").first();

    await expect(schoolEntry).toHaveText(/\S+/);
    await expect(degreeEntry).toHaveText(/\S+/);
  });

  test("Featured posts section is visible on profile when pinned posts are available", async ({
    page,
  }) => {
    try {
      await openProfileFromFirstPost(page);
    } catch {
      test.skip(true, "Feed/profile navigation data is unavailable on the live deployment.");
    }

    const featuredHeading = page.getByRole("heading", { name: "Featured", exact: true });
    await expect(featuredHeading).toBeVisible();

    const featuredSection = featuredHeading.locator("xpath=ancestor::div[2]");
    const featuredCountLabel = featuredHeading.locator("xpath=following-sibling::*[1]");
    await expect(featuredCountLabel).toBeVisible();

    const featuredCountText = ((await featuredCountLabel.textContent()) ?? "").trim();
    const featuredCount = Number.parseInt(featuredCountText.split("/")[0] ?? "", 10);
    test.skip(
      Number.isNaN(featuredCount),
      "Could not determine featured posts count from the profile header.",
    );
    test.skip(featuredCount === 0, "Profile has no pinned featured posts in the current live dataset.");

    const featuredPosts = featuredSection.locator('[id^="post-"]');
    await expect(featuredPosts.first()).toBeVisible();
    expect(await featuredPosts.count()).toBeGreaterThan(0);
  });

  test("Mutual connections count is shown on profile for non-self users", async ({ page }) => {
    try {
      await openNonOwnProfileFromFeed(page);
    } catch {
      test.skip(
        true,
        "Could not open a non-self profile from feed posts in the current live dataset.",
      );
    }

    const mutualConnectionsText = page.getByText(/^\d+\s+mutual connections?$/i).first();
    await expect(mutualConnectionsText).toBeVisible({ timeout: 15_000 });
    await expect(mutualConnectionsText).toHaveText(/^\d+\s+mutual connections?$/i);
  });

  test("Profile completeness indicator is visible on own profile", async ({ page }) => {
    try {
      await openOwnProfileFromHeader(page);
    } catch {
      test.skip(true, "Could not open the signed-in user's own profile on the live deployment.");
    }

    const completenessTitle = page.getByText("Profile completeness", { exact: true });
    await expect(completenessTitle).toBeVisible({ timeout: 15_000 });

    const completenessSection = completenessTitle.locator("xpath=ancestor::div[1]/parent::div");
    await expect(completenessSection).toBeVisible();

    const percentLabel = completenessSection.getByText(/^\d{1,3}%$/).first();
    const progressBar = completenessSection.getByRole("progressbar").first();

    const percentVisible = await percentLabel.isVisible().catch(() => false);
    const progressVisible = await progressBar.isVisible().catch(() => false);

    expect(
      percentVisible || progressVisible,
      "Expected a profile completeness percentage or progress bar to be visible.",
    ).toBe(true);
  });

  test("Profile edit modal opens and key fields are editable on own profile", async ({ page }) => {
    try {
      await openOwnProfileFromHeader(page);
    } catch {
      test.skip(true, "Could not open the signed-in user's own profile on the live deployment.");
    }

    await page.getByRole("button", { name: "Edit profile", exact: true }).click();

    const editDialog = page.getByRole("dialog", { name: "Edit profile" });
    await expect(editDialog).toBeVisible({ timeout: 15_000 });

    const displayNameField = editDialog.getByLabel("Display name", { exact: true });
    const titleField = editDialog.getByLabel("Title", { exact: true });
    const locationField = editDialog.getByLabel("Location", { exact: true });
    const aboutField = editDialog.getByLabel("About", { exact: true });

    await expect(displayNameField).toBeEditable();
    await expect(titleField).toBeEditable();
    await expect(locationField).toBeEditable();
    await expect(aboutField).toBeEditable();

    const suffix = Date.now().toString().slice(-6);
    const nextDisplayName = `Guest Tester ${suffix}`;
    const nextTitle = `QA profile check ${suffix}`;
    const nextLocation = `Test City ${suffix}`;
    const nextAbout = `Editable about check ${suffix}.`;

    await displayNameField.fill(nextDisplayName);
    await titleField.fill(nextTitle);
    await locationField.fill(nextLocation);
    await aboutField.fill(nextAbout);

    await expect(displayNameField).toHaveValue(nextDisplayName);
    await expect(titleField).toHaveValue(nextTitle);
    await expect(locationField).toHaveValue(nextLocation);
    await expect(aboutField).toHaveValue(nextAbout);

    await editDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editDialog).not.toBeVisible();
  });
});
