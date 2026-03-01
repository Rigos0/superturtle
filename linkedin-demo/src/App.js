import { useEffect, useState } from "react";
import { useSelector, useDispatch } from "react-redux";
import { Grid, Hidden, Paper, Typography } from "@material-ui/core";
import { ThemeProvider, createMuiTheme } from "@material-ui/core";
import Header from "./components/header/Header";
import Form from "./components/form/Form";
import Posts from "./components/posts/Posts";
import Sidebar from "./components/sidebar/Sidebar";
import Widgets from "./components/widgets/Widgets";
import { LoginAction } from "./store/actions/auth";
import { mockUser } from "./mock/user";
import Styles from "./Style";
import { LinkedInBgColor, darkPrimary } from "./assets/Colors";

const App = () => {
  const classes = Styles();
  const dispatch = useDispatch();
  const mode = useSelector((state) => state.util);
  const [activeTab, setActiveTab] = useState("home");

  const muiTheme = createMuiTheme({
    palette: {
      type: mode ? "dark" : "light",
    },
  });

  useEffect(() => {
    dispatch(LoginAction(mockUser));
  }, [dispatch]);

  const activeTabLabel = {
    home: "Home",
    network: "My Network",
    post: "Post",
    notifications: "Notifications",
    jobs: "Jobs",
  }[activeTab] || "This section";

  return (
    <ThemeProvider theme={muiTheme}>
      <Grid
        container
        className={classes.app}
        style={{ backgroundColor: mode ? darkPrimary : LinkedInBgColor }}
      >
        <Grid
          item
          container
          className={classes.app__header}
          style={{
            boxShadow: mode && "0px 5px 10px -10px rgba(0,0,0,0.75)",
          }}
        >
          {/* Header */}
          <Header activeTab={activeTab} setActiveTab={setActiveTab} />
        </Grid>
        <Grid item container className={classes.app__body}>
          <Hidden smDown>
            <Grid item className={classes.body__sidebar} md={2}>
              {/* Sidebar */}
              <Sidebar />
            </Grid>
          </Hidden>
          <Grid item className={classes.body__feed} xs={12} sm={8} md={5}>
            {activeTab === "home" ? (
              <>
                {/* Feed */}
                <Grid item className={classes.feed__form}>
                  <Form />
                </Grid>
                <Grid item className={classes.feed__posts}>
                  <Posts />
                </Grid>
              </>
            ) : (
              <Paper elevation={1} style={{ width: "100%", padding: 24 }}>
                <Typography variant="h6">{activeTabLabel}</Typography>
                <Typography color="textSecondary">Coming soon.</Typography>
              </Paper>
            )}
          </Grid>
          <Hidden smDown>
            <Grid item className={classes.body__widgets} md={3}>
              {/* Widgets */}
              <Widgets />
            </Grid>
          </Hidden>
        </Grid>
      </Grid>
    </ThemeProvider>
  );
};

export default App;
