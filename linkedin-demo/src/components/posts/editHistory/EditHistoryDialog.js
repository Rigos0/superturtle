import React from "react";
import { useQuery } from "convex/react";
import { makeStyles } from "@material-ui/core/styles";
import Button from "@material-ui/core/Button";
import CircularProgress from "@material-ui/core/CircularProgress";
import Dialog from "@material-ui/core/Dialog";
import DialogActions from "@material-ui/core/DialogActions";
import DialogContent from "@material-ui/core/DialogContent";
import DialogTitle from "@material-ui/core/DialogTitle";
import Typography from "@material-ui/core/Typography";
import ReactTimeago from "react-timeago";
import { api } from "../../../convex/_generated/api";

const useStyles = makeStyles((theme) => ({
  loading: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: `${theme.spacing(1)}px 0`,
  },
  empty: {
    padding: `${theme.spacing(1)}px 0`,
  },
  entry: {
    padding: `${theme.spacing(1.5)}px 0`,
    borderBottom: `1px solid ${theme.palette.divider}`,
    "&:last-child": {
      borderBottom: "none",
      paddingBottom: 0,
    },
  },
  entryMeta: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 6,
  },
  relativeTime: {
    fontSize: 12,
    color: theme.palette.text.secondary,
    whiteSpace: "nowrap",
  },
  absoluteTime: {
    fontSize: 12,
    color: theme.palette.text.secondary,
  },
  description: {
    marginTop: 8,
    fontSize: 14,
    color: theme.palette.text.primary,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
}));

const formatTimestamp = (timestamp) => {
  if (typeof timestamp !== "number") {
    return "";
  }

  return new Date(timestamp).toLocaleString();
};

const EditHistoryDialog = ({ open, onClose, postId }) => {
  const classes = useStyles();
  const editHistory = useQuery(
    api.postEdits.getEditHistory,
    open && postId ? { postId } : "skip",
  );
  const isLoading = open && editHistory === undefined;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="sm"
      aria-labelledby={`edit-history-dialog-title-${postId}`}
    >
      <DialogTitle id={`edit-history-dialog-title-${postId}`}>
        Edit history
      </DialogTitle>
      <DialogContent dividers>
        {isLoading && (
          <div className={classes.loading}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="textSecondary">
              Loading previous versions...
            </Typography>
          </div>
        )}

        {!isLoading && (editHistory ?? []).length === 0 && (
          <Typography variant="body2" color="textSecondary" className={classes.empty}>
            No previous versions available.
          </Typography>
        )}

        {!isLoading &&
          (editHistory ?? []).map((edit) => (
            <div key={edit._id} className={classes.entry}>
              <div className={classes.entryMeta}>
                <Typography variant="subtitle2">Previous version</Typography>
                <Typography className={classes.relativeTime}>
                  <ReactTimeago date={new Date(edit.editedAt).toUTCString()} units="minute" />
                </Typography>
              </div>
              <Typography className={classes.absoluteTime}>
                {formatTimestamp(edit.editedAt)}
              </Typography>
              <Typography className={classes.description}>
                {edit.previousDescription}
              </Typography>
            </div>
          ))}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="primary">
          Close
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default EditHistoryDialog;
