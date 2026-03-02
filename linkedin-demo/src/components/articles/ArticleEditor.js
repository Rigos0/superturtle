import React, { useMemo, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import {
  Button,
  CircularProgress,
  Paper,
  TextField,
  Typography,
} from "@material-ui/core";
import { fade, makeStyles } from "@material-ui/core/styles";
import { api } from "../../convex/_generated/api";

const TITLE_MAX_LENGTH = 150;
const BODY_MAX_LENGTH = 50000;

const useStyles = makeStyles((theme) => ({
  page: {
    width: "100%",
    padding: theme.spacing(1, 0, 3),
  },
  card: {
    width: "100%",
    borderRadius: 12,
    border: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(2),
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(2),
  },
  title: {
    fontWeight: 700,
    color: theme.palette.primary.main,
  },
  subtitle: {
    color: theme.palette.text.secondary,
  },
  input: {
    backgroundColor: theme.palette.background.paper,
  },
  bodyField: {
    "& .MuiOutlinedInput-inputMultiline": {
      lineHeight: 1.55,
      fontSize: "1rem",
    },
  },
  footer: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  },
  footerText: {
    color: theme.palette.text.secondary,
    fontSize: "0.85rem",
  },
  actions: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1),
  },
  publishButton: {
    backgroundColor: theme.palette.primary.main,
    color: "#fff",
    fontWeight: 700,
    textTransform: "none",
    "&:hover": {
      backgroundColor: theme.palette.primary.dark,
    },
    "&.Mui-disabled": {
      color: "rgba(255,255,255,0.7)",
      backgroundColor: fade(theme.palette.primary.main, 0.55),
    },
  },
  inlineLoader: {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.spacing(1),
  },
  errorText: {
    color: theme.palette.error.main,
    fontWeight: 500,
  },
}));

const ArticleEditor = () => {
  const classes = useStyles();
  const navigate = useNavigate();
  const { isAuthenticated } = useConvexAuth();
  const createArticle = useMutation(api.articles.createArticle);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState("");

  const trimmedTitle = useMemo(() => title.trim(), [title]);
  const trimmedBody = useMemo(() => body.trim(), [body]);
  const canPublish =
    Boolean(isAuthenticated) &&
    trimmedTitle.length > 0 &&
    trimmedBody.length > 0 &&
    !isPublishing;

  const handlePublish = async () => {
    if (!canPublish) {
      if (!isAuthenticated) {
        setError("Sign in to publish an article.");
      } else if (!trimmedTitle) {
        setError("Title is required.");
      } else if (!trimmedBody) {
        setError("Body is required.");
      }
      return;
    }

    setIsPublishing(true);
    setError("");

    try {
      const articleId = await createArticle({
        title: trimmedTitle,
        body: trimmedBody,
      });
      navigate(`/article/${articleId}`);
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Unable to publish article.");
    } finally {
      setIsPublishing(false);
    }
  };

  return (
    <div className={classes.page}>
      <Paper elevation={0} className={classes.card}>
        <Typography variant="h5" className={classes.title}>
          Write an article
        </Typography>
        <Typography variant="body2" className={classes.subtitle}>
          Share long-form updates with your network.
        </Typography>

        <TextField
          label="Title"
          variant="outlined"
          fullWidth
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          inputProps={{ maxLength: TITLE_MAX_LENGTH }}
          className={classes.input}
          autoFocus
          required
        />

        <TextField
          label="Body"
          variant="outlined"
          fullWidth
          multiline
          rows={18}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          inputProps={{ maxLength: BODY_MAX_LENGTH }}
          className={`${classes.input} ${classes.bodyField}`}
          required
        />

        {error ? (
          <Typography variant="body2" className={classes.errorText}>
            {error}
          </Typography>
        ) : null}

        <div className={classes.footer}>
          <Typography className={classes.footerText}>
            {title.length}/{TITLE_MAX_LENGTH} title characters • {body.length}/{BODY_MAX_LENGTH} body characters
          </Typography>
          <div className={classes.actions}>
            <Button onClick={() => navigate(-1)} disabled={isPublishing}>
              Cancel
            </Button>
            <Button
              variant="contained"
              className={classes.publishButton}
              onClick={handlePublish}
              disabled={!canPublish}
            >
              {isPublishing ? (
                <span className={classes.inlineLoader}>
                  <CircularProgress size={16} color="inherit" thickness={5} />
                  Publishing...
                </span>
              ) : (
                "Publish"
              )}
            </Button>
          </div>
        </div>
      </Paper>
    </div>
  );
};

export default ArticleEditor;
