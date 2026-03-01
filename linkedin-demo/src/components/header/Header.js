import { useSelector, useDispatch } from "react-redux";
import { useAuthActions } from "@convex-dev/auth/react";
import { ChangeTheme } from "../../store/actions/util";
import { Paper, Avatar, Button } from "@material-ui/core";
import SearchIcon from "@material-ui/icons/Search";
import HomeIcon from "@material-ui/icons/Home";
import GroupIcon from "@material-ui/icons/Group";
import WorkIcon from "@material-ui/icons/Work";
import TelegramIcon from "@material-ui/icons/Telegram";
import NotificationsIcon from "@material-ui/icons/Notifications";
import Brightness4Icon from "@material-ui/icons/Brightness4";
import BrightnessHighIcon from "@material-ui/icons/BrightnessHigh";
import AddBoxIcon from "@material-ui/icons/AddBox";
import AppsIcon from "@material-ui/icons/Apps";
import useConvexUser from "../../hooks/useConvexUser";
import MenuItem from "./menuItem/MenuItem";
import Style from "./Style";

const Header = ({ activeTab, setActiveTab, onNavigateProfile }) => {
  const classes = Style();
  const dispatch = useDispatch();
  const mode = useSelector((state) => state.util);
  const authActions = useAuthActions();
  const signOut = authActions?.signOut ?? (() => Promise.resolve());
  const user = useConvexUser();
  const photoURL = user?.photoURL;

  const items = [
    { Icon: <HomeIcon />, title: "Home", arrow: false, onClick: () => setActiveTab("home") },
    { Icon: <GroupIcon />, title: "My Network", arrow: false, onClick: () => setActiveTab("network") },
    { Icon: <WorkIcon />, title: "Jobs", arrow: false, onClick: () => setActiveTab("jobs") },
    { Icon: <TelegramIcon />, title: "Messaging", arrow: false, onClick: () => setActiveTab("messaging") },
    {
      Icon: <NotificationsIcon />,
      title: "Notifications",
      arrow: false,
      onClick: () => setActiveTab("notifications"),
    },
    { Icon: <Avatar src={photoURL} />, title: "Me", arrow: true },
    { Icon: <AppsIcon />, title: "Apps", arrow: true },
  ];

  const tabItems = [
    { key: "home", icon: HomeIcon },
    { key: "network", icon: GroupIcon },
    { key: "post", icon: AddBoxIcon },
    { key: "messaging", icon: TelegramIcon },
    { key: "notifications", icon: NotificationsIcon },
    { key: "jobs", icon: WorkIcon },
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
          <div className={classes.search}>
            <SearchIcon />
            <input placeholder="Search" />
          </div>
          <Avatar
            src={photoURL}
            onClick={onNavigateProfile}
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
          {tabItems.map(({ key, icon: Icon }) => (
            <Icon
              key={key}
              onClick={() => setActiveTab(key)}
              style={{
                color: activeTab === key ? "#0a66c2" : "grey",
              }}
            />
          ))}
        </Paper>
      </div>
    </Paper>
  );
};

export default Header;
