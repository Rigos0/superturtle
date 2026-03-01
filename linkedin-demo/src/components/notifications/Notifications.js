import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { Avatar, Button, CircularProgress, Paper, Typography } from "@material-ui/core";
import { useTheme } from "@material-ui/core/styles";
import useMediaQuery from "@material-ui/core/useMediaQuery";
import ReactTimeago from "react-timeago";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";
import Style from "./Style";

const DEFAULT_PHOTO = "https://i.pravatar.cc/200?img=68";

const resolvePhoto = (photoURL) => {
  if (!photoURL || (typeof photoURL === "string" && photoURL.startsWith("/"))) {
    return DEFAULT_PHOTO;
  }

  return photoURL;
};

const getNotificationMessage = (notification) => {
  const displayName = notification.fromUser?.displayName ?? "Someone";

  if (notification.type === "like") {
    return `${displayName} liked your post`;
  }

  if (notification.type === "comment") {
    return `${displayName} commented on your post`;
  }

  if (notification.type === "message") {
    return `${displayName} sent you a message`;
  }

  return `${displayName} sent you a notification`;
};

const Notifications = () => {
  const classes = Style();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("xs"));
  const user = useConvexUser();
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);

  const notifications = useQuery(
    api.notifications.listNotifications,
    user?._id ? { userId: user._id } : "skip"
  );

  const unreadCount = useMemo(() => {
    if (!notifications) {
      return 0;
    }

    return notifications.filter((notification) => !notification.read).length;
  }, [notifications]);

  const handleItemClick = async (notification) => {
    if (!notification || notification.read) {
      return;
    }

    try {
      await markAsRead({ notificationId: notification._id });
    } catch (error) {
      console.error("Failed to mark notification as read:", error);
    }
  };

  const handleMarkAllAsRead = async () => {
    if (!user?._id || unreadCount === 0) {
      return;
    }

    try {
      await markAllAsRead({ userId: user._id });
    } catch (error) {
      console.error("Failed to mark all notifications as read:", error);
    }
  };

  if (!user?._id) {
    return (
      <Paper className={classes.stateCard} elevation={1}>
        <Typography variant="body2" color="textSecondary">
          Sign in to view notifications.
        </Typography>
      </Paper>
    );
  }

  if (notifications === undefined) {
    return (
      <Paper className={classes.stateCard} elevation={1}>
        <CircularProgress size={26} style={{ color: "#2e7d32" }} />
      </Paper>
    );
  }

  return (
    <Paper className={classes.root} elevation={1}>
      <div className={classes.header}>
        <Typography variant="h6" className={classes.title}>
          Notifications
        </Typography>
        <Button
          variant="outlined"
          size={isMobile ? "medium" : "small"}
          fullWidth={isMobile}
          onClick={handleMarkAllAsRead}
          disabled={unreadCount === 0}
          className={classes.markAllButton}
        >
          Mark all as read
        </Button>
      </div>

      {notifications.length === 0 ? (
        <div className={classes.emptyState}>
          <Typography variant="body2" color="textSecondary">
            No notifications yet.
          </Typography>
        </div>
      ) : (
        <div className={classes.list}>
          {notifications.map((notification) => (
            <button
              type="button"
              key={notification._id}
              className={`${classes.item} ${
                notification.read ? classes.readItem : classes.unreadItem
              }`}
              onClick={() => handleItemClick(notification)}
            >
              <Avatar
                src={resolvePhoto(notification.fromUser?.photoURL)}
                alt={notification.fromUser?.displayName ?? "User"}
                className={classes.avatar}
              />
              <div className={classes.content}>
                <Typography className={classes.message}>{getNotificationMessage(notification)}</Typography>
                <Typography className={classes.timestamp}>
                  <ReactTimeago date={new Date(notification.createdAt).toUTCString()} units="minute" />
                </Typography>
              </div>
            </button>
          ))}
        </div>
      )}
    </Paper>
  );
};

export default Notifications;
