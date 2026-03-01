import React from "react";
import { makeStyles } from "@material-ui/core/styles";
import FlipMove from "react-flip-move";
import Post from "./post/Post";
import Animation from "../animations/Animation";
import Loading from "../../assets/images/loading-dots.json";
import useConvexPosts from "../../hooks/useConvexPosts";

const DEFAULT_PROFILE_PHOTO = "https://i.pravatar.cc/200?img=68";

const Posts = ({ onNavigateProfile, onViewProfile }) => {
  const classes = Style();
  const posts = useConvexPosts();

  const getProfilePhoto = (photoURL) => {
    if (typeof photoURL === "string" && photoURL.startsWith("/")) {
      return DEFAULT_PROFILE_PHOTO;
    }
    return photoURL;
  };

  return (
    <div className={classes.posts}>
      {posts.length === 0 ? (
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
              timestamp={{ toDate: () => new Date(post.createdAt) }}
              description={post.description}
              fileType={post.fileType}
              fileData={post.fileData}
              onNavigateProfile={onNavigateProfile}
              onViewProfile={onViewProfile}
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
