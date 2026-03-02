import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

export const toggleLike = mutation({
  args: {
    userId: v.id("users"),
    postId: v.id("posts"),
  },
  handler: async (ctx, args) => {
    const post = await ctx.db.get(args.postId);
    if (!post) {
      throw new Error("Post not found");
    }

    const existingLike = await ctx.db
      .query("likes")
      .filter((q) =>
        q.and(
          q.eq(q.field("userId"), args.userId),
          q.eq(q.field("postId"), args.postId),
        ),
      )
      .first();

    if (existingLike) {
      await ctx.db.delete(existingLike._id);
      await ctx.db.patch(args.postId, {
        likesCount: Math.max(0, post.likesCount - 1),
      });
      return { liked: false };
    }

    await ctx.db.insert("likes", {
      userId: args.userId,
      postId: args.postId,
    });
    await ctx.db.patch(args.postId, {
      likesCount: post.likesCount + 1,
    });
    await ctx.runMutation(internal.notifications.createNotification, {
      userId: post.authorId,
      type: "like",
      fromUserId: args.userId,
      postId: args.postId,
    });

    return { liked: true };
  },
});

export const getLikeStatus = query({
  args: {
    userId: v.id("users"),
    postId: v.id("posts"),
  },
  handler: async (ctx, args) => {
    const existingLike = await ctx.db
      .query("likes")
      .filter((q) =>
        q.and(
          q.eq(q.field("userId"), args.userId),
          q.eq(q.field("postId"), args.postId),
        ),
      )
      .first();

    return Boolean(existingLike);
  },
});

export const getLikeStatuses = query({
  args: {
    userId: v.id("users"),
    postIds: v.array(v.id("posts")),
  },
  handler: async (ctx, args) => {
    const allLikes = await ctx.db
      .query("likes")
      .filter((q) => q.eq(q.field("userId"), args.userId))
      .collect();

    const likedPostIds = new Set(allLikes.map((like) => like.postId));
    const result: Record<string, boolean> = {};
    for (const postId of args.postIds) {
      result[postId] = likedPostIds.has(postId);
    }
    return result;
  },
});
