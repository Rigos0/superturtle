import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import { Avatar, Button, Paper, Typography } from "@material-ui/core";
import { useTheme } from "@material-ui/core/styles";
import useMediaQuery from "@material-ui/core/useMediaQuery";
import ReactTimeago from "react-timeago";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";
import useErrorToast from "../../hooks/useErrorToast";
import { resolvePhoto } from "../../utils/photo";
import LoadingGate from "../LoadingGate";
import Style from "./Style";

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

const Notifications = ({ onViewPost, onNavigateProfile, onNavigateMessaging }) => {
  const classes = Style();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("xs"));
  const user = useConvexUser();
  const markAsRead = useMutation(api.notifications.markAsRead);
  const markAllAsRead = useMutation(api.notifications.markAllAsRead);
  const { showError, ErrorToast } = useErrorToast();

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
    if (!notification) {
      return;
    }

    if (!notification.read) {
      try {
        await markAsRead({ notificationId: notification._id });
      } catch (error) {
        console.error("Failed to mark notification as read:", error);
        showError("Failed to mark notification as read. Please try again.");
      }
    }

    if ((notification.type === "like" || notification.type === "comment") && notification.postId) {
      if (typeof onViewPost === "function") {
        onViewPost(notification.postId);
      }
      return;
    }

    if (notification.type === "message") {
      if (typeof onNavigateMessaging === "function") {
        onNavigateMessaging();
      }
      return;
    }

    if (
      typeof onNavigateProfile === "function" &&
      (notification.fromUser?._id || notification.fromUser?.username)
    ) {
      onNavigateProfile({
        username: notification.fromUser?.username ?? null,
        userId: notification.fromUser?._id ?? null,
      });
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
      showError("Failed to update notifications. Please try again.");
    }
  };

  if (!user?._id) {
    return (
      <>
        <Paper className={classes.stateCard} elevation={1}>
          <Typography variant="body2" color="textSecondary">
            Sign in to view notifications.
          </Typography>
        </Paper>
        <ErrorToast />
      </>
    );
  }

  return (
    <>
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

        <LoadingGate isLoading={notifications === undefined}>
          {notifications?.length === 0 ? (
            <div className={classes.emptyState}>
              <Typography variant="body2" color="textSecondary">
                No notifications yet.
              </Typography>
            </div>
          ) : (
            <div className={classes.list}>
              {notifications?.map((notification) => (
                <Button
                  type="button"
                  key={notification._id}
                  className={`${classes.item} ${
                    notification.read ? classes.readItem : classes.unreadItem
                  }`}
                  onClick={() => handleItemClick(notification)}
                  disableRipple
                >
                  <Avatar
                    src={resolvePhoto(notification.fromUser?.photoURL)}
                    alt={notification.fromUser?.displayName ?? "User"}
                    className={classes.avatar}
                  />
                  <div className={classes.content}>
                    <Typography className={classes.message}>{getNotificationMessage(notification)}</Typography>
                    <Typography className={classes.timestamp}>
                      <ReactTimeago
                        date={new Date(notification.createdAt).toUTCString()}
                        units="minute"
                      />
                    </Typography>
                  </div>
                </Button>
              ))}
            </div>
          )}
        </LoadingGate>
      </Paper>
      <ErrorToast />
    </>
  );
};

export default Notifications;
