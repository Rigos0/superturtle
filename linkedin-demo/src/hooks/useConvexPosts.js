import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const useConvexPosts = (sortBy = "recent") => {
  const posts = useQuery(api.posts.listPosts, { sortBy });
  return posts;
};

export default useConvexPosts;
