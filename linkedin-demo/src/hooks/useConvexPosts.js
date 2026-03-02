import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const useConvexPosts = (sortBy = "recent", options = {}) => {
  const posts = useQuery(api.posts.listPosts, { sortBy, ...options });
  return posts;
};

export default useConvexPosts;
