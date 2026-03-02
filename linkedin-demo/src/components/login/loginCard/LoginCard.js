import React from "react";
import { CircularProgress, IconButton, Paper } from "@material-ui/core";
import CloseIcon from "@material-ui/icons/Close";
import { useAuthActions } from "@convex-dev/auth/react";
import Style from "./Style";

const LoginCard = ({ onClose }) => {
  const classes = Style();
  const authActions = useAuthActions();
  const signIn = authActions?.signIn ?? (() => Promise.resolve());
  const [signingIn, setSigningIn] = React.useState("");
  const isSigningIn = Boolean(signingIn);

  const handleSignIn = async (provider) => {
    if (isSigningIn) {
      return;
    }

    setSigningIn(provider);
    try {
      await signIn(provider);
    } catch (_error) {
      setSigningIn("");
    }
  };

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
        <button className={classes.githubBtn} disabled={isSigningIn} onClick={() => handleSignIn("github")} type="button">
          {signingIn === "github" ? (
            <>
              <CircularProgress size={16} color="inherit" thickness={5} />
              <span>Signing in...</span>
            </>
          ) : (
            "Sign in with GitHub"
          )}
        </button>
        <button className={classes.googleBtn} disabled={isSigningIn} onClick={() => handleSignIn("google")} type="button">
          {signingIn === "google" ? (
            <>
              <CircularProgress size={16} color="inherit" thickness={5} />
              <span>Signing in...</span>
            </>
          ) : (
            <>
              <span className={classes.googleMark}>G</span>
              <span>Sign in with Google</span>
            </>
          )}
        </button>
      </div>
    </Paper>
  );
};

export default LoginCard;
