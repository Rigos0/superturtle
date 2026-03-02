import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const reportReasonValidator = v.union(
  v.literal("Spam"),
  v.literal("Harassment"),
  v.literal("Misinformation"),
  v.literal("Inappropriate content"),
  v.literal("Other"),
);

const normalizeOptionalDetails = (value?: string) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
};

const getExistingReport = async (
  ctx: MutationCtx | QueryCtx,
  userId: Id<"users">,
  postId: Id<"posts">,
) => {
  return await ctx.db
    .query("reports")
    .withIndex("byUserId", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("postId"), postId))
    .first();
};

export const reportPost = mutation({
  args: {
    postId: v.id("posts"),
    reason: reportReasonValidator,
    details: v.optional(v.string()),
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

    const existingReport = await getExistingReport(ctx, userId, args.postId);
    if (existingReport) {
      return {
        reported: false,
        alreadyReported: true,
      };
    }

    await ctx.db.insert("reports", {
      userId,
      postId: args.postId,
      reason: args.reason,
      details: normalizeOptionalDetails(args.details),
      createdAt: Date.now(),
    });

    return {
      reported: true,
      alreadyReported: false,
    };
  },
});

export const hasReported = query({
  args: {
    postId: v.id("posts"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return false;
    }

    const existingReport = await getExistingReport(ctx, userId, args.postId);
    return Boolean(existingReport);
  },
});
