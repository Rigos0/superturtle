import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";
import { buildAuthorSummary } from "./helpers";

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
  ctx: QueryCtx,
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

const buildFeedPostPayload = async (ctx: QueryCtx, post: Doc<"posts">) => {
  const [author, imageUrls, likes, comments, reposts] = await Promise.all([
    ctx.db.get(post.authorId),
    resolvePostImageUrls(ctx, post),
    ctx.db
      .query("likes")
      .filter((q) => q.eq(q.field("postId"), post._id))
      .collect(),
    ctx.db
      .query("comments")
      .filter((q) => q.eq(q.field("postId"), post._id))
      .collect(),
    ctx.db
      .query("reposts")
      .withIndex("byOriginalPost", (q) => q.eq("originalPostId", post._id))
      .collect(),
  ]);

  return {
    ...post,
    fileData: post.fileType === "image" && imageUrls.length > 0 ? imageUrls[0] : post.fileData,
    likesCount: likes.length,
    commentsCount: comments.length,
    repostCount: reposts.length,
    imageUrls,
    author: await buildAuthorSummary(ctx, author),
  };
};

export const listPosts = query({
  args: {
    sortBy: v.optional(
      v.union(v.literal("recent"), v.literal("top"), v.literal("following")),
    ),
    offset: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const sortBy = args.sortBy ?? "recent";
    const rawOffset = Math.floor(args.offset ?? 0);
    const rawLimit = Math.floor(args.limit ?? 10);
    const offset = rawOffset < 0 ? 0 : rawOffset;
    const limit = Math.min(Math.max(rawLimit, 1), 50);
    const viewerId = await getAuthUserId(ctx);
    const posts = await ctx.db.query("posts").collect();
    const connectedAuthorIds = new Set<Id<"users">>();
    const followedAuthorIds = new Set<Id<"users">>();

    if (viewerId) {
      const [requestedConnections, receivedConnections, follows] = await Promise.all([
        ctx.db
          .query("connections")
          .withIndex("byUser1", (q) => q.eq("userId1", viewerId).eq("status", "accepted"))
          .collect(),
        ctx.db
          .query("connections")
          .withIndex("byUser2", (q) => q.eq("userId2", viewerId).eq("status", "accepted"))
          .collect(),
        sortBy === "following"
          ? ctx.db
              .query("follows")
              .withIndex("byFollower", (q) => q.eq("followerId", viewerId))
              .collect()
          : Promise.resolve([]),
      ]);

      for (const connection of requestedConnections) {
        connectedAuthorIds.add(connection.userId2);
      }

      for (const connection of receivedConnections) {
        connectedAuthorIds.add(connection.userId1);
      }

      for (const follow of follows) {
        followedAuthorIds.add(follow.followedId);
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

    const visiblePostById = new Map(visiblePosts.map((post) => [`${post._id}`, post]));
    const [feedPosts, allReposts] = await Promise.all([
      Promise.all(
        visiblePosts.map(async (post) => {
          const payload = await buildFeedPostPayload(ctx, post);
          return {
            ...payload,
            feedItemType: "post" as const,
            feedItemId: post._id,
            targetPostId: post._id,
            feedCreatedAt: post.createdAt,
          };
        }),
      ),
      ctx.db.query("reposts").collect(),
    ]);

    const repostFeedPosts = await Promise.all(
      allReposts.map(async (repost) => {
        const originalPost = visiblePostById.get(`${repost.originalPostId}`);
        if (!originalPost) {
          return null;
        }

        const [reposter, originalPostPayload] = await Promise.all([
          ctx.db.get(repost.userId),
          buildFeedPostPayload(ctx, originalPost),
        ]);

        return {
          _id: originalPostPayload._id,
          authorId: repost.userId,
          description: repost.commentary ?? "",
          visibility: originalPostPayload.visibility,
          fileType: undefined,
          fileData: undefined,
          imageStorageIds: undefined,
          createdAt: repost.createdAt,
          likesCount: originalPostPayload.likesCount,
          commentsCount: originalPostPayload.commentsCount,
          repostCount: originalPostPayload.repostCount,
          imageUrls: [],
          author: await buildAuthorSummary(ctx, reposter),
          feedItemType: "repost" as const,
          feedItemId: repost._id,
          targetPostId: originalPostPayload._id,
          originalPost: {
            _id: originalPostPayload._id,
            authorId: originalPostPayload.authorId,
            description: originalPostPayload.description,
            createdAt: originalPostPayload.createdAt,
            fileType: originalPostPayload.fileType,
            fileData: originalPostPayload.fileData,
            imageUrls: originalPostPayload.imageUrls,
            author: originalPostPayload.author,
          },
          feedCreatedAt: repost.createdAt,
        };
      }),
    );

    const feedItems = [...feedPosts, ...repostFeedPosts]
      .filter((feedItem): feedItem is NonNullable<typeof feedItem> => feedItem !== null)
      .filter((feedItem) => {
        if (sortBy !== "following") {
          return true;
        }

        if (!viewerId) {
          return false;
        }

        if (feedItem.authorId === viewerId) {
          return true;
        }

        return (
          connectedAuthorIds.has(feedItem.authorId) || followedAuthorIds.has(feedItem.authorId)
        );
      });

    const sortedFeedItems = [...feedItems].sort((a, b) => {
      if (sortBy === "top") {
        const aScore = (a.likesCount ?? 0) + (a.commentsCount ?? 0);
        const bScore = (b.likesCount ?? 0) + (b.commentsCount ?? 0);
        if (bScore !== aScore) {
          return bScore - aScore;
        }
      }

      return b.feedCreatedAt - a.feedCreatedAt;
    });

    return sortedFeedItems
      .slice(offset, offset + limit)
      .map(({ feedCreatedAt, ...feedItem }) => feedItem);
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

    return await Promise.all(sortedPosts.map((post) => buildFeedPostPayload(ctx, post)));
  },
});

export const getCompanyPosts = query({
  args: {
    companyId: v.id("companies"),
  },
  handler: async (ctx, args) => {
    const posts = await ctx.db
      .query("posts")
      .withIndex("byCompanyId", (q) => q.eq("companyId", args.companyId))
      .collect();
    const sortedPosts = [...posts].sort((a, b) => b.createdAt - a.createdAt);

    return await Promise.all(sortedPosts.map((post) => buildFeedPostPayload(ctx, post)));
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
          author: await buildAuthorSummary(ctx, author),
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
    const authenticatedUserId = await getAuthUserId(ctx);
    if (authenticatedUserId && args.authorId !== authenticatedUserId) {
      throw new Error("Cannot create posts for another user");
    }

    const authorId = authenticatedUserId ?? args.authorId;
    const imageStorageIds = normalizeImageStorageIds(args.imageStorageIds);
    const hasStorageImages = imageStorageIds.length > 0;
    const postId = await ctx.db.insert("posts", {
      authorId,
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

    const mentionedUsernames = new Set<string>();
    const mentionMatches = args.description.matchAll(
      /(^|[^a-z0-9-])@([a-z0-9]+(?:-[a-z0-9]+)*)/gi,
    );

    for (const match of mentionMatches) {
      const mentionUsername = match[2]?.trim().toLowerCase();
      if (mentionUsername) {
        mentionedUsernames.add(mentionUsername);
      }
    }

    const uniqueMentionedUsernames = Array.from(mentionedUsernames);
    if (uniqueMentionedUsernames.length > 0) {
      const mentionedUsers = await Promise.all(
        uniqueMentionedUsernames.map((username) =>
          ctx.db
            .query("users")
            .withIndex("username", (q) => q.eq("username", username))
            .unique(),
        ),
      );

      const notificationsToCreate = mentionedUsers.filter(
        (mentionedUser): mentionedUser is Doc<"users"> =>
          mentionedUser !== null && mentionedUser._id !== authorId,
      );

      await Promise.all(
        notificationsToCreate.map((mentionedUser) =>
          ctx.db.insert("notifications", {
            userId: mentionedUser._id,
            type: "mention",
            fromUserId: authorId,
            postId,
            read: false,
            createdAt: Date.now(),
          }),
        ),
      );
    }

    return postId;
  },
});

export const createCompanyPost = mutation({
  args: {
    companyId: v.id("companies"),
    description: v.string(),
    visibility: v.optional(v.union(v.literal("public"), v.literal("connections"))),
    fileType: v.optional(v.string()),
    fileData: v.optional(v.string()),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const company = await ctx.db.get(args.companyId);
    if (!company) {
      throw new Error("Company not found");
    }

    const isCompanyAdmin = company.admins.some((adminId) => adminId === userId);
    if (!isCompanyAdmin) {
      throw new Error("Only company admins can create company posts");
    }

    const imageStorageIds = normalizeImageStorageIds(args.imageStorageIds);
    const hasStorageImages = imageStorageIds.length > 0;
    const postId = await ctx.db.insert("posts", {
      authorId: userId,
      companyId: args.companyId,
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

    const mentionedUsernames = new Set<string>();
    const mentionMatches = args.description.matchAll(
      /(^|[^a-z0-9-])@([a-z0-9]+(?:-[a-z0-9]+)*)/gi,
    );

    for (const match of mentionMatches) {
      const mentionUsername = match[2]?.trim().toLowerCase();
      if (mentionUsername) {
        mentionedUsernames.add(mentionUsername);
      }
    }

    const uniqueMentionedUsernames = Array.from(mentionedUsernames);
    if (uniqueMentionedUsernames.length > 0) {
      const mentionedUsers = await Promise.all(
        uniqueMentionedUsernames.map((username) =>
          ctx.db
            .query("users")
            .withIndex("username", (q) => q.eq("username", username))
            .unique(),
        ),
      );

      const notificationsToCreate = mentionedUsers.filter(
        (mentionedUser): mentionedUser is Doc<"users"> =>
          mentionedUser !== null && mentionedUser._id !== userId,
      );

      await Promise.all(
        notificationsToCreate.map((mentionedUser) =>
          ctx.db.insert("notifications", {
            userId: mentionedUser._id,
            type: "mention",
            fromUserId: userId,
            postId,
            read: false,
            createdAt: Date.now(),
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
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const post = await ctx.db.get(args.postId);
    if (!post) {
      throw new Error("Post not found");
    }

    if (post.authorId !== userId) {
      throw new Error("Cannot delete another user's post");
    }

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
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const existingPost = await ctx.db.get(args.postId);
    if (!existingPost) {
      throw new Error("Post not found");
    }

    if (existingPost.authorId !== userId) {
      throw new Error("Cannot edit another user's post");
    }

    if (existingPost.description === args.description) {
      return;
    }

    await ctx.db.insert("postEdits", {
      postId: args.postId,
      previousDescription: existingPost.description,
      editedAt: Date.now(),
    });

    await ctx.db.patch(args.postId, {
      description: args.description,
      isEdited: true,
    });
  },
});
