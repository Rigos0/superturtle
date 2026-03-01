import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    displayName: v.string(),
    photoURL: v.string(),
    title: v.string(),
    headline: v.string(),
    location: v.string(),
    about: v.string(),
    experience: v.array(v.string()),
    connections: v.number(),
    followers: v.number(),
    isFeatured: v.boolean(),
  }),
  posts: defineTable({
    authorId: v.id("users"),
    description: v.string(),
    fileType: v.optional(v.string()),
    fileData: v.optional(v.string()),
    createdAt: v.number(),
    likesCount: v.number(),
    commentsCount: v.number(),
  }),
  likes: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
  }),
  comments: defineTable({
    postId: v.id("posts"),
    authorId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
  }),
});
