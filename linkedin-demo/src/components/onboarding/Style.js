import { makeStyles } from "@material-ui/core/styles";

export default makeStyles((theme) => ({
  container: {
    width: "100%",
    minHeight: "100vh",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing(2),
    boxSizing: "border-box",
  },
  card: {
    width: "100%",
    maxWidth: 520,
    borderRadius: 12,
    border: `1px solid ${theme.palette.divider}`,
    padding: theme.spacing(3),
    boxSizing: "border-box",
    [theme.breakpoints.down("xs")]: {
      borderRadius: 8,
      padding: theme.spacing(2),
    },
  },
  title: {
    fontWeight: 700,
    marginBottom: theme.spacing(0.5),
  },
  subtitle: {
    marginBottom: theme.spacing(2.5),
    color: theme.palette.text.secondary,
  },
  form: {
    display: "grid",
    gap: theme.spacing(1.5),
  },
  helper: {
    minHeight: 20,
    fontSize: "0.8rem",
    marginTop: theme.spacing(0.25),
  },
  helperNeutral: {
    color: theme.palette.text.secondary,
  },
  helperSuccess: {
    color: theme.palette.primary.main,
  },
  helperError: {
    color: theme.palette.error.main,
  },
  actions: {
    marginTop: theme.spacing(1),
    display: "flex",
    justifyContent: "flex-end",
    gap: theme.spacing(1),
  },
  skipButton: {
    minWidth: 120,
    minHeight: 40,
    borderRadius: 20,
    textTransform: "none",
    fontWeight: 600,
    color: theme.palette.text.secondary,
    border: `1px solid ${theme.palette.divider}`,
    "&:hover": {
      backgroundColor: theme.palette.action.hover,
    },
    "&.Mui-disabled": {
      color: "#9e9e9e",
    },
  },
  submitButton: {
    minWidth: 132,
    minHeight: 40,
    borderRadius: 20,
    textTransform: "none",
    fontWeight: 600,
    backgroundColor: theme.palette.primary.main,
    color: "#fff",
    "&:hover": {
      backgroundColor: theme.palette.primary.dark,
    },
    "&.Mui-disabled": {
      backgroundColor: "#9e9e9e",
      color: "#fff",
    },
  },
  submitLabel: {
    display: "inline-flex",
    alignItems: "center",
    gap: theme.spacing(1),
  },
  footerError: {
    marginTop: theme.spacing(1),
    color: theme.palette.error.main,
    fontSize: "0.85rem",
  },
}));
