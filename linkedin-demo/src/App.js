import { useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useSelector } from "react-redux";
import { Grid, Hidden, Modal, Typography } from "@material-ui/core";
import { ThemeProvider, createMuiTheme } from "@material-ui/core";
import { BrowserRouter, useMatch, useNavigate } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
import Header from "./components/header/Header";
import Form from "./components/form/Form";
import LoginCard from "./components/login/loginCard/LoginCard";
import Messaging from "./components/messaging/Messaging";
import Network from "./components/network/Network";
import Notifications from "./components/notifications/Notifications";
import Onboarding from "./components/onboarding/Onboarding";
import Posts from "./components/posts/Posts";
import HashtagFeed from "./components/hashtag/HashtagFeed";
import Profile from "./components/profile/Profile";
import Sidebar from "./components/sidebar/Sidebar";
import Widgets from "./components/widgets/Widgets";
import { api } from "./convex/_generated/api";
import Styles from "./Style";
import { LinkedInBgColor, darkPrimary } from "./assets/Colors";

const normalizeHashtag = (value) =>
  value
    .trim()
    .replace(/^#+/, "")
    .toLowerCase();

const decodeRouteParam = (value = "") => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const AppShell = () => {
  const classes = Styles();
  const mode = useSelector((state) => state.util);
  const [activeTab, setActiveTab] = useState("home");
  const [view, setView] = useState("feed");
  const [profileUserId, setProfileUserId] = useState(null);
  const [showLogin, setShowLogin] = useState(false);
  const navigate = useNavigate();
  const hashtagRouteMatch = useMatch("/hashtag/:tag");
  const usernameRouteMatch = useMatch("/:username");
  const profileIdRouteMatch = useMatch("/profile/:userId");
  const routeHashtagParam = hashtagRouteMatch?.params?.tag ?? null;
  const routeHashtag = routeHashtagParam
    ? normalizeHashtag(decodeRouteParam(routeHashtagParam))
    : null;
  const routeUsername = usernameRouteMatch?.params?.username?.trim().toLowerCase() ?? null;
  const routeUserId = profileIdRouteMatch?.params?.userId ?? null;
  const isProfileRouteActive = Boolean(routeUsername || routeUserId);
  const isHashtagRouteActive = Boolean(routeHashtag);
  const { isAuthenticated, isLoading } = useConvexAuth();
  const seedData = useMutation(api.seed.seedData);
  const currentUser = useQuery(api.users.getCurrentUser, isAuthenticated ? {} : "skip");
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

  useEffect(() => {
    if (isAuthenticated) {
      setShowLogin(false);
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (routeUsername || routeUserId) {
      setProfileUserId(routeUserId ?? null);
      setView("profile");
    }
  }, [routeUsername, routeUserId]);

  const resolveProfileTarget = (target) => {
    if (!target) {
      return { userId: null, username: null };
    }

    if (typeof target === "string") {
      return { userId: target, username: null };
    }

    if (typeof target === "object") {
      const rawUsername =
        typeof target.username === "string" ? target.username.trim().toLowerCase() : "";

      return {
        userId: target.userId ?? null,
        username: rawUsername.length > 0 ? rawUsername : null,
      };
    }

    return { userId: null, username: null };
  };

  const onNavigateProfile = (target) => {
    const profileTarget = resolveProfileTarget(target);
    setProfileUserId(profileTarget.userId);
    setView("profile");

    if (profileTarget.username) {
      navigate(`/${encodeURIComponent(profileTarget.username)}`);
      return;
    }

    if (profileTarget.userId) {
      navigate(`/profile/${encodeURIComponent(profileTarget.userId)}`);
    }
  };

  const handleSetActiveTab = (tab) => {
    if (isProfileRouteActive || isHashtagRouteActive) {
      navigate("/");
    }
    setActiveTab(tab);
    setView("feed");
  };

  const onNavigateHome = () => {
    if (isProfileRouteActive || isHashtagRouteActive) {
      navigate("/");
    }
    setActiveTab("home");
    setView("feed");
  };

  const onNavigateMessaging = () => {
    if (isProfileRouteActive || isHashtagRouteActive) {
      navigate("/");
    }
    setActiveTab("messaging");
    setView("feed");
  };

  const onViewPost = (postId) => {
    if (!postId) {
      return;
    }

    if (isProfileRouteActive || isHashtagRouteActive) {
      navigate("/");
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

  const handleOpenLogin = () => {
    if (!isAuthenticated) {
      setShowLogin(true);
    }
  };

  const handleCloseLogin = () => {
    setShowLogin(false);
  };

  const isCurrentUserLoading = isAuthenticated && currentUser === undefined;
  const shouldShowOnboarding = Boolean(isAuthenticated && currentUser && !currentUser.username);

  if (isLoading || isCurrentUserLoading) {
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

  if (shouldShowOnboarding) {
    return (
      <ThemeProvider theme={muiTheme}>
        <Grid
          container
          className={`${classes.app} fade-in`}
          style={{ backgroundColor: mode ? darkPrimary : LinkedInBgColor }}
        >
          <Onboarding currentUser={currentUser} />
        </Grid>
      </ThemeProvider>
    );
  }

  // Helper: style for show/hide tabs without unmounting (keeps Convex subscriptions alive)
  const showWhen = (condition) => ({
    display: condition ? undefined : "none",
    width: "100%",
  });
  const shouldShowHashtagView = isHashtagRouteActive;
  const shouldShowProfileView =
    !shouldShowHashtagView && (isProfileRouteActive || view === "profile");
  const routedProfileUserId = routeUserId || null;
  const routedProfileUsername = routeUsername || null;

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
            onSignInClick={handleOpenLogin}
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
              {shouldShowProfileView && (
                <Profile
                  userId={routedProfileUserId ?? profileUserId}
                  username={routedProfileUsername}
                  onBack={() => {
                    if (isProfileRouteActive) {
                      navigate("/");
                      setActiveTab("home");
                    }
                    setView("feed");
                  }}
                  onNavigateMessaging={onNavigateMessaging}
                  onViewProfile={onNavigateProfile}
                />
              )}
              {shouldShowHashtagView && (
                <HashtagFeed
                  tag={routeHashtag}
                  onNavigateProfile={onNavigateProfile}
                />
              )}

              {/* Keep-alive tabs — always mounted, shown/hidden via display.
                  This prevents Convex query re-fetching and skeleton flashes. */}
              <div
                style={showWhen(
                  !shouldShowProfileView && !shouldShowHashtagView && activeTab === "home",
                )}
              >
                <Grid item className={classes.feed__form}>
                  <Form />
                </Grid>
                <Grid item className={classes.feed__posts}>
                  <Posts onNavigateProfile={onNavigateProfile} />
                </Grid>
              </div>

              <div
                style={showWhen(
                  !shouldShowProfileView && !shouldShowHashtagView && activeTab === "network",
                )}
              >
                <Network onNavigateProfile={onNavigateProfile} />
              </div>

              <div
                style={showWhen(
                  !shouldShowProfileView && !shouldShowHashtagView && activeTab === "messaging",
                )}
              >
                <Messaging />
              </div>

              <div
                style={showWhen(
                  !shouldShowProfileView &&
                  !shouldShowHashtagView &&
                  activeTab === "notifications",
                )}
              >
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
        <Modal open={showLogin && !isAuthenticated} onClose={handleCloseLogin}>
          <div
            style={{
              minHeight: "100vh",
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              padding: 16,
              outline: "none",
            }}
          >
            <LoginCard onClose={handleCloseLogin} />
          </div>
        </Modal>
      </Grid>
    </ThemeProvider>
  );
};

const App = () => (
  <BrowserRouter>
    <AppShell />
  </BrowserRouter>
);

export default App;
