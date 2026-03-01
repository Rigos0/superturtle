import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { DEFAULT_PHOTO } from "../constants";

const useConvexUser = () => {
  const { isAuthenticated } = useConvexAuth();
  const currentUser = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : "skip");
  const featuredUser = useQuery(api.users.getFeaturedUser);

  if (currentUser) {
    return {
      ...currentUser,
      displayName: currentUser.displayName ?? currentUser.name ?? "Guest User",
      photoURL: currentUser.photoURL ?? currentUser.image ?? DEFAULT_PHOTO,
    };
  }

  return featuredUser ?? null;
};

export default useConvexUser;
