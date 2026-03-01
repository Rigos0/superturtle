import { useQuery } from "convex/react";
import { api } from "../convex/_generated/api";

const useConvexUser = () => {
  const featuredUser = useQuery(api.users.getFeaturedUser);
  return featuredUser ?? null;
};

export default useConvexUser;
