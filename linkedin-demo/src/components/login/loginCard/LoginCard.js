import React from "react";
import { IconButton, Paper } from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";
import { useAuthActions } from "@convex-dev/auth/react";
import Style from "./Style";

const LoginCard = ({ onClose }) => {
  const classes = Style();
  const authActions = useAuthActions();
  const signIn = authActions?.signIn ?? (() => Promise.resolve());

  return (
    <Paper elevation={3} className={classes.card}>
      {typeof onClose === "function" && (
        <IconButton aria-label="Close sign in" className={classes.closeButton} onClick={onClose}>
          <CloseIcon fontSize="small" />
        </IconButton>
      )}
      <header className={classes.header}>
        <h1 className={classes.brand}><img src="/turtle-mascot.png" alt="TurtleIn" style={{ height: 40, verticalAlign: 'middle', marginRight: 8 }} />TurtleIn</h1>
        <p className={classes.subtitle}>Sign in to continue</p>
      </header>

      <div className={classes.authButtons}>
        <button className={classes.githubBtn} onClick={() => signIn("github")} type="button">
          Sign in with GitHub
        </button>
        <button className={classes.googleBtn} onClick={() => signIn("google")} type="button">
          <span className={classes.googleMark}>G</span>
          <span>Sign in with Google</span>
        </button>
      </div>
    </Paper>
  );
};

export default LoginCard;
