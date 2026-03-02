import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const COMPANY_SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const normalizeCompanySlug = (value: string) => value.trim().toLowerCase();

const normalizeRequiredField = (value: string, fieldName: string) => {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    throw new Error(`${fieldName} is required`);
  }
  return trimmedValue;
};

const normalizeOptionalField = (value?: string) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim();
  return trimmedValue.length > 0 ? trimmedValue : undefined;
};

const normalizeOptionalLocations = (locations?: string[]) => {
  if (!Array.isArray(locations)) {
    return undefined;
  }

  const normalizedLocations = locations
    .map((location) => location.trim())
    .filter((location) => location.length > 0);

  return normalizedLocations.length > 0 ? normalizedLocations : [];
};

const getCompanyBySlugOrThrow = async (
  ctx: MutationCtx | QueryCtx,
  slug: string,
) => {
  const company = await ctx.db
    .query("companies")
    .withIndex("slug", (q) => q.eq("slug", slug))
    .unique();

  return company;
};

const assertCompanyAdmin = async (
  ctx: MutationCtx,
  companyId: Id<"companies">,
) => {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Not authenticated");
  }

  const company = await ctx.db.get(companyId);
  if (!company) {
    throw new Error("Company not found");
  }

  const isAdmin = company.admins.some((adminId) => adminId === userId);
  if (!isAdmin) {
    throw new Error("Only company admins can perform this action");
  }

  return { company, userId };
};

export const createCompany = mutation({
  args: {
    name: v.string(),
    slug: v.string(),
    description: v.string(),
    website: v.optional(v.string()),
    industry: v.string(),
    size: v.string(),
    founded: v.optional(v.string()),
    locations: v.optional(v.array(v.string())),
    logoStorageId: v.optional(v.id("_storage")),
    coverStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const normalizedSlug = normalizeCompanySlug(args.slug);
    if (!COMPANY_SLUG_REGEX.test(normalizedSlug)) {
      throw new Error("Slug must be lowercase letters, numbers, and hyphens only");
    }

    const existingCompany = await getCompanyBySlugOrThrow(ctx, normalizedSlug);
    if (existingCompany) {
      throw new Error("Company slug is already taken");
    }

    return await ctx.db.insert("companies", {
      name: normalizeRequiredField(args.name, "Company name"),
      slug: normalizedSlug,
      description: normalizeRequiredField(args.description, "Description"),
      website: normalizeOptionalField(args.website),
      industry: normalizeRequiredField(args.industry, "Industry"),
      size: normalizeRequiredField(args.size, "Company size"),
      founded: normalizeOptionalField(args.founded),
      locations: normalizeOptionalLocations(args.locations),
      logoStorageId: args.logoStorageId,
      coverStorageId: args.coverStorageId,
      createdBy: userId,
      admins: [userId],
      createdAt: Date.now(),
    });
  },
});

export const updateCompany = mutation({
  args: {
    companyId: v.id("companies"),
    name: v.optional(v.string()),
    slug: v.optional(v.string()),
    description: v.optional(v.string()),
    website: v.optional(v.string()),
    industry: v.optional(v.string()),
    size: v.optional(v.string()),
    founded: v.optional(v.string()),
    locations: v.optional(v.array(v.string())),
    logoStorageId: v.optional(v.id("_storage")),
    coverStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const { company } = await assertCompanyAdmin(ctx, args.companyId);

    const patch: {
      name?: string;
      slug?: string;
      description?: string;
      website?: string;
      industry?: string;
      size?: string;
      founded?: string;
      locations?: string[];
      logoStorageId?: typeof args.logoStorageId;
      coverStorageId?: typeof args.coverStorageId;
    } = {};

    if (typeof args.name === "string") {
      patch.name = normalizeRequiredField(args.name, "Company name");
    }

    if (typeof args.slug === "string") {
      const normalizedSlug = normalizeCompanySlug(args.slug);
      if (!COMPANY_SLUG_REGEX.test(normalizedSlug)) {
        throw new Error("Slug must be lowercase letters, numbers, and hyphens only");
      }

      const existingCompany = await getCompanyBySlugOrThrow(ctx, normalizedSlug);
      if (existingCompany && existingCompany._id !== company._id) {
        throw new Error("Company slug is already taken");
      }

      patch.slug = normalizedSlug;
    }

    if (typeof args.description === "string") {
      patch.description = normalizeRequiredField(args.description, "Description");
    }

    if (typeof args.website === "string") {
      patch.website = normalizeOptionalField(args.website);
    }

    if (typeof args.industry === "string") {
      patch.industry = normalizeRequiredField(args.industry, "Industry");
    }

    if (typeof args.size === "string") {
      patch.size = normalizeRequiredField(args.size, "Company size");
    }

    if (typeof args.founded === "string") {
      patch.founded = normalizeOptionalField(args.founded);
    }

    if (Array.isArray(args.locations)) {
      patch.locations = normalizeOptionalLocations(args.locations) ?? [];
    }

    if (args.logoStorageId !== undefined) {
      patch.logoStorageId = args.logoStorageId;
    }

    if (args.coverStorageId !== undefined) {
      patch.coverStorageId = args.coverStorageId;
    }

    await ctx.db.patch(args.companyId, patch);

    return await ctx.db.get(args.companyId);
  },
});

export const getCompanyBySlug = query({
  args: {
    slug: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedSlug = normalizeCompanySlug(args.slug);
    if (!COMPANY_SLUG_REGEX.test(normalizedSlug)) {
      return null;
    }

    return await getCompanyBySlugOrThrow(ctx, normalizedSlug);
  },
});

export const addAdmin = mutation({
  args: {
    companyId: v.id("companies"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const { company } = await assertCompanyAdmin(ctx, args.companyId);

    const user = await ctx.db.get(args.userId);
    if (!user) {
      throw new Error("User not found");
    }

    if (company.admins.some((adminId) => adminId === args.userId)) {
      return company;
    }

    const updatedAdmins = [...company.admins, args.userId];
    await ctx.db.patch(args.companyId, {
      admins: updatedAdmins,
    });

    return await ctx.db.get(args.companyId);
  },
});

export const listCompanyNames = query({
  args: {},
  handler: async (ctx) => {
    const companies = await ctx.db.query("companies").collect();

    return companies
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((company) => ({
        _id: company._id,
        name: company.name,
        slug: company.slug,
        logoStorageId: company.logoStorageId ?? null,
      }));
  },
});

export const searchCompanies = query({
  args: {
    query: v.string(),
  },
  handler: async (ctx, args) => {
    const normalizedQuery = args.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const [companies, companyFollowers] = await Promise.all([
      ctx.db.query("companies").collect(),
      ctx.db.query("companyFollowers").collect(),
    ]);

    const followerCountByCompanyId = new Map<string, number>();
    for (const follow of companyFollowers) {
      const companyId = follow.companyId;
      followerCountByCompanyId.set(companyId, (followerCountByCompanyId.get(companyId) ?? 0) + 1);
    }

    return companies
      .filter((company) => company.name.toLowerCase().includes(normalizedQuery))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((company) => ({
        name: company.name,
        slug: company.slug,
        industry: company.industry,
        followerCount: followerCountByCompanyId.get(company._id) ?? 0,
        logoStorageId: company.logoStorageId ?? null,
      }));
  },
});

export const getCompanySuggestions = query({
  args: {},
  handler: async (ctx) => {
    const viewerId = await getAuthUserId(ctx);
    const [companies, companyFollowers] = await Promise.all([
      ctx.db.query("companies").collect(),
      ctx.db.query("companyFollowers").collect(),
    ]);

    const followerCountByCompanyId = new Map<string, number>();
    const followedCompanyIds = new Set<string>();

    for (const follow of companyFollowers) {
      followerCountByCompanyId.set(
        follow.companyId,
        (followerCountByCompanyId.get(follow.companyId) ?? 0) + 1,
      );

      if (viewerId && follow.userId === viewerId) {
        followedCompanyIds.add(follow.companyId);
      }
    }

    const suggestions = companies
      .filter((company) => !followedCompanyIds.has(company._id))
      .sort((a, b) => {
        const followerDelta =
          (followerCountByCompanyId.get(b._id) ?? 0) - (followerCountByCompanyId.get(a._id) ?? 0);
        if (followerDelta !== 0) {
          return followerDelta;
        }

        return a.name.localeCompare(b.name);
      })
      .slice(0, 5);

    return await Promise.all(
      suggestions.map(async (company) => ({
        _id: company._id,
        name: company.name,
        slug: company.slug,
        industry: company.industry,
        followerCount: followerCountByCompanyId.get(company._id) ?? 0,
        logoURL: company.logoStorageId ? await ctx.storage.getUrl(company.logoStorageId) : null,
      })),
    );
  },
});

export const getCompanyAnalytics = query({
  args: {
    companyId: v.id("companies"),
  },
  handler: async (ctx, args) => {
    const viewerId = await getAuthUserId(ctx);
    if (!viewerId) {
      return null;
    }

    const company = await ctx.db.get(args.companyId);
    if (!company) {
      return null;
    }

    const isAdmin = company.admins.some((adminId) => adminId === viewerId);
    if (!isAdmin) {
      return null;
    }

    const [followers, posts] = await Promise.all([
      ctx.db
        .query("companyFollowers")
        .withIndex("byCompany", (q) => q.eq("companyId", args.companyId))
        .collect(),
      ctx.db.query("posts").collect(),
    ]);

    const companyAdminIds = new Set(company.admins);
    const companyPosts = posts.filter((post) => companyAdminIds.has(post.authorId));
    const totalPostLikes = companyPosts.reduce((sum, post) => sum + post.likesCount, 0);

    return {
      totalFollowers: followers.length,
      totalPosts: companyPosts.length,
      totalPostLikes,
    };
  },
});
