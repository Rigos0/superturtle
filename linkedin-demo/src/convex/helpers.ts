import type { Doc, Id } from "./_generated/dataModel";

type UserPhotoContext = {
  storage: {
    getUrl: (storageId: Id<"_storage">) => Promise<string | null>;
  };
};

type UserLookupContext = UserPhotoContext & {
  db: {
    get: (id: Id<"users">) => Promise<Doc<"users"> | null>;
  };
};

export type AuthorSummary = {
  _id: Id<"users">;
  displayName: string;
  photoURL: string;
  title: string;
  username: string;
};

export const resolveUserPhotoURL = async (
  ctx: UserPhotoContext,
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

export const buildAuthorSummary = async (
  ctx: UserPhotoContext,
  author: Doc<"users"> | null,
): Promise<AuthorSummary | null> => {
  if (!author) {
    return null;
  }

  return {
    _id: author._id,
    displayName: author.displayName ?? author.name ?? "Guest User",
    photoURL: await resolveUserPhotoURL(ctx, author),
    title: author.title ?? "",
    username: author.username ?? "",
  };
};

export const buildAuthorSummaryById = async (
  ctx: UserLookupContext,
  authorId: Id<"users">,
) => {
  const author = await ctx.db.get(authorId);
  return buildAuthorSummary(ctx, author);
};
