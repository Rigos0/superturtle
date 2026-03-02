import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Typography } from "@material-ui/core";
import LoadingGate from "../LoadingGate";
import Post from "../posts/post/Post";
import { DEFAULT_PHOTO } from "../../constants";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";

const normalizeHashtag = (value) =>
  value
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();

const resolvePhoto = (photoURL) => {
  if (!photoURL || (typeof photoURL === "string" && photoURL.startsWith("/"))) {
    return DEFAULT_PHOTO;
  }

  return photoURL;
};

const HashtagFeed = ({ tag, onNavigateProfile }) => {
  const normalizedTag = useMemo(() => normalizeHashtag(tag ?? ""), [tag]);
  const posts = useQuery(
    api.hashtags.getPostsByHashtag,
    normalizedTag ? { tag: normalizedTag } : "skip"
  );
  const user = useConvexUser();
  const isLoading = posts === undefined;
  const postIds = useMemo(() => (posts ?? []).map((post) => post._id), [posts]);
  const userReactions = useQuery(
    api.likes.getUserReactionsByPostIds,
    user?._id && postIds.length > 0 ? { userId: user._id, postIds } : "skip"
  );
  const reactionCounts = useQuery(
    api.likes.getReactionCountsByPostIds,
    postIds.length > 0 ? { postIds } : "skip"
  );

  if (!normalizedTag) {
    return (
      <Typography variant="body2" color="textSecondary">
        Invalid hashtag.
      </Typography>
    );
  }

  return (
    <div style={{ width: "100%" }}>
      <Typography
        variant="h6"
        style={{ fontWeight: 700, padding: "4px 0 12px", color: "#2e7d32" }}
      >
        #{normalizedTag}
      </Typography>
      <LoadingGate isLoading={isLoading}>
        {posts?.length === 0 ? (
          <Typography variant="body2" color="textSecondary">
            No posts found for #{normalizedTag}.
          </Typography>
        ) : (
          posts?.map((post) => (
            <Post
              key={post._id}
              postId={post._id}
              authorId={post.authorId}
              authorUsername={post.author?.username ?? null}
              likesCount={post.likesCount}
              commentsCount={post.commentsCount}
              currentReaction={userReactions?.[post._id] ?? undefined}
              reactionCounts={reactionCounts?.[post._id]}
              profile={resolvePhoto(post.authorPhotoURL ?? post.author?.photoURL)}
              username={post.authorName ?? post.author?.displayName}
              timestamp={post.createdAt}
              isEdited={Boolean(post.isEdited)}
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

export default HashtagFeed;
