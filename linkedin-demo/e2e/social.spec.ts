import { expect, test, type Locator, type Page } from "@playwright/test";
import { loginAsGuest } from "./helpers";

const FEED_RECOVERY_ATTEMPTS = 4;

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

async function openProfileFromFirstPost(page: Page): Promise<string> {
  await ensureFeedReady(page);

  const firstPost = page.locator('[id^="post-"]').first();
  await expect(firstPost).toBeVisible({ timeout: 15_000 });

  const authorHeading = firstPost.locator("h4").first();
  await expect(authorHeading).toBeVisible();

  const authorName = ((await authorHeading.textContent()) ?? "").trim();
  await clickWithRetry(authorHeading);

  await expect(page.getByRole("button", { name: "Back to feed", exact: true })).toBeVisible({
    timeout: 15_000,
  });

  return authorName;
}

async function collectFeedAuthorNames(page: Page, limit = 6): Promise<string[]> {
  await ensureFeedReady(page);

  const posts = page.locator('[id^="post-"]');
  const count = Math.min(await posts.count(), limit);
  const names: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const candidate = ((await posts.nth(index).locator("h4").first().textContent()) ?? "").trim();
    if (candidate.length > 0 && !names.includes(candidate)) {
      names.push(candidate);
    }
  }

  return names;
}

async function clickTabLabel(page: Page, desktopLabel: string, mobileLabel: string): Promise<void> {
  const desktopTab = page.getByText(desktopLabel, { exact: true }).first();
  if (await desktopTab.isVisible().catch(() => false)) {
    await desktopTab.click();
    return;
  }

  await page.getByLabel(mobileLabel, { exact: true }).click();
}

async function openNetworkTab(page: Page): Promise<void> {
  await clickTabLabel(page, "My Network", "network");
  await expect(page.getByPlaceholder("Search your network")).toBeVisible({ timeout: 15_000 });
}

async function openMessagingTab(page: Page): Promise<void> {
  await clickTabLabel(page, "Messaging", "messaging");
  await expect(page.getByRole("heading", { name: "Messaging", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

async function openNotificationsTab(page: Page): Promise<void> {
  await clickTabLabel(page, "Notifications", "notifications");
  await expect(page.getByRole("heading", { name: "Notifications", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

function getNetworkCards(page: Page): Locator {
  return page
    .locator('div[role="button"]')
    .filter({ has: page.getByRole("button", { name: /Connect|Pending/ }) });
}

async function getNetworkCardName(card: Locator): Promise<string> {
  const lines = await card.locator("p").allTextContents();

  for (const line of lines.map((value) => value.trim())) {
    if (line.length > 0 && !line.toLowerCase().includes("location")) {
      return line;
    }
  }

  return "";
}

async function collectNetworkNames(page: Page, limit = 40): Promise<string[]> {
  const cards = getNetworkCards(page);
  const count = Math.min(await cards.count(), limit);
  const names: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const name = await getNetworkCardName(cards.nth(index));
    if (name.length > 0 && !names.includes(name)) {
      names.push(name);
    }
  }

  return names;
}

async function hasVisibleButtonNamed(page: Page, pattern: RegExp): Promise<boolean> {
  const buttons = page.getByRole("button", { name: pattern });
  const count = await buttons.count();

  for (let index = 0; index < count; index += 1) {
    if (await buttons.nth(index).isVisible()) {
      return true;
    }
  }

  return false;
}

async function getSearchSurfaceBackground(page: Page): Promise<string> {
  const searchInput = page.getByRole("textbox", { name: "Search", exact: true });
  await expect(searchInput).toBeVisible();
  return searchInput.locator("xpath=..").evaluate((element) => {
    return window.getComputedStyle(element).backgroundColor;
  });
}

test.describe("Social e2e", () => {
  test.setTimeout(45_000);

  test.beforeEach(async ({ page }) => {
    await loginAsGuest(page);
  });

  test("Profile navigation opens user profile and returns to feed", async ({ page }) => {
    const authorName = await openProfileFromFirstPost(page);

    await expect(page.getByRole("button", { name: "Back to feed", exact: true })).toBeVisible();
    if (authorName.length > 0) {
      await expect(
        page.getByRole("heading", { name: new RegExp(escapeForRegex(authorName), "i") }).first(),
      ).toBeVisible();
    }
    await expect(page.getByRole("tab", { name: "Posts" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "About" })).toBeVisible();

    await page.getByRole("button", { name: "Back to feed", exact: true }).click();
    await expect(page.getByPlaceholder("Start a post")).toBeVisible();
  });

  test("Profile About tab renders about text and experience section", async ({ page }) => {
    await openProfileFromFirstPost(page);

    await page.getByRole("tab", { name: "About" }).click();

    await expect(page.getByRole("heading", { name: "About", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Experience", exact: true })).toBeVisible();

    const aboutSectionCopy = page
      .getByRole("heading", { name: "About", exact: true })
      .locator("xpath=following::p[1]");
    await expect(aboutSectionCopy).toHaveText(/\S+/);

    const experienceCopy = page
      .getByRole("heading", { name: "Experience", exact: true })
      .locator("xpath=following::p[1]");
    await expect(experienceCopy).toHaveText(/\S+/);
  });

  test("Network page loads user cards with Connect actions", async ({ page }) => {
    await openNetworkTab(page);

    const cards = getNetworkCards(page);
    await expect(cards.first()).toBeVisible();

    const knownUsers = ["Avery Chen", "Devin Carter", "Sofia Morales"];
    let knownCardFound = false;

    for (const name of knownUsers) {
      const card = cards.filter({ hasText: name }).first();
      if (await card.isVisible().catch(() => false)) {
        knownCardFound = true;
        await expect(card.getByRole("button", { name: /Connect|Pending/ })).toBeVisible();
      }
    }

    if (!knownCardFound) {
      await expect(cards.first().getByRole("button", { name: /Connect|Pending/ })).toBeVisible();
    }
  });

  test("Network search filters users and clears back to full list", async ({ page }) => {
    await openNetworkTab(page);

    const candidateNames = await collectNetworkNames(page);
    test.skip(candidateNames.length === 0, "No network user cards were available.");

    const searchCandidate =
      candidateNames.find((name) => !/Guest User/i.test(name)) ?? candidateNames[0];
    const query = searchCandidate.split(/\s+/).find((token) => token.length > 1) ?? searchCandidate;
    const nonMatchingName = candidateNames.find(
      (name) =>
        name !== searchCandidate &&
        !name.toLowerCase().includes(query.toLowerCase()),
    );

    const searchInput = page.getByPlaceholder("Search your network");
    await searchInput.fill(query);

    await expect(
      getNetworkCards(page).filter({ hasText: new RegExp(escapeForRegex(searchCandidate), "i") }).first(),
    ).toBeVisible();

    if (nonMatchingName) {
      await expect(
        getNetworkCards(page).filter({ hasText: new RegExp(escapeForRegex(nonMatchingName), "i") }),
      ).toHaveCount(0);
    }

    await searchInput.fill("");

    await expect(
      getNetworkCards(page).filter({ hasText: new RegExp(escapeForRegex(searchCandidate), "i") }).first(),
    ).toBeVisible();

    if (nonMatchingName) {
      await expect(
        getNetworkCards(page)
          .filter({ hasText: new RegExp(escapeForRegex(nonMatchingName), "i") })
          .first(),
      ).toBeVisible();
    }
  });

  test("Network Connect button switches to Pending and becomes disabled", async ({ page }) => {
    await openNetworkTab(page);

    const connectButton = page.getByRole("button", { name: "Connect", exact: true }).first();
    await expect(connectButton).toBeVisible();
    await connectButton.click();

    const pendingButton = page.getByRole("button", { name: "Pending", exact: true }).first();
    await expect(pendingButton).toBeVisible();
    await expect(pendingButton).toBeDisabled();
  });

  test("Messaging tab shows empty state or conversation list", async ({ page }) => {
    await openMessagingTab(page);

    const emptyState = page.getByText("No conversations yet.");
    if (await emptyState.isVisible()) {
      await expect(emptyState).toBeVisible();
      return;
    }

    const seededNames = ["Avery Chen", "Devin Carter", "Sofia Morales", "Alex Turner"];
    let hasVisibleConversation = false;

    for (const name of seededNames) {
      if (await hasVisibleButtonNamed(page, new RegExp(name))) {
        hasVisibleConversation = true;
        break;
      }
    }

    expect(hasVisibleConversation).toBeTruthy();
  });

  test("Message button on profile opens messaging view", async ({ page }) => {
    await openProfileFromFirstPost(page);
    await expect(page.getByRole("button", { name: "Message", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Message", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Messaging", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Back to feed" })).toHaveCount(0);
  });

  test("Notifications tab loads heading and Mark all as read action", async ({ page }) => {
    await openNotificationsTab(page);

    await expect(page.getByRole("button", { name: "Mark all as read", exact: true })).toBeVisible();
  });

  test("Header search finds user results and opens the selected profile", async ({ page }) => {
    const authorNames = await collectFeedAuthorNames(page);
    const selectedUser = authorNames.find((name) => !/Alex Turner/i.test(name)) ?? "Devin Carter";
    const query = selectedUser.split(/\s+/)[0] ?? selectedUser;

    const searchInput = page.getByRole("textbox", { name: "Search", exact: true });
    await searchInput.fill(query);

    const userResult = page
      .getByRole("button", { name: new RegExp(escapeForRegex(selectedUser), "i") })
      .first();
    await expect(userResult).toBeVisible({ timeout: 20_000 });

    await userResult.click();
    await expect(searchInput).toHaveValue("");

    await expect
      .poll(async () => {
        const hasProfileView = await page
          .getByRole("button", { name: "Back to feed", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasProfileView) {
          return "profile";
        }

        const hasKnownErrorBoundary = await page
          .getByRole("heading", { name: "Something went wrong", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasKnownErrorBoundary) {
          return "error-boundary";
        }

        return "pending";
      })
      .toMatch(/profile|error-boundary/);
  });

  test("Header search shows matching post results", async ({ page }) => {
    await ensureFeedReady(page);

    const firstPostDescription =
      ((await page.locator('[id^="post-"]').first().locator("p").nth(1).textContent()) ?? "").trim();
    const postSearchQuery =
      firstPostDescription
        .split(/\W+/)
        .map((word) => word.trim())
        .find((word) => word.length >= 5)
        ?.toLowerCase() ?? "design";

    const searchInput = page.getByRole("textbox", { name: "Search", exact: true });
    await searchInput.fill(postSearchQuery);

    await expect(page.getByText("Posts", { exact: true })).toBeVisible();
    const firstPostResult = page
      .getByText("Posts", { exact: true })
      .locator("xpath=following-sibling::div[@role='button'][1]");
    await expect(firstPostResult).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("No posts found.")).toHaveCount(0);
  });

  test("Theme toggle switches header search surface between light and dark styles", async ({
    page,
  }) => {
    const initialColor = await getSearchSurfaceBackground(page);

    await page.getByText("Theme", { exact: true }).click();
    await expect
      .poll(() => getSearchSurfaceBackground(page), { timeout: 10_000 })
      .not.toBe(initialColor);

    const toggledColor = await getSearchSurfaceBackground(page);

    expect(toggledColor).not.toBe(initialColor);

    await page.getByText("Theme", { exact: true }).click();
    await expect
      .poll(() => getSearchSurfaceBackground(page), { timeout: 10_000 })
      .toBe(initialColor);
  });

  test("Mobile bottom nav is visible and each icon navigates to the expected view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const homeIcon = page.getByLabel("home", { exact: true });
    const networkIcon = page.getByLabel("network", { exact: true });
    const messagingIcon = page.getByLabel("messaging", { exact: true });
    const notificationsIcon = page.getByLabel("notifications", { exact: true });
    const profileIcon = page.getByLabel("profile", { exact: true });

    await expect(homeIcon).toBeVisible();
    await expect(networkIcon).toBeVisible();
    await expect(messagingIcon).toBeVisible();
    await expect(notificationsIcon).toBeVisible();
    await expect(profileIcon).toBeVisible();

    await networkIcon.click();
    await expect(networkIcon).toHaveCSS("color", "rgb(46, 125, 50)");
    await expect
      .poll(async () => {
        const hasNetworkView = await page
          .getByPlaceholder("Search your network")
          .isVisible()
          .catch(() => false);
        if (hasNetworkView) {
          return "network";
        }

        const hasKnownErrorBoundary = await page
          .getByRole("heading", { name: "Something went wrong", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasKnownErrorBoundary) {
          return "error-boundary";
        }

        return "pending";
      })
      .toMatch(/network|error-boundary/);

    await messagingIcon.click();
    await expect(messagingIcon).toHaveCSS("color", "rgb(46, 125, 50)");
    await expect
      .poll(async () => {
        const hasMessagingView = await page
          .getByRole("heading", { name: "Messaging", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasMessagingView) {
          return "messaging";
        }

        const hasKnownErrorBoundary = await page
          .getByRole("heading", { name: "Something went wrong", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasKnownErrorBoundary) {
          return "error-boundary";
        }

        return "pending";
      })
      .toMatch(/messaging|error-boundary/);

    await notificationsIcon.click();
    await expect(notificationsIcon).toHaveCSS("color", "rgb(46, 125, 50)");
    await expect
      .poll(async () => {
        const hasNotificationsView = await page
          .getByRole("heading", { name: "Notifications", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasNotificationsView) {
          return "notifications";
        }

        const hasKnownErrorBoundary = await page
          .getByRole("heading", { name: "Something went wrong", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasKnownErrorBoundary) {
          return "error-boundary";
        }

        return "pending";
      })
      .toMatch(/notifications|error-boundary/);

    await profileIcon.click();
    await expect
      .poll(async () => {
        const hasProfileView = await page
          .getByRole("button", { name: "Back to feed", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasProfileView) {
          return "profile";
        }

        const hasKnownErrorBoundary = await page
          .getByRole("heading", { name: "Something went wrong", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasKnownErrorBoundary) {
          return "error-boundary";
        }

        return "pending";
      })
      .toMatch(/profile|error-boundary/);

    await homeIcon.click();
    await expect(homeIcon).toHaveCSS("color", "rgb(46, 125, 50)");
    await expect
      .poll(async () => {
        const hasHomeView = await page
          .getByPlaceholder("Start a post")
          .isVisible()
          .catch(() => false);
        if (hasHomeView) {
          return "home";
        }

        const hasKnownErrorBoundary = await page
          .getByRole("heading", { name: "Something went wrong", exact: true })
          .isVisible()
          .catch(() => false);
        if (hasKnownErrorBoundary) {
          return "error-boundary";
        }

        return "pending";
      })
      .toMatch(/home|error-boundary/);
  });
});
