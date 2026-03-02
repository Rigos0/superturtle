import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const followCompany = mutation({
  args: {
    companyId: v.id("companies"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Authentication required");
    }

    const [company, existingFollow] = await Promise.all([
      ctx.db.get(args.companyId),
      ctx.db
        .query("companyFollowers")
        .withIndex("byCompanyAndUser", (q) =>
          q.eq("companyId", args.companyId).eq("userId", userId),
        )
        .first(),
    ]);

    if (!company) {
      throw new Error("Company not found");
    }

    if (existingFollow) {
      return existingFollow._id;
    }

    return await ctx.db.insert("companyFollowers", {
      userId,
      companyId: args.companyId,
      createdAt: Date.now(),
    });
  },
});

export const unfollowCompany = mutation({
  args: {
    companyId: v.id("companies"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Authentication required");
    }

    const existingFollow = await ctx.db
      .query("companyFollowers")
      .withIndex("byCompanyAndUser", (q) =>
        q.eq("companyId", args.companyId).eq("userId", userId),
      )
      .first();

    if (!existingFollow) {
      return { unfollowed: false };
    }

    await ctx.db.delete(existingFollow._id);
    return { unfollowed: true };
  },
});

export const getFollowerCount = query({
  args: {
    companyId: v.id("companies"),
  },
  handler: async (ctx, args) => {
    const followers = await ctx.db
      .query("companyFollowers")
      .withIndex("byCompany", (q) => q.eq("companyId", args.companyId))
      .collect();

    return followers.length;
  },
});

export const isFollowing = query({
  args: {
    companyId: v.id("companies"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return false;
    }

    const follow = await ctx.db
      .query("companyFollowers")
      .withIndex("byCompanyAndUser", (q) =>
        q.eq("companyId", args.companyId).eq("userId", userId),
      )
      .first();

    return Boolean(follow);
  },
});
