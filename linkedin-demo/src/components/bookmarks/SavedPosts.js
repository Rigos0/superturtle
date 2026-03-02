import { useMemo } from "react";
import { useQuery } from "convex/react";
import { makeStyles } from "@material-ui/core/styles";
import Typography from "@material-ui/core/Typography";
import LoadingGate from "../LoadingGate";
import Post from "../posts/post/Post";
import { DEFAULT_PHOTO } from "../../constants";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";

const resolvePhoto = (photoURL) => {
  if (!photoURL || (typeof photoURL === "string" && photoURL.startsWith("/"))) {
    return DEFAULT_PHOTO;
  }

  return photoURL;
};

const SavedPosts = ({ onNavigateProfile }) => {
  const classes = useStyles();
  const user = useConvexUser();
  const bookmarkedPosts = useQuery(api.bookmarks.getUserBookmarks, {});
  const isLoading = bookmarkedPosts === undefined;
  const postIds = useMemo(() => (bookmarkedPosts ?? []).map((post) => post._id), [bookmarkedPosts]);
  const userReactions = useQuery(
    api.likes.getUserReactionsByPostIds,
    user?._id && postIds.length > 0 ? { userId: user._id, postIds } : "skip",
  );
  const reactionCounts = useQuery(
    api.likes.getReactionCountsByPostIds,
    postIds.length > 0 ? { postIds } : "skip",
  );

  return (
    <div className={classes.root}>
      <Typography variant="h6" className={classes.title}>
        Saved posts
      </Typography>
      <LoadingGate isLoading={isLoading}>
        {bookmarkedPosts?.length === 0 ? (
          <Typography variant="body2" color="textSecondary">
            You have not saved any posts yet.
          </Typography>
        ) : (
          bookmarkedPosts?.map((post) => (
            <Post
              key={post._id}
              postId={post._id}
              authorId={post.authorId}
              authorUsername={post.author?.username ?? null}
              likesCount={post.likesCount}
              commentsCount={post.commentsCount}
              repostCount={post.repostCount}
              currentReaction={userReactions?.[post._id] ?? undefined}
              reactionCounts={reactionCounts?.[post._id]}
              profile={resolvePhoto(post.author?.photoURL)}
              username={post.author?.displayName ?? "Unknown user"}
              timestamp={post.createdAt}
              description={post.description}
              fileType={post.fileType}
              fileData={post.fileData}
              imageUrls={post.imageUrls}
              onNavigateProfile={onNavigateProfile}
            />
          ))
        )}
      </LoadingGate>
    </div>
  );
};

const useStyles = makeStyles(() => ({
  root: {
    width: "100%",
  },
  title: {
    fontWeight: 700,
    color: "#2e7d32",
    marginBottom: 12,
  },
}));

export default SavedPosts;
