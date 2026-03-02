import React from "react";
import ThumbUpAltIcon from "@material-ui/icons/ThumbUpAlt";
import ThumbUpAltOutlinedIcon from "@material-ui/icons/ThumbUpAltOutlined";
import CommentOutlinedIcon from "@material-ui/icons/CommentOutlined";
import RepeatIcon from "@material-ui/icons/Repeat";
import BookmarkBorderOutlinedIcon from "@material-ui/icons/BookmarkBorderOutlined";
import BookmarkIcon from "@material-ui/icons/Bookmark";
import { REACTION_ITEMS } from "../../../utils/reactions";

const PostActions = ({
  classes,
  canInteract,
  canReact,
  selectedReaction,
  selectedReactionItem,
  onReactionChange,
  showComments,
  onToggleComments,
  onRepostClick,
  canBookmark,
  isBookmarked,
  onBookmarkClick,
}) => {
  const [isReactionPickerOpen, setIsReactionPickerOpen] = React.useState(false);
  const reactionPickerCloseTimeoutRef = React.useRef(null);
  const reactionPickerLongPressTimeoutRef = React.useRef(null);
  const didLongPressOpenReactionPickerRef = React.useRef(false);

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

  const handleLikeClick = () => {
    if (didLongPressOpenReactionPickerRef.current) {
      didLongPressOpenReactionPickerRef.current = false;
      return;
    }

    const nextReaction = selectedReaction === "like" ? null : "like";
    onReactionChange(nextReaction);
  };

  const handleReactionSelect = (reactionType) => {
    const nextReaction = selectedReaction === reactionType ? null : reactionType;
    clearReactionPickerCloseTimeout();
    clearReactionPickerLongPressTimeout();
    didLongPressOpenReactionPickerRef.current = false;
    setIsReactionPickerOpen(false);
    onReactionChange(nextReaction);
  };

  return (
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
      <div className={classes.action__icons} onClick={onToggleComments}>
        <CommentOutlinedIcon style={showComments ? { color: "#2e7d32" } : undefined} />
        <h4 style={showComments ? { color: "#2e7d32" } : undefined}>Comment</h4>
      </div>
      <div
        className={classes.action__icons}
        onClick={onRepostClick}
        style={!canInteract ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
      >
        <RepeatIcon />
        <h4>Repost</h4>
      </div>
      <div
        className={classes.action__icons}
        onClick={canBookmark ? onBookmarkClick : undefined}
        style={!canInteract ? { opacity: 0.45, cursor: "not-allowed" } : undefined}
      >
        {isBookmarked ? <BookmarkIcon style={{ color: "#2e7d32" }} /> : <BookmarkBorderOutlinedIcon />}
        <h4 style={isBookmarked ? { color: "#2e7d32" } : undefined}>
          {isBookmarked ? "Saved" : "Save"}
        </h4>
      </div>
    </div>
  );
};

export default PostActions;
