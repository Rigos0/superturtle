import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  ...authTables,
  users: defineTable({
    // Auth fields (set by Convex Auth on sign-in)
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    // App-specific fields (optional so auth can create minimal user records)
    displayName: v.optional(v.string()),
    photoURL: v.optional(v.string()),
    title: v.optional(v.string()),
    headline: v.optional(v.string()),
    location: v.optional(v.string()),
    about: v.optional(v.string()),
    experience: v.optional(v.array(v.string())),
    connections: v.optional(v.number()),
    followers: v.optional(v.number()),
    isFeatured: v.optional(v.boolean()),
  }).index("email", ["email"]),
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
  conversations: defineTable({
    participants: v.array(v.id("users")),
    createdAt: v.number(),
  }),
  messages: defineTable({
    conversationId: v.id("conversations"),
    senderId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
  }),
  notifications: defineTable({
    userId: v.id("users"),
    type: v.string(),
    fromUserId: v.id("users"),
    postId: v.optional(v.id("posts")),
    conversationId: v.optional(v.id("conversations")),
    read: v.boolean(),
    createdAt: v.number(),
  }),
});
