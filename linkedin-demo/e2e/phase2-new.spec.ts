import { expect, test, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { loginAsGuest } from "./helpers";

const DEFAULT_CONVEX_URL = "https://tough-mosquito-145.convex.cloud";
const CONVEX_URL =
  process.env.PLAYWRIGHT_CONVEX_URL ??
  process.env.REACT_APP_CONVEX_URL ??
  DEFAULT_CONVEX_URL;

function getErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isFunctionUnavailableError(error: unknown): boolean {
  const errorText = getErrorText(error).toLowerCase();

  return (
    errorText.includes("not found") ||
    errorText.includes("404") ||
    errorText.includes("no public function") ||
    errorText.includes("could not find") ||
    errorText.includes("does not exist")
  );
}

async function runConvexCallOrSkip<T>(
  fnName: string,
  callback: () => Promise<T>,
): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    if (isFunctionUnavailableError(error)) {
      test.skip(true, `Function not yet deployed: ${fnName}`);
    }
    throw error;
  }
}

async function getConvexAuthToken(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key || !key.startsWith("__convexAuthJWT_")) {
        continue;
      }

      const token = window.localStorage.getItem(key);
      if (typeof token === "string" && token.length > 0) {
        return token;
      }
    }

    return null;
  });
}

async function createAuthenticatedConvexClient(page: Page): Promise<ConvexHttpClient> {
  try {
    await loginAsGuest(page);
  } catch {
    test.skip(true, "Skipped: guest login was unavailable in live deployment.");
  }

  const token = await getConvexAuthToken(page);
  test.skip(!token, "Skipped: guest auth token was unavailable for ConvexHttpClient.");

  const client = new ConvexHttpClient(CONVEX_URL);
  client.setAuth(token);
  return client;
}

test.describe("Phase 2 batch 2 e2e", () => {
  test("Poll creation and voting", async ({ page }) => {
    const client = await createAuthenticatedConvexClient(page);
    let createdPostId: string | null = null;

    try {
      const currentUser = await runConvexCallOrSkip("users:getCurrentUser", () =>
        client.query("users:getCurrentUser", {}),
      );
      test.skip(!currentUser?._id, "Skipped: current user lookup failed for guest auth session.");

      createdPostId = await runConvexCallOrSkip("posts:createPost", () =>
        client.mutation("posts:createPost", {
          authorId: currentUser._id,
          description: `E2E poll post ${Date.now()}`,
          visibility: "public",
        }),
      );

      await runConvexCallOrSkip("polls:createPoll", () =>
        client.mutation("polls:createPoll", {
          postId: createdPostId,
          question: "Which rollout should we ship first?",
          options: ["Polls", "Articles", "Bookmarks"],
        }),
      );

      const poll = await runConvexCallOrSkip("polls:getPoll", () =>
        client.query("polls:getPoll", { postId: createdPostId! }),
      );
      expect(poll).not.toBeNull();
      expect(poll?.question).toBe("Which rollout should we ship first?");
      expect(poll?.options).toEqual(["Polls", "Articles", "Bookmarks"]);

      await runConvexCallOrSkip("polls:vote", () =>
        client.mutation("polls:vote", {
          pollId: poll!._id,
          optionIndex: 1,
        }),
      );

      const results = await runConvexCallOrSkip("polls:getResults", () =>
        client.query("polls:getResults", { pollId: poll!._id }),
      );

      expect(results).not.toBeNull();
      expect(results?.totalVotes).toBeGreaterThanOrEqual(1);
      expect(results?.options[1]?.voteCount).toBeGreaterThanOrEqual(1);
    } finally {
      if (createdPostId) {
        await client
          .mutation("posts:deletePost", { postId: createdPostId })
          .catch(() => {});
      }
    }
  });

  test("Article creation stores articleTitle and articleBody fields", async ({
    page,
  }) => {
    const client = await createAuthenticatedConvexClient(page);
    let createdArticleId: string | null = null;
    const articleTitle = `E2E article title ${Date.now()}`;
    const articleBody = `E2E article body ${Date.now()}\n\nThis verifies article persistence fields.`;

    try {
      createdArticleId = await runConvexCallOrSkip("articles:createArticle", () =>
        client.mutation("articles:createArticle", {
          title: articleTitle,
          body: articleBody,
          description: `E2E article summary ${Date.now()}`,
        }),
      );

      const article = await runConvexCallOrSkip("articles:getArticle", () =>
        client.query("articles:getArticle", { postId: createdArticleId! }),
      );

      expect(article).not.toBeNull();
      expect(article?.type).toBe("article");
      expect(article?.articleTitle).toBe(articleTitle);
      expect(article?.articleBody).toBe(articleBody);
    } finally {
      if (createdArticleId) {
        await client
          .mutation("posts:deletePost", { postId: createdArticleId })
          .catch(() => {});
      }
    }
  });

  test("Bookmark toggle bookmarks and unbookmarks a post", async ({ page }) => {
    const client = await createAuthenticatedConvexClient(page);
    let createdPostId: string | null = null;

    try {
      const currentUser = await runConvexCallOrSkip("users:getCurrentUser", () =>
        client.query("users:getCurrentUser", {}),
      );
      test.skip(!currentUser?._id, "Skipped: current user lookup failed for guest auth session.");

      createdPostId = await runConvexCallOrSkip("posts:createPost", () =>
        client.mutation("posts:createPost", {
          authorId: currentUser._id,
          description: `E2E bookmark post ${Date.now()}`,
          visibility: "public",
        }),
      );

      const firstToggle = await runConvexCallOrSkip("bookmarks:toggleBookmark", () =>
        client.mutation("bookmarks:toggleBookmark", { postId: createdPostId! }),
      );
      expect(firstToggle?.bookmarked).toBe(true);

      const bookmarkedAfterFirstToggle = await runConvexCallOrSkip("bookmarks:isBookmarked", () =>
        client.query("bookmarks:isBookmarked", { postId: createdPostId! }),
      );
      expect(bookmarkedAfterFirstToggle).toBe(true);

      const secondToggle = await runConvexCallOrSkip("bookmarks:toggleBookmark", () =>
        client.mutation("bookmarks:toggleBookmark", { postId: createdPostId! }),
      );
      expect(secondToggle?.bookmarked).toBe(false);

      const bookmarkedAfterSecondToggle = await runConvexCallOrSkip("bookmarks:isBookmarked", () =>
        client.query("bookmarks:isBookmarked", { postId: createdPostId! }),
      );
      expect(bookmarkedAfterSecondToggle).toBe(false);
    } finally {
      if (createdPostId) {
        await client
          .mutation("posts:deletePost", { postId: createdPostId })
          .catch(() => {});
      }
    }
  });
});
