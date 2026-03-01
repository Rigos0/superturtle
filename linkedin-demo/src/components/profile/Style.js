import { makeStyles } from "@material-ui/core/styles";

export default makeStyles((theme) => ({
  profile: {
    width: "100%",
    display: "flex",
    justifyContent: "center",
    padding: theme.spacing(1, 0),
    [theme.breakpoints.down("xs")]: {
      padding: 0,
    },
  },
  card: {
    width: "100%",
    maxWidth: 560,
    paddingBottom: theme.spacing(3),
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    textAlign: "left",
    overflow: "hidden",
    borderRadius: 8,
    [theme.breakpoints.down("xs")]: {
      borderRadius: 0,
      boxShadow: "none",
    },
  },
  coverArea: {
    width: "100%",
    height: 100,
    background: "linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%)",
    position: "relative",
    marginBottom: 52,
    [theme.breakpoints.down("xs")]: {
      height: 80,
      marginBottom: 44,
    },
  },
  avatar: {
    width: 104,
    height: 104,
    border: "4px solid #fff",
    position: "absolute",
    bottom: -52,
    left: 16,
    [theme.breakpoints.down("xs")]: {
      width: 88,
      height: 88,
      bottom: -44,
      left: 12,
    },
  },
  name: {
    fontWeight: 700,
    fontSize: "1.25rem",
    padding: theme.spacing(0, 2),
  },
  title: {
    color: theme.palette.text.secondary,
    padding: theme.spacing(0.5, 2, 0, 2),
    fontSize: "0.875rem",
    lineHeight: 1.5,
  },
  metaRow: {
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(0.5),
    padding: theme.spacing(1, 2, 0, 2),
  },
  metaItem: {
    display: "flex",
    alignItems: "center",
    fontSize: "0.8rem",
  },
  section: {
    width: "100%",
    padding: theme.spacing(0, 2),
  },
  postsList: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(1.5),
    paddingBottom: theme.spacing(1),
  },
}));
