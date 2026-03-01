import React, { forwardRef } from "react";
import { useMutation, useQuery } from "convex/react";
import Avatar from "@material-ui/core/Avatar";
import Menu from "@material-ui/core/Menu";
import MenuItem from "@material-ui/core/MenuItem";
import Paper from "@material-ui/core/Paper";
import MoreHorizOutlinedIcon from "@material-ui/icons/MoreHorizOutlined";
import ThumbUpAltIcon from "@material-ui/icons/ThumbUpAlt";
import ThumbUpAltOutlinedIcon from "@material-ui/icons/ThumbUpAltOutlined";
import ReplyOutlinedIcon from "@material-ui/icons/ReplyOutlined";
import FiberManualRecordRoundedIcon from "@material-ui/icons/FiberManualRecordRounded";
import SendIcon from "@material-ui/icons/Send";
import CommentOutlinedIcon from "@material-ui/icons/CommentOutlined";
import ReactPlayer from "react-player";
import ReactTimeago from "react-timeago";
import * as images from "../../../assets/images/images";
import { api } from "../../../convex/_generated/api";
import useConvexUser from "../../../hooks/useConvexUser";
import Style from "./Style";

const Post = forwardRef(
  (
    {
      postId,
      authorId,
      likesCount = 0,
      commentsCount = 0,
      profile,
      username,
      timestamp,
      description,
      fileType,
      fileData,
      onNavigateProfile,
    },
    ref
  ) => {
    const classes = Style();
    const user = useConvexUser();
    const toggleLike = useMutation(api.likes.toggleLike);
    const addComment = useMutation(api.comments.addComment);
    const deletePost = useMutation(api.posts.deletePost);
    const updatePost = useMutation(api.posts.updatePost);

    const [showComments, setShowComments] = React.useState(false);
    const [commentText, setCommentText] = React.useState("");
    const [menuAnchorEl, setMenuAnchorEl] = React.useState(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const [editText, setEditText] = React.useState(description ?? "");

    const liked = useQuery(
      api.likes.getLikeStatus,
      user?._id ? { userId: user._id, postId } : "skip"
    );
    const comments = useQuery(
      api.comments.listComments,
      showComments ? { postId } : "skip"
    );

    const isLiked = liked ?? false;
    const commentsList = comments ?? [];
    const isOwnPost = Boolean(authorId && user?._id && authorId === user._id);
    const isMenuOpen = Boolean(menuAnchorEl);
    const canNavigateProfile = typeof onNavigateProfile === "function";

    React.useEffect(() => {
      if (!isEditing) {
        setEditText(description ?? "");
      }
    }, [description, isEditing]);

    const capitalize = (_string = "") => {
      return _string.charAt(0).toUpperCase() + _string.slice(1);
    };

    const postImageRef = React.useRef(null);

    const PostImage = React.forwardRef((props, ref) => {
      return <img src={props.src} alt="post" ref={ref} />;
    });

    const handleLikeClick = async () => {
      if (!user?._id) {
        return;
      }

      try {
        await toggleLike({ userId: user._id, postId });
      } catch (error) {
        console.error("Failed to toggle like:", error);
      }
    };

    const handleCommentSubmit = async (event) => {
      event.preventDefault();
      if (!user?._id) {
        return;
      }

      const body = commentText.trim();
      if (!body) {
        return;
      }

      try {
        await addComment({ postId, authorId: user._id, body });
        setCommentText("");
      } catch (error) {
        console.error("Failed to add comment:", error);
      }
    };

    const handleMenuOpen = (event) => {
      if (!isOwnPost) {
        return;
      }
      setMenuAnchorEl(event.currentTarget);
    };

    const handleMenuClose = () => {
      setMenuAnchorEl(null);
    };

    const handleDeleteClick = async () => {
      if (!isOwnPost) {
        return;
      }

      handleMenuClose();
      try {
        await deletePost({ postId });
      } catch (error) {
        console.error("Failed to delete post:", error);
      }
    };

    const handleEditClick = () => {
      if (!isOwnPost) {
        return;
      }

      setEditText(description ?? "");
      setIsEditing(true);
      handleMenuClose();
    };

    const handleEditSave = async () => {
      if (!isOwnPost) {
        return;
      }

      const nextDescription = editText.trim();
      if (!nextDescription) {
        return;
      }

      try {
        await updatePost({ postId, description: nextDescription });
        setIsEditing(false);
      } catch (error) {
        console.error("Failed to update post:", error);
      }
    };

    const handleEditCancel = () => {
      setEditText(description ?? "");
      setIsEditing(false);
    };

    const handleProfileClick = () => {
      if (typeof onNavigateProfile === "function") {
        onNavigateProfile(authorId);
      }
    };

    const Reactions = () => {
      return (
        <div className={classes.footer__stats}>
          <div>
            <img src={images.LinkedInLike} alt="linked-in-reaction-1" />
            <img src={images.LinkedInLove} alt="linked-in-reaction-2" />
            <img src={images.LinkedInApplaud} alt="linked-in-reaction-3" />
          </div>
          <h4>{likesCount}</h4>
          <FiberManualRecordRoundedIcon
            style={{ fontSize: 8, color: "grey", paddingLeft: "3px" }}
          />
          <h4>{commentsCount} comments</h4>
        </div>
      );
    };

    return (
      <Paper ref={ref} className={classes.post} id={`post-${postId}`}>
        <div className={classes.post__header}>
          <Avatar
            src={profile}
            onClick={canNavigateProfile ? handleProfileClick : undefined}
            style={canNavigateProfile ? { cursor: "pointer" } : undefined}
          />
          <div className={classes.header__info}>
            <h4
              onClick={canNavigateProfile ? handleProfileClick : undefined}
              style={canNavigateProfile ? { cursor: "pointer" } : { cursor: "default" }}
            >
              {capitalize(username)}
            </h4>
            <p>
              <ReactTimeago date={new Date(timestamp?.toDate()).toUTCString()} units="minute" />
            </p>
          </div>
          <MoreHorizOutlinedIcon
            onClick={handleMenuOpen}
            style={!isOwnPost ? { opacity: 0.55, cursor: "default" } : undefined}
          />
          <Menu
            anchorEl={menuAnchorEl}
            keepMounted
            open={isMenuOpen}
            onClose={handleMenuClose}
          >
            {isOwnPost && <MenuItem onClick={handleEditClick}>Edit</MenuItem>}
            {isOwnPost && <MenuItem onClick={handleDeleteClick}>Delete</MenuItem>}
          </Menu>
        </div>
        <div className={classes.post__body}>
          <div className={classes.body__description}>
            {isEditing ? (
              <div style={{ width: "100%" }}>
                <textarea
                  className={classes.editTextarea}
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  rows={3}
                  aria-label="Edit post description"
                />
                <div className={classes.editActions}>
                  <button
                    type="button"
                    className={classes.saveButton}
                    onClick={handleEditSave}
                    disabled={!editText.trim()}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className={classes.cancelButton}
                    onClick={handleEditCancel}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p>{description}</p>
            )}
          </div>
          {fileData && (
            <div className={classes.body__image}>
              {fileType === "image" ? (
                // <img src={fileData} alt="post" />
                <PostImage ref={postImageRef} src={fileData} />
              ) : (
                <ReactPlayer url={fileData} controls={true} style={{ height: "auto !important" }} />
              )}
            </div>
          )}
        </div>
        <div className={classes.post__footer}>
          <Reactions />
          <div className={classes.footer__actions}>
            <div className={classes.action__icons} onClick={handleLikeClick}>
              {isLiked ? (
                <ThumbUpAltIcon style={{ transform: "scaleX(-1)", color: "#2e7d32" }} />
              ) : (
                <ThumbUpAltOutlinedIcon style={{ transform: "scaleX(-1)" }} />
              )}
              <h4 style={isLiked ? { color: "#2e7d32" } : undefined}>Like</h4>
            </div>
            <div className={classes.action__icons} onClick={() => setShowComments((prev) => !prev)}>
              <CommentOutlinedIcon style={showComments ? { color: "#2e7d32" } : undefined} />
              <h4 style={showComments ? { color: "#2e7d32" } : undefined}>Comment</h4>
            </div>
            <div className={classes.action__icons}>
              <ReplyOutlinedIcon style={{ transform: "scaleX(-1)" }} />
              <h4>Share</h4>
            </div>
            <div className={classes.action__icons}>
              <SendIcon style={{ transform: "rotate(-45deg)" }} />
              <h4>Send</h4>
            </div>
          </div>

          {showComments && (
            <div className={classes.comments__section}>
              <div className={classes.comments__list}>
                {commentsList.map((comment) => (
                  <div key={comment._id} className={classes.comment__item}>
                    <Avatar
                      className={classes.comment__avatar}
                      src={comment.author?.photoURL}
                      alt={comment.author?.displayName ?? "Comment author"}
                    />
                    <div className={classes.comment__content}>
                      <div className={classes.comment__meta}>
                        <h5>{comment.author?.displayName ?? "Unknown user"}</h5>
                        <span>
                          <ReactTimeago date={new Date(comment.createdAt).toUTCString()} units="minute" />
                        </span>
                      </div>
                      <p>{comment.body}</p>
                    </div>
                  </div>
                ))}
              </div>

              <form className={classes.comment__form} onSubmit={handleCommentSubmit}>
                <input
                  type="text"
                  value={commentText}
                  onChange={(event) => setCommentText(event.target.value)}
                  placeholder="Add a comment"
                  aria-label="Add a comment"
                />
                <button type="submit" disabled={!commentText.trim() || !user?._id}>
                  Send
                </button>
              </form>
            </div>
          )}
        </div>
      </Paper>
    );
  }
);

export default Post;
