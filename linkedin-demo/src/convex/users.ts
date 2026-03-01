import { v } from "convex/values";
import { query } from "./_generated/server";

export const getUser = query({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

export const getFeaturedUser = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.find((user) => user.isFeatured) ?? null;
  },
});
