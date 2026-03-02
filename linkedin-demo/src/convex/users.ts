import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";

const USERNAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slugifyUsername = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "user";
};

const normalizeUsername = (value: string) => value.trim().toLowerCase();

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

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }
    return await ctx.db.get(userId);
  },
});

export const getUserByUsername = query({
  args: {
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedUsername = normalizeUsername(args.username);
    if (!USERNAME_REGEX.test(normalizedUsername)) {
      return null;
    }

    return await ctx.db
      .query("users")
      .withIndex("username", (q) => q.eq("username", normalizedUsername))
      .unique();
  },
});

export const isUsernameAvailable = query({
  args: {
    username: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedUsername = normalizeUsername(args.username);
    if (!USERNAME_REGEX.test(normalizedUsername)) {
      return false;
    }

    const existingUser = await ctx.db
      .query("users")
      .withIndex("username", (q) => q.eq("username", normalizedUsername))
      .unique();

    return !existingUser;
  },
});

export const ensureUsername = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (user.username) {
      return user.username;
    }

    const baseUsername = slugifyUsername(user.displayName ?? user.name ?? "user");
    let candidateUsername = baseUsername;
    let suffix = 2;

    while (true) {
      const existingUser = await ctx.db
        .query("users")
        .withIndex("username", (q) => q.eq("username", candidateUsername))
        .unique();

      if (!existingUser || existingUser._id === userId) {
        await ctx.db.patch(userId, { username: candidateUsername });
        return candidateUsername;
      }

      candidateUsername = `${baseUsername}-${suffix}`;
      suffix += 1;
    }
  },
});

export const listAllUsers = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();

    return [...users]
      .sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? ""))
      .map((user) => ({
        _id: user._id,
        displayName: user.displayName ?? user.name ?? "Guest User",
        photoURL: user.photoURL ?? user.image ?? "",
        title: user.title ?? "",
        location: user.location ?? "",
        connections: user.connections ?? 0,
      }));
  },
});

export const searchUsers = query({
  args: {
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedQuery = args.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const users = await ctx.db.query("users").collect();

    return [...users]
      .filter((user) =>
        (user.displayName ?? user.name ?? "").toLowerCase().includes(normalizedQuery),
      )
      .sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? ""))
      .slice(0, 10)
      .map((user) => ({
        _id: user._id,
        displayName: user.displayName ?? user.name ?? "Guest User",
        photoURL: user.photoURL ?? user.image ?? "",
        title: user.title ?? "",
      }));
  },
});
