import { query } from "./_generated/server";

export const listPosts = query({
  args: {},
  handler: async (ctx) => {
    const posts = await ctx.db.query("posts").collect();
    const sortedPosts = [...posts].sort((a, b) => b.createdAt - a.createdAt);

    return await Promise.all(
      sortedPosts.map(async (post) => {
        const author = await ctx.db.get(post.authorId);

        return {
          ...post,
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
