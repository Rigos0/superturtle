import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";

const MAX_POST_IMAGES = 4;
const HASHTAG_REGEX = /(^|[^a-zA-Z0-9_])#([a-zA-Z0-9_]+)/g;

const extractHashtags = (description: string) => {
  const uniqueTags = new Set<string>();
  const matches = description.matchAll(HASHTAG_REGEX);

  for (const match of matches) {
    const rawTag = match[2]?.trim().toLowerCase();
    if (!rawTag) {
      continue;
    }
    uniqueTags.add(rawTag);
  }

  return Array.from(uniqueTags);
};

const normalizeImageStorageIds = (storageIds?: Id<"_storage">[]) => {
  if (!Array.isArray(storageIds)) {
    return [];
  }

  const uniqueStorageIds: Id<"_storage">[] = [];
  const seenStorageIds = new Set<Id<"_storage">>();

  for (const storageId of storageIds) {
    if (seenStorageIds.has(storageId)) {
      continue;
    }

    seenStorageIds.add(storageId);
    uniqueStorageIds.push(storageId);

    if (uniqueStorageIds.length >= MAX_POST_IMAGES) {
      break;
    }
  }

  return uniqueStorageIds;
};

const resolvePostImageUrls = async (
  ctx: { storage: { getUrl: (storageId: Id<"_storage">) => Promise<string | null> } },
  post: Doc<"posts">,
) => {
  if (post.imageStorageIds?.length) {
    const resolvedUrls = await Promise.all(
      post.imageStorageIds.map((storageId) => ctx.storage.getUrl(storageId)),
    );

    return resolvedUrls.filter((url): url is string => typeof url === "string" && url.length > 0);
  }

  if (post.fileType === "image" && post.fileData) {
    return [post.fileData];
  }

  return [];
};

export const listPosts = query({
  args: {},
  handler: async (ctx) => {
    const viewerId = await getAuthUserId(ctx);
    const posts = await ctx.db.query("posts").collect();
    const connectedAuthorIds = new Set<Id<"users">>();

    if (viewerId) {
      const [requestedConnections, receivedConnections] = await Promise.all([
        ctx.db
          .query("connections")
          .withIndex("byUser1", (q) => q.eq("userId1", viewerId).eq("status", "accepted"))
          .collect(),
        ctx.db
          .query("connections")
          .withIndex("byUser2", (q) => q.eq("userId2", viewerId).eq("status", "accepted"))
          .collect(),
      ]);

      for (const connection of requestedConnections) {
        connectedAuthorIds.add(connection.userId2);
      }

      for (const connection of receivedConnections) {
        connectedAuthorIds.add(connection.userId1);
      }
    }

    const visiblePosts = posts.filter((post) => {
      if (post.visibility !== "connections") {
        return true;
      }

      if (!viewerId) {
        return false;
      }

      if (post.authorId === viewerId) {
        return true;
      }

      return connectedAuthorIds.has(post.authorId);
    });

    const sortedPosts = [...visiblePosts].sort((a, b) => b.createdAt - a.createdAt);

    return await Promise.all(
      sortedPosts.map(async (post) => {
        const author = await ctx.db.get(post.authorId);
        const imageUrls = await resolvePostImageUrls(ctx, post);
        const resolvedFileData =
          post.fileType === "image" && imageUrls.length > 0 ? imageUrls[0] : post.fileData;
        const likes = await ctx.db
          .query("likes")
          .filter((q) => q.eq(q.field("postId"), post._id))
          .collect();
        const comments = await ctx.db
          .query("comments")
          .filter((q) => q.eq(q.field("postId"), post._id))
          .collect();
        const reposts = await ctx.db
          .query("reposts")
          .withIndex("byOriginalPost", (q) => q.eq("originalPostId", post._id))
          .collect();

        return {
          ...post,
          fileData: resolvedFileData,
          likesCount: likes.length,
          commentsCount: comments.length,
          repostCount: reposts.length,
          imageUrls,
          author: author
            ? {
                displayName: author.displayName ?? author.name ?? "Guest User",
                photoURL: author.photoURL ?? author.image ?? "",
                title: author.title ?? "",
                username: author.username ?? "",
              }
            : null,
        };
      }),
    );
  },
});

export const listPostsByUser = query({
  args: {
    authorId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const posts = await ctx.db
      .query("posts")
      .filter((q) => q.eq(q.field("authorId"), args.authorId))
      .collect();
    const sortedPosts = [...posts].sort((a, b) => b.createdAt - a.createdAt);

    return await Promise.all(
      sortedPosts.map(async (post) => {
        const author = await ctx.db.get(post.authorId);
        const imageUrls = await resolvePostImageUrls(ctx, post);
        const resolvedFileData =
          post.fileType === "image" && imageUrls.length > 0 ? imageUrls[0] : post.fileData;
        const likes = await ctx.db
          .query("likes")
          .filter((q) => q.eq(q.field("postId"), post._id))
          .collect();
        const comments = await ctx.db
          .query("comments")
          .filter((q) => q.eq(q.field("postId"), post._id))
          .collect();
        const reposts = await ctx.db
          .query("reposts")
          .withIndex("byOriginalPost", (q) => q.eq("originalPostId", post._id))
          .collect();

        return {
          ...post,
          fileData: resolvedFileData,
          likesCount: likes.length,
          commentsCount: comments.length,
          repostCount: reposts.length,
          imageUrls,
          author: author
            ? {
                displayName: author.displayName ?? author.name ?? "Guest User",
                photoURL: author.photoURL ?? author.image ?? "",
                title: author.title ?? "",
                username: author.username ?? "",
              }
            : null,
        };
      }),
    );
  },
});

export const searchPosts = query({
  args: {
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedQuery = args.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const posts = await ctx.db.query("posts").collect();
    const matchingPosts = [...posts]
      .filter((post) =>
        post.description.toLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10);

    return await Promise.all(
      matchingPosts.map(async (post) => {
        const author = await ctx.db.get(post.authorId);
        const imageUrls = await resolvePostImageUrls(ctx, post);
        const resolvedFileData =
          post.fileType === "image" && imageUrls.length > 0 ? imageUrls[0] : post.fileData;
        return {
          _id: post._id,
          authorId: post.authorId,
          description: post.description,
          createdAt: post.createdAt,
          fileType: post.fileType,
          fileData: resolvedFileData,
          imageUrls,
          author: author
            ? {
                _id: author._id,
                displayName: author.displayName ?? author.name ?? "Guest User",
                photoURL: author.photoURL ?? author.image ?? "",
                title: author.title ?? "",
                username: author.username ?? "",
              }
            : null,
        };
      }),
    );
  },
});

export const createPost = mutation({
  args: {
    authorId: v.id("users"),
    description: v.string(),
    visibility: v.optional(v.union(v.literal("public"), v.literal("connections"))),
    fileType: v.optional(v.string()),
    fileData: v.optional(v.string()),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const imageStorageIds = normalizeImageStorageIds(args.imageStorageIds);
    const hasStorageImages = imageStorageIds.length > 0;
    const postId = await ctx.db.insert("posts", {
      authorId: args.authorId,
      description: args.description,
      visibility: args.visibility ?? "public",
      createdAt: Date.now(),
      likesCount: 0,
      commentsCount: 0,
      ...(hasStorageImages ? { imageStorageIds, fileType: "image" } : {}),
      ...(!hasStorageImages && args.fileType ? { fileType: args.fileType } : {}),
      ...(!hasStorageImages && args.fileData ? { fileData: args.fileData } : {}),
    });

    const hashtags = extractHashtags(args.description);
    if (hashtags.length > 0) {
      await Promise.all(
        hashtags.map((tag) =>
          ctx.db.insert("hashtags", {
            tag,
            postId,
          }),
        ),
      );
    }

    return postId;
  },
});

export const generateImageUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

export const deletePost = mutation({
  args: {
    postId: v.id("posts"),
  },
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);
    if (post?.imageStorageIds?.length) {
      await Promise.all(post.imageStorageIds.map((storageId) => ctx.storage.delete(storageId)));
    }

    await ctx.db.delete(args.postId);
  },
});

export const updatePost = mutation({
  args: {
    postId: v.id("posts"),
    description: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.postId, {
      description: args.description,
    });
  },
});
