import { useEffect, useState } from "react";
import { useSelector, useDispatch } from "react-redux";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { ChangeTheme } from "../../store/actions/util";
import {
  Paper,
  Avatar,
  Badge,
  Button,
  ClickAwayListener,
  Typography,
} from "@material-ui/core";
import SearchIcon from "@material-ui/icons/Search";
import HomeIcon from "@material-ui/icons/Home";
import GroupIcon from "@material-ui/icons/Group";
import TelegramIcon from "@material-ui/icons/Telegram";
import NotificationsIcon from "@material-ui/icons/Notifications";
import Brightness4Icon from "@material-ui/icons/Brightness4";
import BrightnessHighIcon from "@material-ui/icons/BrightnessHigh";
import PersonIcon from "@material-ui/icons/Person";
import AppsIcon from "@material-ui/icons/Apps";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";
import MenuItem from "./menuItem/MenuItem";
import Style from "./Style";

const Header = ({ activeTab, setActiveTab, onNavigateProfile, onNavigateHome }) => {
  const classes = Style();
  const dispatch = useDispatch();
  const mode = useSelector((state) => state.util);
  const authActions = useAuthActions();
  const signOut = authActions?.signOut ?? (() => Promise.resolve());
  const user = useConvexUser();
  const photoURL = user?.photoURL;
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedTerm, setDebouncedTerm] = useState("");
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const unreadCount = useQuery(
    api.notifications.getUnreadCount,
    user?._id ? { userId: user._id } : "skip"
  );
  const users = useQuery(
    api.users.searchUsers,
    debouncedTerm ? { query: debouncedTerm } : "skip"
  );
  const posts = useQuery(
    api.posts.searchPosts,
    debouncedTerm ? { query: debouncedTerm } : "skip"
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedTerm(searchTerm.trim());
    }, 300);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [searchTerm]);

  const userResults = users ?? [];
  const postResults = posts ?? [];
  const showSearchResults = isSearchOpen && searchTerm.trim().length > 0;
  const isSearchLoading =
    Boolean(debouncedTerm) && (users === undefined || posts === undefined);

  const getDescriptionSnippet = (description = "") => {
    if (description.length <= 60) {
      return description;
    }

    return `${description.slice(0, 60)}...`;
  };

  const closeSearch = () => {
    setIsSearchOpen(false);
  };

  const clearSearch = () => {
    setSearchTerm("");
    setDebouncedTerm("");
    closeSearch();
  };

  const handleSearchChange = (event) => {
    const nextTerm = event.target.value;
    setSearchTerm(nextTerm);
    setIsSearchOpen(nextTerm.trim().length > 0);
  };

  const handleSearchFocus = () => {
    if (searchTerm.trim().length > 0) {
      setIsSearchOpen(true);
    }
  };

  const handleResultKeyDown = (event, onActivate) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate();
    }
  };

  const handleUserResultClick = (userId) => {
    onNavigateProfile(userId);
    clearSearch();
  };

  const handlePostResultClick = (postId) => {
    if (typeof onNavigateHome === "function") {
      onNavigateHome();
    } else {
      setActiveTab("home");
    }
    clearSearch();

    window.setTimeout(() => {
      const postElement = document.getElementById(`post-${postId}`);
      if (postElement) {
        postElement.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
  };

  const items = [
    { Icon: <HomeIcon />, title: "Home", arrow: false, onClick: () => setActiveTab("home") },
    { Icon: <GroupIcon />, title: "My Network", arrow: false, onClick: () => setActiveTab("network") },
    { Icon: <TelegramIcon />, title: "Messaging", arrow: false, onClick: () => setActiveTab("messaging") },
    {
      Icon: (
        <Badge
          color="primary"
          badgeContent={unreadCount ?? 0}
          invisible={!unreadCount}
          anchorOrigin={{ vertical: "top", horizontal: "right" }}
        >
          <NotificationsIcon />
        </Badge>
      ),
      title: "Notifications",
      arrow: false,
      onClick: () => setActiveTab("notifications"),
    },
    { Icon: <Avatar src={photoURL} />, title: "Me", arrow: true, onClick: () => onNavigateProfile(user?._id ?? null) },
    { Icon: <AppsIcon />, title: "Apps", arrow: true },
  ];

  const navigateToHome = () => {
    if (typeof onNavigateHome === "function") {
      onNavigateHome();
      return;
    }
    setActiveTab("home");
  };

  const tabItems = [
    { key: "home", icon: HomeIcon, onClick: navigateToHome, isActive: activeTab === "home" },
    {
      key: "network",
      icon: GroupIcon,
      onClick: () => setActiveTab("network"),
      isActive: activeTab === "network",
    },
    {
      key: "messaging",
      icon: TelegramIcon,
      onClick: () => setActiveTab("messaging"),
      isActive: activeTab === "messaging",
    },
    {
      key: "notifications",
      icon: NotificationsIcon,
      onClick: () => setActiveTab("notifications"),
      isActive: activeTab === "notifications",
    },
    {
      key: "profile",
      icon: PersonIcon,
      onClick: () => onNavigateProfile(user?._id ?? null),
      isActive: false,
    },
  ];

  return (
    <Paper elevation={0} className={classes.header}>
      <div className={classes.header__container}>
        <div className={classes.header__logo}>
          <span
            style={{
              color: "#2e7d32",
              fontSize: 24,
              lineHeight: 1,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            Turtle In
          </span>
          <ClickAwayListener onClickAway={closeSearch}>
            <div className={classes.search__wrapper}>
              <div className={classes.search}>
                <SearchIcon />
                <input
                  placeholder="Search"
                  value={searchTerm}
                  onChange={handleSearchChange}
                  onFocus={handleSearchFocus}
                />
              </div>
              {showSearchResults && (
                <Paper className={classes.searchDropdown} elevation={3}>
                  {isSearchLoading ? (
                    <Typography className={classes.searchEmptyState}>Searching...</Typography>
                  ) : (
                    <>
                      <Typography className={classes.searchSectionHeader}>Users</Typography>
                      {userResults.length > 0 ? (
                        userResults.map((resultUser) => (
                          <div
                            key={resultUser._id}
                            className={classes.searchResultItem}
                            onClick={() => handleUserResultClick(resultUser._id)}
                            onKeyDown={(event) =>
                              handleResultKeyDown(event, () =>
                                handleUserResultClick(resultUser._id)
                              )
                            }
                            role="button"
                            tabIndex={0}
                          >
                            <Avatar
                              src={resultUser.photoURL}
                              alt={resultUser.displayName}
                              className={classes.searchResultAvatar}
                            />
                            <div className={classes.searchResultContent}>
                              <Typography className={classes.searchResultPrimary}>
                                {resultUser.displayName}
                              </Typography>
                              <Typography className={classes.searchResultSecondary}>
                                {resultUser.title}
                              </Typography>
                            </div>
                          </div>
                        ))
                      ) : (
                        <Typography className={classes.searchEmptyState}>
                          No users found.
                        </Typography>
                      )}

                      <Typography className={classes.searchSectionHeader}>Posts</Typography>
                      {postResults.length > 0 ? (
                        postResults.map((post) => (
                          <div
                            key={post._id}
                            className={classes.searchResultItem}
                            onClick={() => handlePostResultClick(post._id)}
                            onKeyDown={(event) =>
                              handleResultKeyDown(event, () =>
                                handlePostResultClick(post._id)
                              )
                            }
                            role="button"
                            tabIndex={0}
                          >
                            <div className={classes.searchResultContent}>
                              <Typography className={classes.searchResultPrimary}>
                                {post.author?.displayName ?? "Unknown user"}
                              </Typography>
                              <Typography className={classes.searchResultSecondary}>
                                {getDescriptionSnippet(post.description)}
                              </Typography>
                            </div>
                          </div>
                        ))
                      ) : (
                        <Typography className={classes.searchEmptyState}>
                          No posts found.
                        </Typography>
                      )}
                    </>
                  )}
                </Paper>
              )}
            </div>
          </ClickAwayListener>
          <Avatar
            src={photoURL}
            onClick={() => onNavigateProfile(user?._id ?? null)}
            style={{ cursor: "pointer" }}
          />
        </div>
        <div className={classes.header__nav}>
          {items.map(({ Icon, title, arrow, onClick }, i) => (
            <MenuItem key={i} Icon={Icon} title={title} arrow={arrow} onClick={onClick} />
          ))}
          <MenuItem
            key={"mode"}
            Icon={mode ? <Brightness4Icon /> : <BrightnessHighIcon />}
            title={"Theme"}
            onClick={() => dispatch(ChangeTheme())}
          />
        </div>
        <Button className={classes.signOutButton} onClick={() => signOut()} variant="outlined">
          Sign Out
        </Button>
        <Paper className={classes.header__bottom__nav}>
          {tabItems.map(({ key, icon: Icon, onClick, isActive }) => (
            <Icon
              key={key}
              onClick={onClick}
              aria-label={key}
              className={`${classes.bottomNavIcon} ${
                isActive ? classes.bottomNavIconActive : ""
              }`}
            />
          ))}
        </Paper>
      </div>
    </Paper>
  );
};

export default Header;
