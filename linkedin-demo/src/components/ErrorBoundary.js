import React, { Component } from "react";
import { fade, makeStyles, withTheme } from "@material-ui/core/styles";

const useStyles = makeStyles((theme) => {
  const isDark = theme.palette.type === "dark";

  return {
    root: {
      width: "100%",
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      boxSizing: "border-box",
      background: isDark
        ? `linear-gradient(180deg, ${fade(theme.palette.primary.main, 0.16)} 0%, ${theme.palette.background.default} 100%)`
        : `linear-gradient(180deg, ${fade(theme.palette.primary.main, 0.08)} 0%, ${fade(theme.palette.primary.main, 0.02)} 100%)`,
    },
    card: {
      width: "100%",
      maxWidth: "460px",
      borderRadius: "14px",
      border: `1px solid ${theme.palette.divider}`,
      backgroundColor: theme.palette.background.paper,
      boxShadow: isDark ? "0 12px 30px rgba(0, 0, 0, 0.45)" : "0 12px 30px rgba(0, 0, 0, 0.08)",
      padding: "28px 24px",
      textAlign: "center",
      color: theme.palette.text.primary,
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    },
    icon: {
      fontSize: "44px",
      lineHeight: 1,
      marginBottom: "12px",
    },
    title: {
      margin: 0,
      fontSize: "1.5rem",
      fontWeight: 700,
      color: theme.palette.text.primary,
    },
    description: {
      margin: "12px 0 20px",
      fontSize: "0.98rem",
      lineHeight: 1.5,
      color: theme.palette.text.secondary,
    },
    refreshButton: {
      border: 0,
      borderRadius: "999px",
      padding: "10px 18px",
      backgroundColor: theme.palette.primary.main,
      color: theme.palette.common.white,
      fontSize: "0.95rem",
      fontWeight: 600,
      cursor: "pointer",
    },
  };
});

class ErrorBoundaryContent extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Error boundary caught an error:", error, errorInfo);
  };

  render() {
    const { hasError } = this.state;
    const { children, classes } = this.props;

    if (hasError) {
      return (
        <div className={classes.root}>
          <div className={classes.card}>
            <div className={classes.icon}>🐢</div>
            <h1 className={classes.title}>Something went wrong</h1>
            <p className={classes.description}>Try refreshing the page.</p>
            <button
              className={classes.refreshButton}
              type="button"
              onClick={() => window.location.reload()}
            >
              Refresh
            </button>
          </div>
        </div>
      );
    }

    return children;
  }
}

function ErrorBoundary(props) {
  const classes = useStyles();

  return <ErrorBoundaryContent {...props} classes={classes} />;
}

export default withTheme(ErrorBoundary);
