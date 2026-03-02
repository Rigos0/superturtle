import React, { useMemo, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useNavigate, useParams } from "react-router-dom";
import Avatar from "@material-ui/core/Avatar";
import Button from "@material-ui/core/Button";
import CircularProgress from "@material-ui/core/CircularProgress";
import Paper from "@material-ui/core/Paper";
import Typography from "@material-ui/core/Typography";
import { fade, makeStyles } from "@material-ui/core/styles";
import ReactTimeago from "react-timeago";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";
import { resolvePhoto } from "../../utils/photo";
import { REACTION_ITEMS } from "../../utils/reactions";

const renderInlineRichText = (line, lineIndex) => {
  const tokens = line.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g);

  return tokens.map((token, tokenIndex) => {
    if (!token) {
      return null;
    }

    const key = `${lineIndex}-${tokenIndex}`;

    if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
      return <strong key={key}>{token.slice(2, -2)}</strong>;
    }

    if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
      return <em key={key}>{token.slice(1, -1)}</em>;
    }

    return <React.Fragment key={key}>{token}</React.Fragment>;
  });
};

const renderBody = (value) => {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    return "No article body available.";
  }

  const lines = text.split("\n");

  return lines.map((line, lineIndex) => (
    <React.Fragment key={`line-${lineIndex}`}>
      {renderInlineRichText(line, lineIndex)}
      {lineIndex < lines.length - 1 && <br />}
    </React.Fragment>
  ));
};

const useStyles = makeStyles((theme) => ({
  page: {
    width: "100%",
    padding: theme.spacing(1, 0, 3),
  },
  card: {
    width: "100%",
    borderRadius: 12,
    border: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(2.5),
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(2),
  },
  title: {
    fontWeight: 800,
    color: theme.palette.primary.main,
    lineHeight: 1.25,
    wordBreak: "break-word",
  },
  authorRow: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1.5),
  },
  authorMeta: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  authorName: {
    fontWeight: 700,
    lineHeight: 1.1,
  },
  authorTitle: {
    color: theme.palette.text.secondary,
    fontSize: "0.9rem",
    lineHeight: 1.2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  timestamp: {
    color: theme.palette.text.secondary,
    fontSize: "0.8rem",
    lineHeight: 1.2,
  },
  body: {
    marginTop: theme.spacing(0.5),
    fontSize: "1.03rem",
    lineHeight: 1.75,
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  reactionsHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
    paddingTop: theme.spacing(2),
    borderTop: `1px solid ${theme.palette.divider}`,
  },
  totalReactions: {
    fontWeight: 600,
    color: theme.palette.text.secondary,
    fontSize: "0.9rem",
  },
  signInHint: {
    color: theme.palette.text.secondary,
    fontSize: "0.8rem",
  },
  reactionGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))",
    gap: theme.spacing(1),
  },
  reactionButton: {
    textTransform: "none",
    borderRadius: 999,
    border: `1px solid ${theme.palette.divider}`,
    justifyContent: "flex-start",
    padding: theme.spacing(0.75, 1.25),
    minHeight: 40,
    "& .MuiButton-startIcon": {
      marginRight: theme.spacing(1),
    },
  },
  activeReactionButton: {
    borderColor: theme.palette.primary.main,
    backgroundColor: fade(theme.palette.primary.main, 0.08),
  },
  reactionCount: {
    marginLeft: "auto",
    color: theme.palette.text.secondary,
    fontWeight: 700,
    fontSize: "0.85rem",
  },
  stateCard: {
    width: "100%",
    borderRadius: 12,
    border: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(3),
    textAlign: "center",
  },
  stateText: {
    color: theme.palette.text.secondary,
  },
  backButton: {
    alignSelf: "flex-start",
    textTransform: "none",
  },
}));

const ArticleView = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const { id: routePostId } = useParams();
  const { isAuthenticated } = useConvexAuth();
  const currentUser = useConvexUser();
  const setReaction = useMutation(api.likes.setReaction);
  const removeReaction = useMutation(api.likes.removeReaction);
  const [isReactionMutationPending, setIsReactionMutationPending] = useState(false);

  const postId = useMemo(
    () => (typeof routePostId === "string" ? routePostId.trim() : ""),
    [routePostId],
  );
  const article = useQuery(api.articles.getArticle, postId ? { postId } : "skip");
  const reactionCountsByPostId = useQuery(
    api.likes.getReactionCountsByPostIds,
    postId ? { postIds: [postId] } : "skip",
  );
  const userReactionByPostId = useQuery(
    api.likes.getUserReactionsByPostIds,
    currentUser?._id && postId ? { userId: currentUser._id, postIds: [postId] } : "skip",
  );

  const currentReaction = postId ? userReactionByPostId?.[postId] ?? null : null;
  const counts = postId ? reactionCountsByPostId?.[postId] : null;
  const resolvedCounts = {
    like: counts?.like ?? article?.likesCount ?? 0,
    love: counts?.love ?? 0,
    celebrate: counts?.celebrate ?? 0,
    insightful: counts?.insightful ?? 0,
    funny: counts?.funny ?? 0,
  };
  const totalReactions =
    resolvedCounts.like +
    resolvedCounts.love +
    resolvedCounts.celebrate +
    resolvedCounts.insightful +
    resolvedCounts.funny;

  const handleReaction = async (reactionType) => {
    if (!currentUser?._id || !postId || isReactionMutationPending) {
      return;
    }

    setIsReactionMutationPending(true);

    try {
      if (currentReaction === reactionType) {
        await removeReaction({ userId: currentUser._id, postId });
      } else {
        await setReaction({ userId: currentUser._id, postId, reactionType });
      }
    } catch (error) {
      console.error("Failed to update reaction:", error);
    } finally {
      setIsReactionMutationPending(false);
    }
  };

  if (!postId) {
    return (
      <div className={classes.page}>
        <Paper elevation={0} className={classes.stateCard}>
          <Typography variant="h6">Invalid article link</Typography>
          <Typography variant="body2" className={classes.stateText}>
            The article ID in this URL is missing or invalid.
          </Typography>
        </Paper>
      </div>
    );
  }

  if (article === undefined) {
    return (
      <div className={classes.page}>
        <Paper elevation={0} className={classes.stateCard}>
          <CircularProgress size={28} />
          <Typography variant="body2" className={classes.stateText}>
            Loading article...
          </Typography>
        </Paper>
      </div>
    );
  }

  if (!article) {
    return (
      <div className={classes.page}>
        <Paper elevation={0} className={classes.stateCard}>
          <Typography variant="h6">Article not found</Typography>
          <Typography variant="body2" className={classes.stateText}>
            This article does not exist or is no longer available.
          </Typography>
        </Paper>
      </div>
    );
  }

  return (
    <div className={classes.page}>
      <Paper elevation={0} className={classes.card}>
        <Button className={classes.backButton} onClick={() => navigate(-1)}>
          Back
        </Button>

        <Typography variant="h4" className={classes.title}>
          {article.articleTitle?.trim() || "Untitled article"}
        </Typography>

        <div className={classes.authorRow}>
          <Avatar
            src={resolvePhoto(article.author?.photoURL)}
            alt={article.author?.displayName ?? "Article author"}
          />
          <div className={classes.authorMeta}>
            <Typography className={classes.authorName}>
              {article.author?.displayName ?? "Unknown user"}
            </Typography>
            {article.author?.title ? (
              <Typography className={classes.authorTitle}>{article.author.title}</Typography>
            ) : null}
            <Typography className={classes.timestamp}>
              <ReactTimeago date={new Date(article.createdAt).toUTCString()} units="minute" />
            </Typography>
          </div>
        </div>

        <Typography component="div" className={classes.body}>
          {renderBody(article.articleBody)}
        </Typography>

        <div className={classes.reactionsHeader}>
          <Typography className={classes.totalReactions}>
            {totalReactions} {totalReactions === 1 ? "reaction" : "reactions"}
          </Typography>
          {!isAuthenticated && (
            <Typography className={classes.signInHint}>Sign in to react</Typography>
          )}
        </div>

        <div className={classes.reactionGrid}>
          {REACTION_ITEMS.map((reactionItem) => {
            const Icon = reactionItem.Icon;
            const reactionCount = resolvedCounts[reactionItem.key] ?? 0;
            const isSelected = currentReaction === reactionItem.key;
            const isDisabled =
              !isAuthenticated || !currentUser?._id || isReactionMutationPending;

            return (
              <Button
                key={reactionItem.key}
                className={`${classes.reactionButton} ${isSelected ? classes.activeReactionButton : ""}`}
                startIcon={<Icon style={{ color: reactionItem.color }} />}
                onClick={() => handleReaction(reactionItem.key)}
                disabled={isDisabled}
              >
                {reactionItem.label}
                <span className={classes.reactionCount}>{reactionCount}</span>
              </Button>
            );
          })}
        </div>
      </Paper>
    </div>
  );
};

export default ArticleView;
