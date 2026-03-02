import React, { forwardRef } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import Avatar from "@material-ui/core/Avatar";
import Dialog from "@material-ui/core/Dialog";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogTitle from "@material-ui/core/DialogTitle";
import Menu from "@material-ui/core/Menu";
import MenuItem from "@material-ui/core/MenuItem";
import Paper from "@material-ui/core/Paper";
import MoreHorizOutlinedIcon from "@material-ui/icons/MoreHorizOutlined";
import ThumbUpAltIcon from "@material-ui/icons/ThumbUpAlt";
import ThumbUpAltOutlinedIcon from "@material-ui/icons/ThumbUpAltOutlined";
import FavoriteIcon from "@material-ui/icons/Favorite";
import EmojiEventsIcon from "@material-ui/icons/EmojiEvents";
import EmojiObjectsIcon from "@material-ui/icons/EmojiObjects";
import SentimentVerySatisfiedIcon from "@material-ui/icons/SentimentVerySatisfied";
import FiberManualRecordRoundedIcon from "@material-ui/icons/FiberManualRecordRounded";
import CommentOutlinedIcon from "@material-ui/icons/CommentOutlined";
import RepeatIcon from "@material-ui/icons/Repeat";
import DeleteOutlineIcon from "@material-ui/icons/DeleteOutline";
import ReactPlayer from "react-player";
import ReactTimeago from "react-timeago";
import { api } from "../../../convex/_generated/api";
import { DEFAULT_PHOTO } from "../../../constants";
import useConvexUser from "../../../hooks/useConvexUser";
import { getLinkPreviewFromText } from "./post.utils";
import Style from "./Style";

const resolvePhoto = (photoURL) => {
  if (!photoURL || (typeof photoURL === "string" && photoURL.startsWith("/"))) {
    return DEFAULT_PHOTO;
  }

  return photoURL;
};

const REACTION_ITEMS = [
  {
    key: "like",
    label: "Like",
    color: "#2e7d32",
    Icon: ThumbUpAltIcon,
  },
  {
    key: "love",
    label: "Love",
    color: "#d32f2f",
    Icon: FavoriteIcon,
  },
  {
    key: "celebrate",
    label: "Celebrate",
    color: "#ed6c02",
    Icon: EmojiEventsIcon,
  },
  {
    key: "insightful",
    label: "Insightful",
    color: "#0288d1",
    Icon: EmojiObjectsIcon,
  },
  {
    key: "funny",
    label: "Funny",
    color: "#f9a825",
    Icon: SentimentVerySatisfiedIcon,
  },
];
const REACTION_ITEM_BY_KEY = REACTION_ITEMS.reduce((accumulator, item) => {
  accumulator[item.key] = item;
  return accumulator;
}, {});

const Post = forwardRef(
  (
    {
      postId,
      authorId,
      authorUsername,
      likesCount = 0,
      commentsCount = 0,
      repostCount,
      currentReaction,
      reactionCounts,
      profile,
      username,
      timestamp,
      description,
      fileType,
      fileData,
      imageUrls,
      onNavigateProfile,
    },
    ref
  ) => {
    const classes = Style();
    const user = useConvexUser();
    const { isAuthenticated } = useConvexAuth();
    const setReaction = useMutation(api.likes.setReaction);
    const removeReaction = useMutation(api.likes.removeReaction);
    const addComment = useMutation(api.comments.addComment);
    const deletePost = useMutation(api.posts.deletePost);
    const deleteComment = useMutation(api.comments.deleteComment);
    const updatePost = useMutation(api.posts.updatePost);
    const repostPost = useMutation(api.reposts.repostPost);

    const [showComments, setShowComments] = React.useState(false);
    const [commentText, setCommentText] = React.useState("");
    const [menuAnchorEl, setMenuAnchorEl] = React.useState(null);
    const [isEditing, setIsEditing] = React.useState(false);
    const [editText, setEditText] = React.useState(description ?? "");
    const [isRepostDialogOpen, setIsRepostDialogOpen] = React.useState(false);
    const [repostCommentary, setRepostCommentary] = React.useState("");
    const [isRepostPending, setIsRepostPending] = React.useState(false);
    const [optimisticReaction, setOptimisticReaction] = React.useState(undefined);
    const [isReactionMutationPending, setIsReactionMutationPending] = React.useState(false);
    const [isReactionPickerOpen, setIsReactionPickerOpen] = React.useState(false);
    const reactionPickerCloseTimeoutRef = React.useRef(null);
    const reactionPickerLongPressTimeoutRef = React.useRef(null);
    const didLongPressOpenReactionPickerRef = React.useRef(false);
    const linkPreview = React.useMemo(
      () => getLinkPreviewFromText(description),
      [description]
    );

    const comments = useQuery(
      api.comments.listComments,
      showComments ? { postId } : "skip"
    );
    const queriedRepostCount = useQuery(api.reposts.getRepostCount, { postId });
    const resolvedRepostCount =
      typeof repostCount === "number" ? repostCount : (queriedRepostCount ?? 0);

    const serverReaction = currentReaction ?? null;
    const selectedReaction =
      optimisticReaction !== undefined ? optimisticReaction : serverReaction;
    const selectedReactionItem = selectedReaction
      ? REACTION_ITEM_BY_KEY[selectedReaction] ?? null
      : null;

    // Clear optimistic state once server catches up
    React.useEffect(() => {
      if (currentReaction !== undefined) {
        setOptimisticReaction(undefined);
      }
    }, [currentReaction]);
    const commentsList = comments ?? [];
    const canInteract = Boolean(isAuthenticated && user?._id);
    const canReact = canInteract && !isReactionMutationPending;
    const isOwnPost = Boolean(canInteract && authorId && authorId === user._id);
    const isMenuOpen = Boolean(menuAnchorEl);
    const canNavigateProfile =
      typeof onNavigateProfile === "function" && Boolean(authorId || authorUsername);

    React.useEffect(() => {
      if (!isEditing) {
        setEditText(description ?? "");
      }
    }, [description, isEditing]);

    React.useEffect(() => {
      return () => {
        if (reactionPickerCloseTimeoutRef.current) {
          clearTimeout(reactionPickerCloseTimeoutRef.current);
        }
        if (reactionPickerLongPressTimeoutRef.current) {
          clearTimeout(reactionPickerLongPressTimeoutRef.current);
        }
      };
    }, []);

    const capitalize = (_string = "") => {
      return _string.charAt(0).toUpperCase() + _string.slice(1);
    };

    const postImages = React.useMemo(() => {
      if (fileType !== "image") {
        return [];
      }

      if (Array.isArray(imageUrls) && imageUrls.length > 0) {
        return imageUrls
          .filter((imageUrl) => typeof imageUrl === "string" && imageUrl.length > 0)
          .slice(0, 4);
      }

      if (fileData) {
        return [fileData];
      }

      return [];
    }, [fileData, fileType, imageUrls]);

    const imageGridClassName =
      postImages.length <= 1
        ? classes.imageGrid1
        : postImages.length === 2
          ? classes.imageGrid2
          : postImages.length === 3
            ? classes.imageGrid3
            : classes.imageGrid4;

    const applyReaction = async (nextReaction) => {
      if (!canReact || !user?._id) {
        return;
      }

      setOptimisticReaction(nextReaction);
      setIsReactionMutationPending(true);

      try {
        if (nextReaction) {
          await setReaction({ userId: user._id, postId, reactionType: nextReaction });
        } else {
          await removeReaction({ userId: user._id, postId });
        }
      } catch (error) {
        setOptimisticReaction(undefined);
        console.error("Failed to update reaction:", error);
      } finally {
        setIsReactionMutationPending(false);
      }
    };

    const handleLikeClick = () => {
      if (didLongPressOpenReactionPickerRef.current) {
        didLongPressOpenReactionPickerRef.current = false;
        return;
      }

      const nextReaction = selectedReaction === "like" ? null : "like";
      applyReaction(nextReaction);
    };

    const clearReactionPickerCloseTimeout = () => {
      if (reactionPickerCloseTimeoutRef.current) {
        clearTimeout(reactionPickerCloseTimeoutRef.current);
        reactionPickerCloseTimeoutRef.current = null;
      }
    };

    const scheduleReactionPickerClose = () => {
      clearReactionPickerCloseTimeout();
      reactionPickerCloseTimeoutRef.current = setTimeout(() => {
        setIsReactionPickerOpen(false);
        reactionPickerCloseTimeoutRef.current = null;
      }, 120);
    };

    const clearReactionPickerLongPressTimeout = () => {
      if (reactionPickerLongPressTimeoutRef.current) {
        clearTimeout(reactionPickerLongPressTimeoutRef.current);
        reactionPickerLongPressTimeoutRef.current = null;
      }
    };

    const handleReactionActionMouseEnter = () => {
      if (!canInteract) {
        return;
      }

      clearReactionPickerCloseTimeout();
      setIsReactionPickerOpen(true);
    };

    const handleReactionActionMouseLeave = () => {
      if (!canInteract) {
        return;
      }

      scheduleReactionPickerClose();
    };

    const handleReactionActionTouchStart = () => {
      if (!canReact) {
        return;
      }

      didLongPressOpenReactionPickerRef.current = false;
      clearReactionPickerLongPressTimeout();
      reactionPickerLongPressTimeoutRef.current = setTimeout(() => {
        didLongPressOpenReactionPickerRef.current = true;
        setIsReactionPickerOpen(true);
        reactionPickerLongPressTimeoutRef.current = null;
      }, 350);
    };

    const handleReactionActionTouchEnd = () => {
      clearReactionPickerLongPressTimeout();
    };

    const handleReactionActionTouchCancel = () => {
      clearReactionPickerLongPressTimeout();
    };

    const handleReactionSelect = (reactionType) => {
      const nextReaction = selectedReaction === reactionType ? null : reactionType;
      clearReactionPickerCloseTimeout();
      clearReactionPickerLongPressTimeout();
      didLongPressOpenReactionPickerRef.current = false;
      setIsReactionPickerOpen(false);
      applyReaction(nextReaction);
    };

    const handleCommentSubmit = async (event) => {
      event.preventDefault();
      if (!canInteract) {
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

    const handleRepostClick = () => {
      if (!canInteract) {
        return;
      }

      setIsRepostDialogOpen(true);
    };

    const handleRepostDialogClose = () => {
      if (isRepostPending) {
        return;
      }

      setRepostCommentary("");
      setIsRepostDialogOpen(false);
    };

    const handleRepostSubmit = async () => {
      if (!canInteract || !user?._id || isRepostPending) {
        return;
      }

      const nextCommentary = repostCommentary.trim();
      setIsRepostPending(true);

      try {
        await repostPost(
          nextCommentary.length > 0
            ? { postId, commentary: nextCommentary }
            : { postId },
        );
        setRepostCommentary("");
        setIsRepostDialogOpen(false);
      } catch (error) {
        console.error("Failed to repost:", error);
      } finally {
        setIsRepostPending(false);
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
      if (canNavigateProfile) {
        onNavigateProfile({
          username: authorUsername ?? null,
          userId: authorId ?? null,
        });
      }
    };

    const resolvedReactionCounts = {
      like: reactionCounts?.like ?? likesCount,
      love: reactionCounts?.love ?? 0,
      celebrate: reactionCounts?.celebrate ?? 0,
      insightful: reactionCounts?.insightful ?? 0,
      funny: reactionCounts?.funny ?? 0,
    };
    // Apply optimistic delta for whichever reaction changed.
    if (optimisticReaction !== undefined) {
      if (serverReaction) {
        resolvedReactionCounts[serverReaction] = Math.max(
          0,
          resolvedReactionCounts[serverReaction] - 1,
        );
      }

      if (optimisticReaction) {
        resolvedReactionCounts[optimisticReaction] += 1;
      }
    }
    const totalReactionCount =
      resolvedReactionCounts.like +
      resolvedReactionCounts.love +
      resolvedReactionCounts.celebrate +
      resolvedReactionCounts.insightful +
      resolvedReactionCounts.funny;
    const visibleReactionItems = REACTION_ITEMS.filter(
      (item) => resolvedReactionCounts[item.key] > 0,
    );

    const hasStats =
      totalReactionCount > 0 || commentsCount > 0 || resolvedRepostCount > 0;
    const textStats = [];
    if (commentsCount > 0) {
      textStats.push(`${commentsCount} ${commentsCount === 1 ? "comment" : "comments"}`);
    }
    if (resolvedRepostCount > 0) {
      textStats.push(
        `${resolvedRepostCount} ${resolvedRepostCount === 1 ? "repost" : "reposts"}`,
      );
    }

    const Reactions = () => {
      if (!hasStats) return null;

      return (
        <div className={classes.footer__stats}>
          {totalReactionCount > 0 && (
            <div className={classes.reactionSummary}>
              <div className={classes.reactionIconStack}>
                {visibleReactionItems.slice(0, 3).map((item) => {
                  const IconComponent = item.Icon;

                  return (
                    <div
                      key={item.key}
                      className={classes.reactionIconBadge}
                      style={{ backgroundColor: item.color }}
                    >
                      <IconComponent className={classes.reactionIconGlyph} />
                    </div>
                  );
                })}
              </div>
              <h4>{totalReactionCount}</h4>

              <div className={classes.reactionBreakdown} role="tooltip">
                {visibleReactionItems.map((item) => {
                  const IconComponent = item.Icon;
                  return (
                    <div key={item.key} className={classes.reactionBreakdownItem}>
                      <IconComponent
                        className={classes.reactionBreakdownIcon}
                        style={{ color: item.color }}
                      />
                      <span className={classes.reactionBreakdownLabel}>{item.label}</span>
                      <span className={classes.reactionBreakdownCount}>
                        {resolvedReactionCounts[item.key]}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {textStats.map((statText, index) => (
            <React.Fragment key={statText}>
              {(totalReactionCount > 0 || index > 0) && (
                <FiberManualRecordRoundedIcon
                  style={{ fontSize: 6, color: "grey", margin: "0 4px" }}
                />
              )}
              <h4>{statText}</h4>
            </React.Fragment>
          ))}
        </div>
      );
    };

    return (
      <>
        <Paper ref={ref} className={classes.post} id={`post-${postId}`}>
        <div className={classes.post__header}>
          <Avatar
            src={resolvePhoto(profile)}
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
              <ReactTimeago date={new Date(timestamp).toUTCString()} units="minute" />
            </p>
          </div>
          {isOwnPost && (
            <>
              <MoreHorizOutlinedIcon onClick={handleMenuOpen} />
              <Menu
                anchorEl={menuAnchorEl}
                keepMounted
                open={isMenuOpen}
                onClose={handleMenuClose}
              >
                <MenuItem onClick={handleEditClick}>Edit</MenuItem>
                <MenuItem onClick={handleDeleteClick}>Delete</MenuItem>
              </Menu>
            </>
          )}
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
          {!isEditing && linkPreview && (
            <div className={classes.body__linkPreview}>
              <a
                className={classes.linkPreviewCard}
                href={linkPreview.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                <h5>{linkPreview.hostname}</h5>
                <p>{linkPreview.href}</p>
              </a>
            </div>
          )}
          {((fileType === "image" && postImages.length > 0) ||
            (fileType !== "image" && fileData)) && (
            <div className={classes.body__image}>
              {fileType === "image" ? (
                <div className={`${classes.body__imageGrid} ${imageGridClassName}`}>
                  {postImages.map((imageUrl, index) => (
                    <div
                      key={`${postId}-image-${index}`}
                      className={classes.imageGridItem}
                      style={
                        postImages.length === 3 && index === 0
                          ? { gridColumn: "1 / span 2" }
                          : undefined
                      }
                    >
                      <img src={imageUrl} alt={`post media ${index + 1}`} loading="lazy" />
                    </div>
                  ))}
                </div>
              ) : (
                <ReactPlayer
                  url={fileData}
                  controls={true}
                  style={{ height: "auto !important" }}
                />
              )}
            </div>
          )}
        </div>
        <div className={classes.post__footer}>
          <Reactions />
          <div className={classes.footer__actions}>
            <div
              className={classes.reactionActionWrapper}
              onMouseEnter={canInteract ? handleReactionActionMouseEnter : undefined}
              onMouseLeave={canInteract ? handleReactionActionMouseLeave : undefined}
            >
              {canInteract && isReactionPickerOpen && (
                <div
                  className={classes.reactionPicker}
                  role="menu"
                  aria-label="Select reaction"
                  onMouseEnter={handleReactionActionMouseEnter}
                  onMouseLeave={handleReactionActionMouseLeave}
                >
                  {REACTION_ITEMS.map((item) => {
                    const IconComponent = item.Icon;
                    const isSelected = selectedReaction === item.key;

                    return (
                      <button
                        key={item.key}
                        type="button"
                        className={`${classes.reactionPickerButton} ${isSelected ? classes.reactionPickerButtonActive : ""}`}
                        onClick={() => handleReactionSelect(item.key)}
                        aria-label={item.label}
                      >
                        <IconComponent
                          className={classes.reactionPickerIcon}
                          style={{ color: item.color }}
                        />
                      </button>
                    );
                  })}
                </div>
              )}

              <div
                className={classes.action__icons}
                onClick={canInteract ? handleLikeClick : undefined}
                onTouchStart={canInteract ? handleReactionActionTouchStart : undefined}
                onTouchEnd={canInteract ? handleReactionActionTouchEnd : undefined}
                onTouchCancel={canInteract ? handleReactionActionTouchCancel : undefined}
                style={!canInteract ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
              >
                {canInteract && selectedReaction ? (
                  <ThumbUpAltIcon
                    style={{
                      transform: "scaleX(-1)",
                      color: selectedReactionItem?.color ?? "#2e7d32",
                    }}
                  />
                ) : (
                  <ThumbUpAltOutlinedIcon style={{ transform: "scaleX(-1)" }} />
                )}
                <h4
                  style={
                    canInteract && selectedReaction
                      ? { color: selectedReactionItem?.color ?? "#2e7d32" }
                      : undefined
                  }
                >
                  {selectedReactionItem?.label ?? "Like"}
                </h4>
              </div>
            </div>
            <div
              className={classes.action__icons}
              onClick={() => setShowComments((prev) => !prev)}
            >
              <CommentOutlinedIcon style={showComments ? { color: "#2e7d32" } : undefined} />
              <h4 style={showComments ? { color: "#2e7d32" } : undefined}>Comment</h4>
            </div>
            <div
              className={classes.action__icons}
              onClick={handleRepostClick}
              style={!canInteract ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
            >
              <RepeatIcon />
              <h4>Repost</h4>
            </div>
          </div>

          {showComments && (
            <div className={classes.comments__section}>
              <div className={classes.comments__list}>
                {commentsList.map((comment) => (
                  <div key={comment._id} className={classes.comment__item}>
                    <Avatar
                      className={classes.comment__avatar}
                      src={resolvePhoto(comment.author?.photoURL)}
                      alt={comment.author?.displayName ?? "Comment author"}
                    />
                    <div className={classes.comment__content}>
                      <div className={classes.comment__meta}>
                        <h5>{comment.author?.displayName ?? "Unknown user"}</h5>
                        <span>
                          <ReactTimeago date={new Date(comment.createdAt).toUTCString()} units="minute" />
                        </span>
                        {user?._id && comment.authorId === user._id && (
                          <DeleteOutlineIcon
                            className={classes.comment__delete}
                            onClick={() => deleteComment({ commentId: comment._id, userId: user._id })}
                            titleAccess="Delete comment"
                          />
                        )}
                      </div>
                      <p>{comment.body}</p>
                    </div>
                  </div>
                ))}
              </div>

              {canInteract && (
                <form className={classes.comment__form} onSubmit={handleCommentSubmit}>
                  <input
                    type="text"
                    value={commentText}
                    onChange={(event) => setCommentText(event.target.value)}
                    placeholder="Add a comment"
                    aria-label="Add a comment"
                  />
                  <button type="submit" disabled={!commentText.trim()}>
                    Send
                  </button>
                </form>
              )}
            </div>
          )}
        </div>
        </Paper>

        <Dialog
          open={isRepostDialogOpen}
          onClose={handleRepostDialogClose}
          fullWidth
          maxWidth="sm"
          aria-labelledby={`repost-dialog-title-${postId}`}
        >
          <DialogTitle id={`repost-dialog-title-${postId}`}>Repost</DialogTitle>
          <DialogContent dividers>
            <p className={classes.repostDialogHint}>Add commentary (optional)</p>
            <textarea
              className={classes.repostDialogTextarea}
              rows={4}
              value={repostCommentary}
              onChange={(event) => setRepostCommentary(event.target.value)}
              placeholder="Share your thoughts"
              aria-label="Repost commentary"
              disabled={isRepostPending}
            />
          </DialogContent>
          <DialogActions className={classes.repostDialogActions}>
            <button
              type="button"
              className={classes.repostDialogCancelButton}
              onClick={handleRepostDialogClose}
              disabled={isRepostPending}
            >
              Cancel
            </button>
            <button
              type="button"
              className={classes.repostDialogSubmitButton}
              onClick={handleRepostSubmit}
              disabled={isRepostPending}
            >
              {isRepostPending ? "Reposting..." : "Repost"}
            </button>
          </DialogActions>
        </Dialog>
      </>
    );
  }
);

export default Post;
