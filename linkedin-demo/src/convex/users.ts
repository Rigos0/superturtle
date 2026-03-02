import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import type { Doc, Id } from "./_generated/dataModel";

const USERNAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const slugifyUsername = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "user";
};

const normalizeUsername = (value: string) => value.trim().toLowerCase();

const resolveUserPhotoURL = async (
  ctx: { storage: { getUrl: (storageId: Id<"_storage">) => Promise<string | null> } },
  user: Doc<"users">,
) => {
  if (user.photoStorageId) {
    const storagePhotoURL = await ctx.storage.getUrl(user.photoStorageId);
    if (storagePhotoURL) {
      return storagePhotoURL;
    }
  }

  return user.photoURL ?? user.image ?? "";
};

const resolveUserCoverURL = async (
  ctx: { storage: { getUrl: (storageId: Id<"_storage">) => Promise<string | null> } },
  user: Doc<"users">,
) => {
  if (!user.coverStorageId) {
    return "";
  }

  const storageCoverURL = await ctx.storage.getUrl(user.coverStorageId);
  return storageCoverURL ?? "";
};

const normalizeOptionalField = (value?: string) => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
};

const normalizeRequiredField = (value: string, fieldName: string) => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmedValue;
};

const normalizeExperienceInput = (args: {
  title: string;
  company: string;
  startDate: string;
  endDate?: string;
  description?: string;
}) => ({
  title: normalizeRequiredField(args.title, "Title"),
  company: normalizeRequiredField(args.company, "Company"),
  startDate: normalizeRequiredField(args.startDate, "Start date"),
  endDate: normalizeOptionalField(args.endDate),
  description: normalizeOptionalField(args.description),
});

const normalizeEducationInput = (args: {
  school: string;
  degree: string;
  field: string;
  startYear: string;
  endYear?: string;
}) => ({
  school: normalizeRequiredField(args.school, "School"),
  degree: normalizeRequiredField(args.degree, "Degree"),
  field: normalizeRequiredField(args.field, "Field of study"),
  startYear: normalizeRequiredField(args.startYear, "Start year"),
  endYear: normalizeOptionalField(args.endYear),
});

const normalizeSkill = (value: string) => {
  const normalizedValue = value.trim().replace(/\s+/g, " ");

  if (!normalizedValue) {
    throw new Error("Skill is required");
  }

  if (normalizedValue.length > 50) {
    throw new Error("Skill must be 50 characters or fewer");
  }

  return normalizedValue;
};

const buildSkillKey = (value: string) => value.trim().toLowerCase();

const resolveActivityLimit = (limit?: number) => {
  if (typeof limit !== "number" || Number.isNaN(limit)) {
    return 10;
  }

  const normalizedLimit = Math.floor(limit);
  return Math.min(Math.max(normalizedLimit, 1), 20);
};

export const getUser = query({
  args: { id: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.id);
    if (!user) {
      return null;
    }

    return {
      ...user,
      photoURL: await resolveUserPhotoURL(ctx, user),
      coverURL: await resolveUserCoverURL(ctx, user),
    };
  },
});

export const getFeaturedUser = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    const featuredUser = users.find((user) => user.isFeatured);

    if (!featuredUser) {
      return null;
    }

    return {
      ...featuredUser,
      photoURL: await resolveUserPhotoURL(ctx, featuredUser),
      coverURL: await resolveUserCoverURL(ctx, featuredUser),
    };
  },
});

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      return null;
    }

    return {
      ...user,
      photoURL: await resolveUserPhotoURL(ctx, user),
      coverURL: await resolveUserCoverURL(ctx, user),
    };
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

    const user = await ctx.db
      .query("users")
      .withIndex("username", (q) => q.eq("username", normalizedUsername))
      .unique();

    if (!user) {
      return null;
    }

    return {
      ...user,
      photoURL: await resolveUserPhotoURL(ctx, user),
      coverURL: await resolveUserCoverURL(ctx, user),
    };
  },
});

export const getRecentActivity = query({
  args: {
    userId: v.id("users"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return [];
    }

    const limit = resolveActivityLimit(args.limit);

    const [posts, comments] = await Promise.all([
      ctx.db
        .query("posts")
        .filter((q) => q.eq(q.field("authorId"), args.userId))
        .collect(),
      ctx.db
        .query("comments")
        .filter((q) => q.eq(q.field("authorId"), args.userId))
        .collect(),
    ]);

    const commentPostIds = Array.from(new Set(comments.map((comment) => comment.postId)));
    const postById = new Map<Id<"posts">, Doc<"posts"> | null>();
    await Promise.all(
      commentPostIds.map(async (postId) => {
        postById.set(postId, await ctx.db.get(postId));
      }),
    );

    const commentPostAuthorIds = Array.from(
      new Set(
        commentPostIds
          .map((postId) => postById.get(postId)?.authorId)
          .filter((authorId): authorId is Id<"users"> => Boolean(authorId)),
      ),
    );

    const userById = new Map<Id<"users">, Doc<"users"> | null>();
    await Promise.all(
      commentPostAuthorIds.map(async (authorId) => {
        userById.set(authorId, await ctx.db.get(authorId));
      }),
    );

    const postActivity = posts.map((post) => ({
      activityType: "post" as const,
      activityId: post._id,
      createdAt: post.createdAt,
      postId: post._id,
      content: post.description,
      postPreview: post.description,
      postAuthorName: user.displayName ?? user.name ?? "User",
    }));

    const commentActivity = comments.map((comment) => {
      const commentPost = postById.get(comment.postId) ?? null;
      const commentPostAuthor = commentPost ? userById.get(commentPost.authorId) ?? null : null;

      return {
        activityType: "comment" as const,
        activityId: comment._id,
        createdAt: comment.createdAt,
        postId: comment.postId,
        content: comment.body,
        postPreview: commentPost?.description ?? "",
        postAuthorName:
          commentPostAuthor?.displayName ?? commentPostAuthor?.name ?? "Unknown user",
      };
    });

    return [...postActivity, ...commentActivity]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
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

export const updateCurrentUserProfile = mutation({
  args: {
    displayName: v.optional(v.string()),
    title: v.optional(v.string()),
    headline: v.optional(v.string()),
    location: v.optional(v.string()),
    about: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const patch: {
      displayName?: string;
      title?: string;
      headline?: string;
      location?: string;
      about?: string;
    } = {};

    if (args.displayName !== undefined) {
      patch.displayName = args.displayName.trim();
    }
    if (args.title !== undefined) {
      patch.title = args.title.trim();
    }
    if (args.headline !== undefined) {
      patch.headline = args.headline.trim();
    }
    if (args.location !== undefined) {
      patch.location = args.location.trim();
    }
    if (args.about !== undefined) {
      patch.about = args.about.trim();
    }

    if (Object.keys(patch).length === 0) {
      return user;
    }

    await ctx.db.patch(userId, patch);
    return await ctx.db.get(userId);
  },
});

export const addSkill = mutation({
  args: {
    skill: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const nextSkill = normalizeSkill(args.skill);
    const currentSkills = user.skills ?? [];
    const nextSkillKey = buildSkillKey(nextSkill);

    if (currentSkills.some((skill) => buildSkillKey(skill) === nextSkillKey)) {
      return currentSkills;
    }

    if (currentSkills.length >= 50) {
      throw new Error("Maximum of 50 skills reached");
    }

    const nextSkills = [...currentSkills, nextSkill];
    await ctx.db.patch(userId, { skills: nextSkills });
    return nextSkills;
  },
});

export const removeSkill = mutation({
  args: {
    skill: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const targetSkillKey = buildSkillKey(normalizeSkill(args.skill));
    const currentSkills = user.skills ?? [];
    const nextSkills = currentSkills.filter((skill) => buildSkillKey(skill) !== targetSkillKey);

    if (nextSkills.length === currentSkills.length) {
      return currentSkills;
    }

    await ctx.db.patch(userId, { skills: nextSkills });
    return nextSkills;
  },
});

export const updateCurrentUserAbout = mutation({
  args: {
    about: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const about = args.about.trim();
    await ctx.db.patch(userId, { about });

    return { ...user, about };
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

export const saveProfilePhoto = mutation({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (user.photoStorageId && user.photoStorageId !== args.storageId) {
      await ctx.storage.delete(user.photoStorageId);
    }

    const resolvedPhotoURL = await ctx.storage.getUrl(args.storageId);
    const patch: { photoStorageId: Id<"_storage">; photoURL?: string } = {
      photoStorageId: args.storageId,
    };

    if (resolvedPhotoURL) {
      patch.photoURL = resolvedPhotoURL;
    }

    await ctx.db.patch(userId, patch);

    return {
      photoStorageId: args.storageId,
      photoURL: resolvedPhotoURL ?? user.photoURL ?? user.image ?? "",
    };
  },
});

export const generateCoverUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    return await ctx.storage.generateUploadUrl();
  },
});

export const saveCoverPhoto = mutation({
  args: {
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (user.coverStorageId && user.coverStorageId !== args.storageId) {
      await ctx.storage.delete(user.coverStorageId);
    }

    const resolvedCoverURL = await ctx.storage.getUrl(args.storageId);

    await ctx.db.patch(userId, {
      coverStorageId: args.storageId,
    });

    return {
      coverStorageId: args.storageId,
      coverURL: resolvedCoverURL ?? "",
    };
  },
});

export const listAllUsers = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();

    return await Promise.all(
      [...users]
        .sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? ""))
        .map(async (user) => ({
          _id: user._id,
          displayName: user.displayName ?? user.name ?? "Guest User",
          photoURL: await resolveUserPhotoURL(ctx, user),
          title: user.title ?? "",
          location: user.location ?? "",
          connections: user.connections ?? 0,
        })),
    );
  },
});

export const addExperience = mutation({
  args: {
    title: v.string(),
    company: v.string(),
    startDate: v.string(),
    endDate: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const normalizedInput = normalizeExperienceInput(args);
    const nextEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...normalizedInput,
    };

    await ctx.db.patch(userId, {
      experienceEntries: [...(user.experienceEntries ?? []), nextEntry],
    });

    return nextEntry;
  },
});

export const updateExperience = mutation({
  args: {
    entryId: v.string(),
    title: v.string(),
    company: v.string(),
    startDate: v.string(),
    endDate: v.optional(v.string()),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const entries = user.experienceEntries ?? [];
    const existingEntry = entries.find((entry) => entry.id === args.entryId);

    if (!existingEntry) {
      throw new Error("Experience entry not found");
    }

    const normalizedInput = normalizeExperienceInput(args);
    const nextEntries = entries.map((entry) =>
      entry.id === args.entryId
        ? {
            id: entry.id,
            ...normalizedInput,
          }
        : entry,
    );

    await ctx.db.patch(userId, { experienceEntries: nextEntries });
  },
});

export const removeExperience = mutation({
  args: {
    entryId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const currentEntries = user.experienceEntries ?? [];
    const nextEntries = currentEntries.filter((entry) => entry.id !== args.entryId);

    if (nextEntries.length === currentEntries.length) {
      throw new Error("Experience entry not found");
    }

    await ctx.db.patch(userId, { experienceEntries: nextEntries });
  },
});

export const addEducation = mutation({
  args: {
    school: v.string(),
    degree: v.string(),
    field: v.string(),
    startYear: v.string(),
    endYear: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const normalizedInput = normalizeEducationInput(args);
    const nextEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      ...normalizedInput,
    };

    await ctx.db.patch(userId, {
      educationEntries: [...(user.educationEntries ?? []), nextEntry],
    });

    return nextEntry;
  },
});

export const updateEducation = mutation({
  args: {
    entryId: v.string(),
    school: v.string(),
    degree: v.string(),
    field: v.string(),
    startYear: v.string(),
    endYear: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const entries = user.educationEntries ?? [];
    const existingEntry = entries.find((entry) => entry.id === args.entryId);

    if (!existingEntry) {
      throw new Error("Education entry not found");
    }

    const normalizedInput = normalizeEducationInput(args);
    const nextEntries = entries.map((entry) =>
      entry.id === args.entryId
        ? {
            id: entry.id,
            ...normalizedInput,
          }
        : entry,
    );

    await ctx.db.patch(userId, { educationEntries: nextEntries });
  },
});

export const removeEducation = mutation({
  args: {
    entryId: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db.get(userId);
    if (!user) {
      throw new Error("User not found");
    }

    const currentEntries = user.educationEntries ?? [];
    const nextEntries = currentEntries.filter((entry) => entry.id !== args.entryId);

    if (nextEntries.length === currentEntries.length) {
      throw new Error("Education entry not found");
    }

    await ctx.db.patch(userId, { educationEntries: nextEntries });
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

    return await Promise.all(
      [...users]
        .filter((user) =>
          (user.displayName ?? user.name ?? "").toLowerCase().includes(normalizedQuery),
        )
        .sort((a, b) => (a.displayName ?? a.name ?? "").localeCompare(b.displayName ?? b.name ?? ""))
        .slice(0, 10)
        .map(async (user) => ({
          _id: user._id,
          displayName: user.displayName ?? user.name ?? "Guest User",
          photoURL: await resolveUserPhotoURL(ctx, user),
          title: user.title ?? "",
        })),
    );
  },
});
