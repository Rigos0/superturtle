import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import FlipMove from "react-flip-move";
import Post from "./post/Post";
import Animation from "../animations/Animation";
import Loading from "../../assets/images/loading-dots.json";
import { DEFAULT_PHOTO } from "../../constants";
import useConvexPosts from "../../hooks/useConvexPosts";
import PostSkeleton from "../skeletons/PostSkeleton";

const Posts = ({ onNavigateProfile }) => {
  const classes = Style();
  const posts = useConvexPosts();
  const isLoading = posts === undefined;

  const getProfilePhoto = (photoURL) => {
    if (!photoURL || (typeof photoURL === "string" && photoURL.startsWith("/"))) {
      return DEFAULT_PHOTO;
    }
    return photoURL;
  };

  return (
    <div className={classes.posts}>
      {isLoading ? (
        <>
          <PostSkeleton />
          <PostSkeleton />
          <PostSkeleton />
        </>
      ) : posts.length === 0 ? (
        <Animation src={Loading} />
      ) : (
        <FlipMove style={{ width: "100%" }}>
          {posts.map((post) => (
            <Post
              key={post._id}
              postId={post._id}
              authorId={post.authorId}
              likesCount={post.likesCount}
              commentsCount={post.commentsCount}
              profile={getProfilePhoto(post.authorPhotoURL ?? post.author?.photoURL)}
              username={post.authorName ?? post.author?.displayName}
              timestamp={post.createdAt}
              description={post.description}
              fileType={post.fileType}
              fileData={post.fileData}
              onNavigateProfile={onNavigateProfile}
            />
          ))}
        </FlipMove>
      )}
    </div>
  );
};

const Style = makeStyles(() => ({
  posts: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
}));

export default Posts;
