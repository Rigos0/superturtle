import type { Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";

export const seedData = mutation({
  args: {},
  handler: async (ctx) => {
    const existingPosts = await ctx.db.query("posts").collect();
    if (existingPosts.length > 0) {
      return { seeded: false, usersInserted: 0, postsInserted: 0 };
    }

    const alexId: Id<"users"> = await ctx.db.insert("users", {
      displayName: "Alex Turner",
      username: "alex-turner",
      photoURL: "https://i.pravatar.cc/200?img=68",
      title: "🐢 Full-Stack Developer | Building things that matter",
      headline: "Turning ideas into products",
      location: "San Francisco, CA",
      about:
        "Passionate developer with a love for clean code and great UX. Previously built products at startups and scale-ups.",
      experience: [
        "🚀 Senior Developer — TechStartup (Building the future)",
        "💡 Product Engineer — ScaleUp Inc (Shipping fast)",
        "🎓 CS Graduate — State University",
      ],
      connections: 500,
      followers: 750,
      isFeatured: true,
    });

    const averyId: Id<"users"> = await ctx.db.insert("users", {
      displayName: "Avery Chen",
      username: "avery-chen",
      photoURL: "https://i.pravatar.cc/200?img=12",
      title: "Design Systems Lead @ Figma's Fever Dream",
      headline: "",
      location: "",
      about: "",
      experience: [],
      connections: 0,
      followers: 0,
      isFeatured: false,
    });

    const devinId: Id<"users"> = await ctx.db.insert("users", {
      displayName: "Devin Carter",
      username: "devin-carter",
      photoURL: "https://i.pravatar.cc/200?img=33",
      title: "Frontend Engineer | div Alignment Specialist",
      headline: "",
      location: "",
      about: "",
      experience: [],
      connections: 0,
      followers: 0,
      isFeatured: false,
    });

    const sofiaId: Id<"users"> = await ctx.db.insert("users", {
      displayName: "Sofia Morales",
      username: "sofia-morales",
      photoURL: "https://i.pravatar.cc/200?img=44",
      title: "Product Marketing | Making Decks Nobody Reads",
      headline: "",
      location: "",
      about: "",
      experience: [],
      connections: 0,
      followers: 0,
      isFeatured: false,
    });

    const now = Date.now();
    const createdAtFromMinutesAgo = (minutesAgo: number) => now - minutesAgo * 60000;

    const posts = [
      {
        authorId: alexId,
        minutesAgo: 8,
        description:
          "Excited to share that our team shipped a major onboarding improvement this week. We focused on reducing friction in the first five minutes of product use, and early signals are promising.\n\nGreat outcomes come from close collaboration across product, design, and engineering.",
      },
      {
        authorId: averyId,
        minutesAgo: 17,
        description:
          "We completed a refresh of our design system primitives and documentation. The biggest win was aligning on consistent spacing and typography tokens, which sped up handoff and reduced UI drift.\n\nSmall standards create big leverage over time.",
        fileType: "image",
        fileData: "https://picsum.photos/id/1015/1200/700",
      },
      {
        authorId: devinId,
        minutesAgo: 35,
        description:
          "Spent today improving frontend performance by auditing render paths and trimming unnecessary re-renders. We were able to cut page interaction latency significantly on lower-end devices.\n\nPerformance work is invisible when done well, but users feel it immediately.",
      },
      {
        authorId: sofiaId,
        minutesAgo: 62,
        description:
          "Wrapped a round of customer interviews this week. A recurring theme was clarity: users value simple workflows and clear next steps over feature depth.\n\nTurning this into a focused messaging update for the next release.",
      },
      {
        authorId: alexId,
        minutesAgo: 95,
        description:
          "Quick reflection: strong engineering culture is built through consistent code reviews, clear ownership, and steady delivery habits.\n\nTools matter, but team trust and communication matter more. Proud of the momentum we are building.",
        fileType: "image",
        fileData: "https://picsum.photos/id/1025/1200/700",
      },
      {
        authorId: averyId,
        minutesAgo: 130,
        description:
          "One principle I keep coming back to: good design reduces decision fatigue. When patterns are predictable and language is clear, teams ship faster and users feel more confident.\n\nDesign quality scales when systems are treated as shared product infrastructure.",
      },
      {
        authorId: devinId,
        minutesAgo: 188,
        description:
          "We wrapped a cleanup sprint focused on maintainability. Reduced dead code, simplified styling patterns, and improved component boundaries.\n\nThe product looks the same, but the codebase is healthier and easier to extend.",
      },
      {
        authorId: sofiaId,
        minutesAgo: 255,
        description:
          "Finalized our quarterly go-to-market narrative and aligned it with current product capabilities. The strongest message came from real customer outcomes, not feature lists.\n\nClear positioning helps every team move in the same direction.",
        fileType: "image",
        fileData: "https://picsum.photos/id/1043/1200/700",
      },
      {
        authorId: alexId,
        minutesAgo: 320,
        description:
          "Career growth reminder: impactful work is rarely linear. The most valuable projects in my journey were the ones that required cross-functional collaboration and continuous learning.\n\nKeep building, keep iterating, and share what you learn with others.",
      },
    ];

    for (const post of posts) {
      await ctx.db.insert("posts", {
        authorId: post.authorId,
        description: post.description,
        visibility: "public",
        createdAt: createdAtFromMinutesAgo(post.minutesAgo),
        likesCount: 0,
        commentsCount: 0,
        ...(post.fileType ? { fileType: post.fileType } : {}),
        ...(post.fileData ? { fileData: post.fileData } : {}),
      });
    }

    return { seeded: true, usersInserted: 4, postsInserted: posts.length };
  },
});
