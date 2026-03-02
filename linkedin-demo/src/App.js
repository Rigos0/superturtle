import { useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation } from "convex/react";
import { useSelector } from "react-redux";
import { Grid, Hidden, Typography } from "@material-ui/core";
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
  const seededRef = useRef(false);

  const muiTheme = useMemo(
    () =>
      createMuiTheme({
        palette: {
          type: mode ? "dark" : "light",
        },
      }),
    [mode],
  );

  useEffect(() => {
    if (seededRef.current) {
      return;
    }
    seededRef.current = true;

    seedData({}).catch((error) => {
      console.error("Failed to seed Convex data:", error);
    });
  }, [seedData]);

  const onNavigateProfile = (userId) => {
    setProfileUserId(userId ?? null);
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
    return (
      <ThemeProvider theme={muiTheme}>
        <Grid
          container
          className={`${classes.app} fade-in`}
          style={{
            backgroundColor: mode ? darkPrimary : LinkedInBgColor,
            justifyContent: "center",
            alignItems: "center",
            minHeight: "100vh",
          }}
        >
          <div className="fade-in" style={{ textAlign: "center" }}>
            <img src="/turtle-mascot.png" alt="TurtleIn" style={{ height: 64 }} />
            <Typography
              variant="h6"
              style={{ color: "#2e7d32", fontWeight: 700, marginTop: 8 }}
            >
              TurtleIn
            </Typography>
          </div>
        </Grid>
      </ThemeProvider>
    );
  }

  if (!isAuthenticated) {
    return (
      <ThemeProvider theme={muiTheme}>
        <Grid
          container
          className={`${classes.app} fade-in`}
          style={{ backgroundColor: mode ? darkPrimary : LinkedInBgColor }}
        >
          <Login />
        </Grid>
      </ThemeProvider>
    );
  }

  // Helper: style for show/hide tabs without unmounting (keeps Convex subscriptions alive)
  const showWhen = (condition) => ({
    display: condition ? undefined : "none",
    width: "100%",
  });

  return (
    <ThemeProvider theme={muiTheme}>
      <Grid
        container
        className={`${classes.app} fade-in`}
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
              <Sidebar />
            </Grid>
          </Hidden>
          <Grid item className={classes.body__feed} xs={12} sm={8} md={5}>
            <ErrorBoundary>
              {/* Profile overlay — conditionally rendered (unique per user) */}
              {view === "profile" && (
                <Profile
                  userId={profileUserId}
                  onBack={() => setView("feed")}
                  onNavigateMessaging={onNavigateMessaging}
                />
              )}

              {/* Keep-alive tabs — always mounted, shown/hidden via display.
                  This prevents Convex query re-fetching and skeleton flashes. */}
              <div style={showWhen(view !== "profile" && activeTab === "home")}>
                <Grid item className={classes.feed__form}>
                  <Form />
                </Grid>
                <Grid item className={classes.feed__posts}>
                  <Posts onNavigateProfile={onNavigateProfile} />
                </Grid>
              </div>

              <div style={showWhen(view !== "profile" && activeTab === "network")}>
                <Network onNavigateProfile={onNavigateProfile} />
              </div>

              <div style={showWhen(view !== "profile" && activeTab === "messaging")}>
                <Messaging />
              </div>

              <div style={showWhen(view !== "profile" && activeTab === "notifications")}>
                <Notifications
                  onViewPost={onViewPost}
                  onNavigateProfile={onNavigateProfile}
                  onNavigateMessaging={onNavigateMessaging}
                />
              </div>
            </ErrorBoundary>
          </Grid>
          <Hidden smDown>
            <Grid item className={classes.body__widgets} md={3}>
              <Widgets />
            </Grid>
          </Hidden>
        </Grid>
      </Grid>
    </ThemeProvider>
  );
};

export default App;
