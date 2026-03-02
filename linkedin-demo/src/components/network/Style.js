import { fade, makeStyles } from "@material-ui/core/styles";

export default makeStyles((theme) => ({
  network: {
    width: "100%",
  },
  controls: {
    width: "100%",
    marginBottom: theme.spacing(1.5),
  },
  pendingSection: {
    width: "100%",
    boxSizing: "border-box",
    padding: theme.spacing(1.5, 2),
    marginBottom: theme.spacing(1.5),
  },
  pendingSectionTitle: {
    fontWeight: 700,
    fontSize: "0.95rem",
    marginBottom: theme.spacing(1),
  },
  pendingRequestsList: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(1),
  },
  pendingRequestCard: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1.5),
    padding: theme.spacing(1),
    borderRadius: 8,
    cursor: "pointer",
    outline: "none",
    border: `1px solid ${theme.palette.divider}`,
    backgroundColor: theme.palette.background.default,
    "&:focus-visible": {
      boxShadow: `0px 0px 0px 3px ${fade(theme.palette.primary.main, 0.25)}`,
    },
  },
  searchField: {
    width: "100%",
    "& .MuiOutlinedInput-root": {
      backgroundColor: theme.palette.background.paper,
    },
  },
  stateCard: {
    width: "100%",
    padding: theme.spacing(3),
    marginTop: theme.spacing(1.5),
  },
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(1),
  },
  card: {
    width: "100%",
    boxSizing: "border-box",
    backgroundColor: theme.palette.background.paper,
    padding: theme.spacing(1.5, 2),
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1.5),
    borderRadius: 8,
    cursor: "pointer",
    outline: "none",
    transition: "box-shadow 150ms ease, transform 150ms ease",
    "&:hover": {
      boxShadow: `0px 4px 14px ${fade(theme.palette.primary.main, 0.18)}`,
      transform: "translateY(-1px)",
    },
    "&:focus-visible": {
      boxShadow: `0px 0px 0px 3px ${fade(theme.palette.primary.main, 0.25)}`,
    },
  },
  avatar: {
    width: 52,
    height: 52,
    flexShrink: 0,
  },
  info: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    flexGrow: 1,
  },
  displayName: {
    fontWeight: 700,
    fontSize: "0.95rem",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  title: {
    color: theme.palette.text.secondary,
    fontSize: "0.8rem",
    lineHeight: 1.45,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  location: {
    color: theme.palette.text.secondary,
    fontSize: "0.75rem",
    marginTop: theme.spacing(0.25),
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  connectionCount: {
    color: theme.palette.text.secondary,
    fontSize: "0.75rem",
    marginTop: theme.spacing(0.25),
  },
  mutualConnectionCount: {
    color: theme.palette.primary.main,
    fontSize: "0.75rem",
    marginTop: theme.spacing(0.25),
  },
  actionRow: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(0.75),
    marginLeft: theme.spacing(1),
  },
  connectButton: {
    borderColor: theme.palette.primary.main,
    color: theme.palette.primary.main,
    borderRadius: 16,
    textTransform: "none",
    fontWeight: 600,
    minWidth: 92,
    "&:hover": {
      borderColor: theme.palette.primary.main,
      backgroundColor: fade(theme.palette.primary.main, 0.08),
    },
  },
  connectButtonPending: {
    opacity: 0.6,
  },
  acceptButton: {
    backgroundColor: theme.palette.primary.main,
    color: "#fff",
    borderRadius: 16,
    textTransform: "none",
    fontWeight: 600,
    minWidth: 82,
    "&:hover": {
      backgroundColor: theme.palette.primary.dark,
    },
  },
  rejectButton: {
    borderRadius: 16,
    textTransform: "none",
    fontWeight: 600,
    minWidth: 82,
    borderColor: "#9e9e9e",
    color: "#757575",
  },
  followButton: {
    borderRadius: 16,
    textTransform: "none",
    fontWeight: 600,
    minWidth: 92,
    borderColor: theme.palette.primary.main,
    color: theme.palette.primary.main,
    "&:hover": {
      borderColor: theme.palette.primary.main,
      backgroundColor: fade(theme.palette.primary.main, 0.08),
    },
  },
  followButtonFollowing: {
    backgroundColor: theme.palette.primary.main,
    color: "#fff",
    "&:hover": {
      backgroundColor: theme.palette.primary.dark,
    },
  },
}));
