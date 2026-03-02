import { makeStyles } from "@material-ui/core/styles";

export default makeStyles((theme) => ({
  card: {
    width: 360,
    [theme.breakpoints.down("xs")]: {
      width: "100%",
      border: 0,
      borderRadius: 0,
      boxShadow: "none",
    },
    minHeight: 420,
    backgroundColor: theme.palette.background.paper,
    color: theme.palette.text.primary,
    border: `1px solid ${theme.palette.divider}`,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    gap: 28,
    position: "relative",
  },

  closeButton: {
    position: "absolute",
    top: 8,
    right: 8,
  },

  header: {
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
  },

  brand: {
    margin: 0,
    color: "#2e7d32",
    fontSize: 36,
    lineHeight: 1,
    letterSpacing: "-0.03em",
  },

  subtitle: {
    margin: 0,
    color: theme.palette.text.secondary,
    fontSize: 14,
  },

  authButtons: {
    width: 280,
    display: "flex",
    flexDirection: "column",
    gap: 12,
    "& > button": {
      height: 42,
      borderRadius: 999,
      border: "1px solid transparent",
      cursor: "pointer",
      fontSize: 14,
      fontWeight: 600,
      transition: "all 0.2s ease",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
      "&:hover": {
        transform: "translateY(-1px)",
      },
      "&:disabled": {
        cursor: "not-allowed",
        opacity: 0.75,
      },
      "&:disabled:hover": {
        transform: "none",
      },
    },
  },

  githubBtn: {
    backgroundColor: "#24292e",
    color: "#ffffff",
    "&:hover": {
      backgroundColor: "#171b20",
    },
  },

  googleBtn: {
    backgroundColor: theme.palette.type === "dark" ? theme.palette.background.default : "#ffffff",
    color: theme.palette.text.primary,
    borderColor: theme.palette.divider,
    "&:hover": {
      backgroundColor: theme.palette.action.hover,
    },
  },

  googleMark: {
    width: 18,
    height: 18,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    fontWeight: 700,
    fontSize: 16,
    background: "linear-gradient(45deg, #4285f4 25%, #ea4335 25%, #ea4335 50%, #fbbc05 50%, #fbbc05 75%, #34a853 75%)",
    WebkitBackgroundClip: "text",
    WebkitTextFillColor: "transparent",
  },
}));
