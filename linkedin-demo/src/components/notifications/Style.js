import { makeStyles } from "@material-ui/core/styles";

export default makeStyles((theme) => ({
  root: {
    width: "100%",
    borderRadius: 8,
    overflow: "hidden",
    [theme.breakpoints.down("xs")]: {
      borderRadius: 0,
    },
  },
  stateCard: {
    width: "100%",
    minHeight: 180,
    padding: theme.spacing(3),
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
    [theme.breakpoints.down("xs")]: {
      borderRadius: 0,
      minHeight: 160,
    },
  },
  header: {
    padding: "14px 16px",
    borderBottom: "1px solid #eceff1",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    position: "sticky",
    top: 0,
    backgroundColor: "#fff",
    zIndex: 1,
    [theme.breakpoints.down("xs")]: {
      padding: "12px",
      flexDirection: "column",
      alignItems: "stretch",
      gap: 8,
    },
  },
  title: {
    fontSize: 18,
    fontWeight: 700,
    color: "#1d2226",
    [theme.breakpoints.down("xs")]: {
      fontSize: 17,
    },
  },
  markAllButton: {
    color: "#2e7d32",
    borderColor: "#2e7d32",
    textTransform: "none",
    fontWeight: 600,
    whiteSpace: "nowrap",
    minHeight: 36,
    flexShrink: 0,
    "&:hover": {
      borderColor: "#2e7d32",
      backgroundColor: "rgba(46, 125, 50, 0.08)",
    },
    [theme.breakpoints.down("xs")]: {
      width: "100%",
      minHeight: 40,
      justifyContent: "center",
    },
  },
  list: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
  },
  item: {
    width: "100%",
    border: 0,
    background: "#fff",
    textAlign: "left",
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "14px 16px",
    minHeight: 72,
    cursor: "pointer",
    transition: "background-color 0.2s ease",
    borderBottom: "1px solid #f1f3f4",
    touchAction: "manipulation",
    "&:hover": {
      backgroundColor: "#f4f8f4",
    },
    "&:active": {
      backgroundColor: "#edf6ed",
    },
    [theme.breakpoints.down("xs")]: {
      padding: "14px 12px",
      gap: 10,
      minHeight: 76,
    },
  },
  unreadItem: {
    borderLeft: "4px solid #2e7d32",
    paddingLeft: 12,
    backgroundColor: "#f8fcf8",
    [theme.breakpoints.down("xs")]: {
      paddingLeft: 8,
    },
  },
  readItem: {
    borderLeft: "4px solid transparent",
    paddingLeft: 12,
    [theme.breakpoints.down("xs")]: {
      paddingLeft: 8,
    },
  },
  avatar: {
    width: 44,
    height: 44,
    flexShrink: 0,
    [theme.breakpoints.down("xs")]: {
      width: 42,
      height: 42,
    },
  },
  content: {
    minWidth: 0,
    flex: 1,
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  message: {
    fontSize: 14,
    fontWeight: 500,
    color: "#1d2226",
    lineHeight: 1.35,
  },
  timestamp: {
    fontSize: 12,
    color: "#6b7280",
  },
  emptyState: {
    minHeight: 220,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing(3),
    textAlign: "center",
  },
}));
