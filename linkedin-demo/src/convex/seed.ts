import type { Id } from "./_generated/dataModel";
import { mutation } from "./_generated/server";

export const seedData = mutation({
  args: {},
  handler: async (ctx) => {
    const existingPosts = await ctx.db.query("posts").collect();
    if (existingPosts.length > 0) {
      return { seeded: false, usersInserted: 0, postsInserted: 0 };
    }

    const tadeasId: Id<"users"> = await ctx.db.insert("users", {
      displayName: "Tadeáš Bíbr",
      photoURL: "/tadeas-bibr.jpg",
      title: "📦 Co-Founder @ ReKrabice | Box Whisperer | Saving the planet one reusable package at a time",
      headline: "I put things in boxes so you don't have to throw them away.",
      location: "Prague, Czech Republic 🇨🇿",
      about:
        "Serial box enthusiast. Co-founded ReKrabice because I saw a cardboard box in a dumpster and thought 'there has to be a better way.' Previously convinced the CEO of Slevomat that I was essential (still unconfirmed). When I'm not evangelizing reusable packaging, I'm probably at a Startup Night telling founders their MVP needs more boxes.",
      experience: [
        "📦 Co-Founder — ReKrabice (Reusable boxes that come back like boomerangs)",
        "📈 Business Development — Behavio (Reading people's minds, ethically)",
        "⚙️ EA to CEO — Slevomat (Professional calendar Tetris champion)",
      ],
      connections: 842,
      followers: 1337,
      isFeatured: true,
    });

    const averyId: Id<"users"> = await ctx.db.insert("users", {
      displayName: "Avery Chen",
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
        authorId: tadeasId,
        minutesAgo: 8,
        description:
          "Thrilled to announce that ReKrabice just hit 10,000 boxes returned. That's 10,000 cardboard boxes that didn't end up crying alone in a recycling bin. We're literally saving relationships between humans and packaging. 📦♻️\n\n#sustainability #circulareconomy #boxes #humblebragging",
      },
      {
        authorId: averyId,
        minutesAgo: 17,
        description:
          "Hot take: your design system is not a product. It's a coping mechanism for the fact that your 47 designers can't agree on border-radius. Anyway here's a new icon set I made instead of going to therapy 🎨",
        fileType: "image",
        fileData: "https://picsum.photos/id/1015/1200/700",
      },
      {
        authorId: devinId,
        minutesAgo: 35,
        description:
          "Day 847 of centering a div. It's centered now. I think. The tests say yes. My eyes say maybe. The designer says 'can you move it 1px to the left?' I am at peace with the void between pixels. 🧘‍♂️",
      },
      {
        authorId: sofiaId,
        minutesAgo: 62,
        description:
          "Just finished 12 customer interviews. Key insight: users don't read onboarding flows. Secondary insight: users don't read anything. Third insight: I'm basically writing fan fiction for a product no one reads. Updating the deck anyway. 📊",
      },
      {
        authorId: tadeasId,
        minutesAgo: 95,
        description:
          "People ask me: 'Tadeáš, why reusable boxes? Why not something cool like AI or crypto?'\n\nBecause when the robots take over and the blockchain collapses, you'll still need something to put your stuff in. And I'll be there. With a box. A very nice, reusable one. 📦\n\n#ReKrabice #ThinkInsideTheBox",
        fileType: "image",
        fileData: "https://picsum.photos/id/1025/1200/700",
      },
      {
        authorId: averyId,
        minutesAgo: 130,
        description:
          "Agree? 👇\n\nThe best design is invisible. The second best design is whatever ships before the CEO changes their mind on Friday at 4:47 PM.\n\nRepost if you've ever redesigned a feature that launched 3 hours later.",
      },
      {
        authorId: devinId,
        minutesAgo: 188,
        description:
          "Removed 2,000 lines of CSS today. The app looks exactly the same. I've either achieved mass enlightenment or broken something that won't surface until the demo with investors. Either way, deploying to prod. YOLO. 🚀",
      },
      {
        authorId: sofiaId,
        minutesAgo: 255,
        description:
          "Made a 73-slide deck for a feature that got killed in standup this morning. Converting it into a 'learnings document' so the pain has a purpose. If anyone needs a beautifully designed post-mortem for something that never lived, DM me. 💀📑",
        fileType: "image",
        fileData: "https://picsum.photos/id/1043/1200/700",
      },
      {
        authorId: tadeasId,
        minutesAgo: 320,
        description:
          "I used to be EA to the CEO of Slevomat. My greatest achievement was protecting a 45-minute lunch block on his calendar for 6 consecutive months. Generals wish they had my strategic planning skills.\n\nNow I co-founded a box company. Some would call that a lateral move. I call it an upgrade. Boxes > calendars. Always. 📦 > 📅",
      },
    ];

    for (const post of posts) {
      await ctx.db.insert("posts", {
        authorId: post.authorId,
        description: post.description,
        createdAt: createdAtFromMinutesAgo(post.minutesAgo),
        likesCount: 1,
        commentsCount: 1,
        ...(post.fileType ? { fileType: post.fileType } : {}),
        ...(post.fileData ? { fileData: post.fileData } : {}),
      });
    }

    return { seeded: true, usersInserted: 4, postsInserted: posts.length };
  },
});
