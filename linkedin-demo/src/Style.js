import { makeStyles } from "@material-ui/core/styles";

export default makeStyles((theme) => ({
  app: {},

  app__header: {
    position: "sticky",
    top: 0,
    zIndex: 100,
    height: 50,
    display: "flex",
    justifyContent: "center",
  },

  app__body: {
    display: "flex",
    minHeight: "calc(100vh - 50px)",
    justifyContent: "center",
    paddingTop: 50,
    paddingBottom: 50,
    [theme.breakpoints.down("xs")]: {
      paddingTop: 10,
      paddingBottom: 60,
    },
  },

  body__sidebar: {
    minWidth: 150,
    maxWidth: 220,
    height: "auto",
  },

  body__feed: {
    minWidth: 500,
    maxWidth: 600,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "0 25px",
    paddingBottom: 25,
    [theme.breakpoints.down("sm")]: {
      minWidth: 0,
      maxWidth: "100%",
    },
    [theme.breakpoints.down("xs")]: {
      padding: "0 8px",
    },
  },

  feed__form: {
    width: "100%",
    height: "auto",
  },

  feed__posts: {
    width: "100%",
    height: "auto",
  },

  body__widgets: {
    minWidth: 225,
    maxWidth: 300,
  },
}));
