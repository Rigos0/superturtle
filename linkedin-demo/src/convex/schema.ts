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
    username: v.optional(v.string()),
    photoURL: v.optional(v.string()),
    photoStorageId: v.optional(v.id("_storage")),
    coverStorageId: v.optional(v.id("_storage")),
    title: v.optional(v.string()),
    headline: v.optional(v.string()),
    location: v.optional(v.string()),
    about: v.optional(v.string()),
    skills: v.optional(v.array(v.string())),
    experience: v.optional(v.array(v.string())),
    experienceEntries: v.optional(
      v.array(
        v.object({
          id: v.string(),
          title: v.string(),
          company: v.string(),
          startDate: v.string(),
          endDate: v.optional(v.string()),
          description: v.optional(v.string()),
        }),
      ),
    ),
    educationEntries: v.optional(
      v.array(
        v.object({
          id: v.string(),
          school: v.string(),
          degree: v.string(),
          field: v.string(),
          startYear: v.string(),
          endYear: v.optional(v.string()),
        }),
      ),
    ),
    featuredPostIds: v.optional(v.array(v.id("posts"))),
    connections: v.optional(v.number()),
    followers: v.optional(v.number()),
    isFeatured: v.optional(v.boolean()),
  })
    .index("email", ["email"])
    .index("username", ["username"]),
  companies: defineTable({
    name: v.string(),
    slug: v.string(),
    logoStorageId: v.optional(v.id("_storage")),
    coverStorageId: v.optional(v.id("_storage")),
    description: v.string(),
    website: v.optional(v.string()),
    industry: v.string(),
    size: v.string(),
    founded: v.optional(v.string()),
    locations: v.optional(v.array(v.string())),
    createdBy: v.id("users"),
    admins: v.array(v.id("users")),
    createdAt: v.number(),
  }).index("slug", ["slug"]),
  posts: defineTable({
    authorId: v.id("users"),
    description: v.string(),
    type: v.optional(v.union(v.literal("post"), v.literal("article"))),
    articleTitle: v.optional(v.string()),
    articleBody: v.optional(v.string()),
    visibility: v.optional(
      v.union(v.literal("public"), v.literal("connections")),
    ),
    fileType: v.optional(v.string()),
    fileData: v.optional(v.string()),
    imageStorageIds: v.optional(v.array(v.id("_storage"))),
    isEdited: v.optional(v.boolean()),
    createdAt: v.number(),
    likesCount: v.number(),
    commentsCount: v.number(),
  }),
  postEdits: defineTable({
    postId: v.id("posts"),
    previousDescription: v.string(),
    editedAt: v.number(),
  }).index("byPostId", ["postId"]),
  polls: defineTable({
    postId: v.id("posts"),
    question: v.string(),
    options: v.array(v.string()),
  }).index("byPostId", ["postId"]),
  pollVotes: defineTable({
    pollId: v.id("polls"),
    userId: v.id("users"),
    optionIndex: v.number(),
  })
    .index("byPollId", ["pollId"])
    .index("byPollAndUser", ["pollId", "userId"]),
  likes: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
  }),
  bookmarks: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
    createdAt: v.number(),
  }).index("byUserId", ["userId"]),
  hashtags: defineTable({
    tag: v.string(),
    postId: v.id("posts"),
  })
    .index("byTag", ["tag"])
    .index("byPostId", ["postId"])
    .index("byTagAndPost", ["tag", "postId"]),
  reposts: defineTable({
    userId: v.id("users"),
    originalPostId: v.id("posts"),
    commentary: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("byUserAndPost", ["userId", "originalPostId"])
    .index("byOriginalPost", ["originalPostId"])
    .index("byUser", ["userId"]),
  reactions: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
    reactionType: v.union(
      v.literal("like"),
      v.literal("love"),
      v.literal("celebrate"),
      v.literal("insightful"),
      v.literal("funny"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("byUserAndPost", ["userId", "postId"])
    .index("byPost", ["postId"]),
  comments: defineTable({
    postId: v.id("posts"),
    authorId: v.id("users"),
    body: v.string(),
    createdAt: v.number(),
  }),
  reports: defineTable({
    userId: v.id("users"),
    postId: v.id("posts"),
    reason: v.string(),
    details: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("byPostId", ["postId"])
    .index("byUserId", ["userId"]),
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
  connections: defineTable({
    userId1: v.id("users"),
    userId2: v.id("users"),
    status: v.string(),
    requestedBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("byUsers", ["userId1", "userId2"])
    .index("byUser1", ["userId1", "status"])
    .index("byUser2", ["userId2", "status"]),
  follows: defineTable({
    followerId: v.id("users"),
    followedId: v.id("users"),
    createdAt: v.number(),
  })
    .index("byFollower", ["followerId"])
    .index("byFollowed", ["followedId"])
    .index("byFollowerAndFollowed", ["followerId", "followedId"]),
  companyFollowers: defineTable({
    userId: v.id("users"),
    companyId: v.id("companies"),
    createdAt: v.number(),
  })
    .index("byCompany", ["companyId"])
    .index("byCompanyAndUser", ["companyId", "userId"]),
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
