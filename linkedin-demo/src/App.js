import { useEffect, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useSelector } from "react-redux";
import { Grid, Hidden, Paper, Typography } from "@material-ui/core";
import { ThemeProvider, createMuiTheme } from "@material-ui/core";
import ErrorBoundary from "./components/ErrorBoundary";
import Header from "./components/header/Header";
import Form from "./components/form/Form";
import Login from "./components/login/Login";
import Messaging from "./components/messaging/Messaging";
import Network from "./components/network/Network";
import Notifications from "./components/notifications/Notifications";
import Posts from "./components/posts/Posts";
import Profile from "./components/profile/Profile";
import Sidebar from "./components/sidebar/Sidebar";
import Widgets from "./components/widgets/Widgets";
import { api } from "./convex/_generated/api";
import Styles from "./Style";
import { LinkedInBgColor, darkPrimary } from "./assets/Colors";

const App = () => {
  const classes = Styles();
  const mode = useSelector((state) => state.util);
  const [activeTab, setActiveTab] = useState("home");
  const [view, setView] = useState("feed");
  const [profileUserId, setProfileUserId] = useState(null);
  const { isAuthenticated, isLoading } = useConvexAuth();
  const seedData = useMutation(api.seed.seedData);

  const muiTheme = createMuiTheme({
    palette: {
      type: mode ? "dark" : "light",
    },
  });

  useEffect(() => {
    const runSeed = async () => {
      try {
        await seedData({});
      } catch (error) {
        console.error("Failed to seed Convex data:", error);
      }
    };

    runSeed();
  }, [seedData]);

  const activeTabLabel = {
    home: "Home",
    network: "My Network",
    post: "Post",
    messaging: "Messaging",
    notifications: "Notifications",
    jobs: "Jobs",
  }[activeTab] || "This section";

  const onNavigateProfile = (userId) => {
    setProfileUserId(userId ?? null);
    setView("profile");
  };

  const onViewProfile = (userId) => {
    setProfileUserId(userId);
    setView("profile");
  };

  const handleSetActiveTab = (tab) => {
    setActiveTab(tab);
    setView("feed");
  };

  const onNavigateHome = () => {
    setActiveTab("home");
    setView("feed");
  };

  const onNavigateMessaging = () => {
    setActiveTab("messaging");
    setView("feed");
  };

  const onViewPost = (postId) => {
    if (!postId) {
      return;
    }

    setActiveTab("home");
    setView("feed");

    window.setTimeout(() => {
      const postElement = document.getElementById(`post-${postId}`);
      if (postElement) {
        postElement.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 200);
  };

  if (isLoading) {
    return null;
  }

  if (!isAuthenticated) {
    return (
      <ThemeProvider theme={muiTheme}>
        <Grid
          container
          className={classes.app}
          style={{ backgroundColor: mode ? darkPrimary : LinkedInBgColor }}
        >
          <Login />
        </Grid>
      </ThemeProvider>
    );
  }

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
          <Header
            activeTab={activeTab}
            setActiveTab={handleSetActiveTab}
            onNavigateProfile={onNavigateProfile}
            onNavigateHome={onNavigateHome}
          />
        </Grid>
        <Grid item container className={classes.app__body}>
          <Hidden smDown>
            <Grid item className={classes.body__sidebar} md={2}>
              {/* Sidebar */}
              <Sidebar />
            </Grid>
          </Hidden>
          <Grid item className={classes.body__feed} xs={12} sm={8} md={5}>
            <ErrorBoundary>
              {view === "profile" ? (
                <Profile
                  userId={profileUserId}
                  onBack={() => setView("feed")}
                  onNavigateMessaging={onNavigateMessaging}
                />
              ) : activeTab === "messaging" ? (
                <Messaging />
              ) : activeTab === "network" ? (
                <Network onViewProfile={onViewProfile} />
              ) : activeTab === "notifications" ? (
                <Notifications
                  onViewPost={onViewPost}
                  onViewProfile={onViewProfile}
                  onNavigateMessaging={onNavigateMessaging}
                />
              ) : activeTab === "home" ? (
                <>
                  {/* Feed */}
                  <Grid item className={classes.feed__form}>
                    <Form />
                  </Grid>
                  <Grid item className={classes.feed__posts}>
                    <Posts
                      onNavigateProfile={onNavigateProfile}
                      onViewProfile={onViewProfile}
                    />
                  </Grid>
                </>
              ) : (
                <Paper elevation={1} style={{ width: "100%", padding: 24 }}>
                  <Typography variant="h6">{activeTabLabel}</Typography>
                  <Typography color="textSecondary">Coming soon.</Typography>
                </Paper>
              )}
            </ErrorBoundary>
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
