import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const listPosts = query({
  args: {},
  handler: async (ctx) => {
    const posts = await ctx.db.query("posts").collect();
    const sortedPosts = [...posts].sort((a, b) => b.createdAt - a.createdAt);

    return await Promise.all(
      sortedPosts.map(async (post) => {
        const author = await ctx.db.get(post.authorId);
        const likes = await ctx.db
          .query("likes")
          .filter((q) => q.eq(q.field("postId"), post._id))
          .collect();

        return {
          ...post,
          likesCount: likes.length,
          author: author
            ? {
                displayName: author.displayName,
                photoURL: author.photoURL,
                title: author.title,
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
    fileType: v.optional(v.string()),
    fileData: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("posts", {
      authorId: args.authorId,
      description: args.description,
      createdAt: Date.now(),
      likesCount: 0,
      commentsCount: 0,
      ...(args.fileType ? { fileType: args.fileType } : {}),
      ...(args.fileData ? { fileData: args.fileData } : {}),
    });
  },
});

export const deletePost = mutation({
  args: {
    postId: v.id("posts"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.postId);
  },
});
