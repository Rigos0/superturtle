import React, { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Avatar,
  Button,
  Paper,
  Typography,
  Divider,
  Tabs,
  Tab,
} from "@material-ui/core";
import ArrowBackIcon from "@material-ui/icons/ArrowBack";
import LocationOnIcon from "@material-ui/icons/LocationOn";
import { api } from "../../convex/_generated/api";
import { DEFAULT_PHOTO } from "../../constants";
import useConvexUser from "../../hooks/useConvexUser";
import LoadingGate from "../LoadingGate";
import Post from "../posts/post/Post";
import Style from "./Style";

const DEFAULT_PROFILE = {
  displayName: "Alex Turner",
  photoURL: DEFAULT_PHOTO,
  title: "TurtleIn builder",
  location: "San Francisco, CA",
  about:
    "Passionate developer with a love for clean code and great UX. Previously built products at startups and scale-ups.",
  experience: [
    "Senior Developer - TechStartup",
    "Product Engineer - ScaleUp Inc",
    "CS Graduate - State University",
  ],
};

const resolveProfilePhoto = (photoURL) => {
  if (typeof photoURL !== "string" || photoURL.length === 0) {
    return DEFAULT_PHOTO;
  }

  if (photoURL.startsWith("/")) {
    return DEFAULT_PHOTO;
  }

  return photoURL;
};

const Profile = ({
  onBack,
  onNavigateMessaging = () => {},
  onViewProfile = () => {},
  userId = null,
}) => {
  const classes = Style();
  const authUser = useConvexUser();
  const getOrCreateConversation = useMutation(api.messaging.getOrCreateConversation);
  const sendConnectionRequest = useMutation(api.connections.sendConnectionRequest);
  const acceptConnection = useMutation(api.connections.acceptConnection);
  const rejectConnection = useMutation(api.connections.rejectConnection);
  const removeConnection = useMutation(api.connections.removeConnection);
  const profileUser = useQuery(api.users.getUser, userId ? { id: userId } : "skip");
  const resolvedUser = profileUser ?? (!userId ? authUser : null);
  const resolvedUserId = userId ?? authUser?._id ?? null;
  const [showConnections, setShowConnections] = useState(false);
  const [isConnectedActionHovered, setIsConnectedActionHovered] = useState(false);
  const connectionStatus = useQuery(
    api.connections.getConnectionStatus,
    authUser?._id && resolvedUserId
      ? { userId1: authUser._id, userId2: resolvedUserId }
      : "skip",
  );
  const connectionCount = useQuery(
    api.connections.getConnectionCount,
    resolvedUserId ? { userId: resolvedUserId } : "skip",
  );
  const profileConnections = useQuery(
    api.connections.listConnections,
    showConnections && resolvedUserId ? { userId: resolvedUserId } : "skip",
  );
  const posts = useQuery(
    api.posts.listPostsByUser,
    resolvedUserId ? { authorId: resolvedUserId } : "skip",
  );
  const isUserLoading = userId ? profileUser === undefined : resolvedUser === null;
  const userPosts = React.useMemo(() => posts ?? [], [posts]);

  const profilePostIds = React.useMemo(
    () => userPosts.map((post) => post._id),
    [userPosts],
  );

  const profileLikeStatuses = useQuery(
    api.likes.getLikeStatuses,
    authUser?._id && profilePostIds.length > 0
      ? { userId: authUser._id, postIds: profilePostIds }
      : "skip",
  );

  const [activeTab, setActiveTab] = useState(0);
  const [isStartingConversation, setIsStartingConversation] = useState(false);
  const [isConnectionActionPending, setIsConnectionActionPending] = useState(false);

  const userAvatar = resolveProfilePhoto(
    resolvedUser?.photoURL ?? resolvedUser?.image ?? DEFAULT_PROFILE.photoURL,
  );
  const userName =
    resolvedUser?.displayName ??
    resolvedUser?.name ??
    DEFAULT_PROFILE.displayName;
  const userTitle = resolvedUser?.title ?? DEFAULT_PROFILE.title;
  const location = resolvedUser?.location ?? DEFAULT_PROFILE.location;
  const connections = connectionCount ?? 0;
  const about =
    typeof resolvedUser?.about === "string" && resolvedUser.about.trim().length > 0
      ? resolvedUser.about
      : "No about information yet.";
  const experience =
    Array.isArray(resolvedUser?.experience) && resolvedUser.experience.length > 0
      ? resolvedUser.experience
      : ["No experience added yet."];
  const isOwnProfile =
    Boolean(authUser?._id) &&
    Boolean(resolvedUserId) &&
    authUser?._id === resolvedUserId;
  const canShowProfileActions = Boolean(authUser?._id) && !isOwnProfile;
  const connectionState = connectionStatus?.status ?? "none";
  const isConnectionStatusLoading =
    Boolean(authUser?._id) &&
    Boolean(resolvedUserId) &&
    connectionStatus === undefined;
  const connectionsList = React.useMemo(() => profileConnections ?? [], [profileConnections]);
  const isConnectionsListLoading = showConnections && profileConnections === undefined;

  React.useEffect(() => {
    if (connectionState !== "accepted") {
      setIsConnectedActionHovered(false);
    }
  }, [connectionState]);

  React.useEffect(() => {
    setShowConnections(false);
  }, [resolvedUserId]);

  const handleMessageClick = async () => {
    if (!authUser?._id || !resolvedUserId || isStartingConversation) {
      return;
    }

    setIsStartingConversation(true);

    try {
      if (authUser._id !== resolvedUserId) {
        await getOrCreateConversation({
          userId1: authUser._id,
          userId2: resolvedUserId,
        });
      }
      onNavigateMessaging();
    } finally {
      setIsStartingConversation(false);
    }
  };

  const handleConnect = async () => {
    if (!authUser?._id || !resolvedUserId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await sendConnectionRequest({
        fromUserId: authUser._id,
        toUserId: resolvedUserId,
      });
    } catch (error) {
      console.error("Failed to send connection request:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleAcceptConnection = async () => {
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await acceptConnection({ connectionId: connectionStatus.connectionId });
    } catch (error) {
      console.error("Failed to accept connection request:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleRejectConnection = async () => {
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await rejectConnection({ connectionId: connectionStatus.connectionId });
    } catch (error) {
      console.error("Failed to reject connection request:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleRemoveConnection = async () => {
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    if (!isConnectedActionHovered) {
      setIsConnectedActionHovered(true);
      return;
    }

    setIsConnectionActionPending(true);

    try {
      await removeConnection({ connectionId: connectionStatus.connectionId });
      setIsConnectedActionHovered(false);
    } catch (error) {
      console.error("Failed to remove connection:", error);
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleViewConnections = () => {
    if (!resolvedUserId) {
      return;
    }

    setShowConnections(true);
  };

  const handleCloseConnections = () => {
    setShowConnections(false);
  };

  const handleViewConnectionProfile = (targetUserId) => {
    if (!targetUserId) {
      return;
    }

    setShowConnections(false);
    onViewProfile(targetUserId);
  };

  return (
    <div className={classes.profile}>
      <Paper elevation={1} className={classes.card}>
        <div className={classes.backButtonRow}>
          <Button
            variant="text"
            onClick={onBack}
            className={classes.backButton}
            startIcon={<ArrowBackIcon fontSize="small" />}
          >
            Back to feed
          </Button>
        </div>

        <LoadingGate isLoading={isUserLoading}>
          <>
            <div className={classes.coverArea}>
              <Avatar src={userAvatar} className={classes.avatar} />
            </div>

            <Typography variant="h6" className={classes.name}>
              {userName}
            </Typography>
            <Typography variant="body2" className={classes.title}>
              {userTitle}
            </Typography>

            <div className={classes.metaRow}>
              {location && (
                <Typography variant="body2" color="textSecondary" className={classes.metaItem}>
                  <LocationOnIcon style={{ fontSize: 16, marginRight: 4 }} />
                  <span>{location}</span>
                </Typography>
              )}
              <Typography
                variant="body2"
                className={classes.networkMeta}
                role={resolvedUserId ? "button" : undefined}
                tabIndex={resolvedUserId ? 0 : undefined}
                onClick={handleViewConnections}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    handleViewConnections();
                  }
                }}
                style={{ cursor: resolvedUserId ? "pointer" : "default" }}
              >
                {connections} connections
              </Typography>
            </div>

            {canShowProfileActions && (
              <div className={classes.actionRow}>
                {connectionState === "none" && (
                  <Button
                    variant="contained"
                    size="small"
                    onClick={handleConnect}
                    disabled={
                      isConnectionStatusLoading ||
                      isConnectionActionPending ||
                      !authUser?._id ||
                      !resolvedUserId
                    }
                    style={{
                      backgroundColor: "#2e7d32",
                      color: "#fff",
                      textTransform: "none",
                      borderRadius: 16,
                      fontWeight: 600,
                      padding: "4px 16px",
                    }}
                  >
                    Connect
                  </Button>
                )}
                {connectionState === "pending" && connectionStatus?.direction === "sent" && (
                  <Button
                    variant="outlined"
                    size="small"
                    disabled
                    style={{
                      textTransform: "none",
                      borderRadius: 16,
                      borderColor: "#9e9e9e",
                      color: "#757575",
                      fontWeight: 600,
                      padding: "4px 16px",
                    }}
                  >
                    Pending
                  </Button>
                )}
                {connectionState === "pending" && connectionStatus?.direction === "received" && (
                  <>
                    <Button
                      variant="contained"
                      size="small"
                      onClick={handleAcceptConnection}
                      disabled={isConnectionActionPending}
                      style={{
                        backgroundColor: "#2e7d32",
                        color: "#fff",
                        textTransform: "none",
                        borderRadius: 16,
                        fontWeight: 600,
                        padding: "4px 16px",
                      }}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      onClick={handleRejectConnection}
                      disabled={isConnectionActionPending}
                      style={{
                        textTransform: "none",
                        borderRadius: 16,
                        borderColor: "#9e9e9e",
                        color: "#757575",
                        fontWeight: 600,
                        padding: "4px 16px",
                      }}
                    >
                      Reject
                    </Button>
                  </>
                )}
                {connectionState === "accepted" && (
                  <Button
                    variant="outlined"
                    size="small"
                    onClick={handleRemoveConnection}
                    onMouseEnter={() => setIsConnectedActionHovered(true)}
                    onMouseLeave={() => setIsConnectedActionHovered(false)}
                    onFocus={() => setIsConnectedActionHovered(true)}
                    onBlur={() => setIsConnectedActionHovered(false)}
                    disabled={isConnectionActionPending}
                    style={{
                      textTransform: "none",
                      borderRadius: 16,
                      borderColor: isConnectedActionHovered ? "#c62828" : "#2e7d32",
                      color: isConnectedActionHovered ? "#c62828" : "#2e7d32",
                      fontWeight: 600,
                      padding: "4px 16px",
                    }}
                  >
                    {isConnectedActionHovered ? "Remove" : "Connected ✓"}
                  </Button>
                )}
                <Button
                  variant="outlined"
                  size="small"
                  onClick={handleMessageClick}
                  disabled={isStartingConversation || !authUser?._id || !resolvedUserId}
                  style={{
                    textTransform: "none",
                    borderRadius: 16,
                    borderColor: "#2e7d32",
                    color: "#2e7d32",
                    fontWeight: 600,
                    padding: "4px 16px",
                  }}
                >
                  Message
                </Button>
              </div>
            )}

            {showConnections && (
              <div className={classes.connectionsPanel}>
                <div className={classes.connectionsPanelHeader}>
                  <Typography variant="subtitle2" className={classes.connectionsPanelTitle}>
                    {connections} connections
                  </Typography>
                  <Button
                    size="small"
                    variant="text"
                    className={classes.closeConnectionsButton}
                    onClick={handleCloseConnections}
                  >
                    Close
                  </Button>
                </div>
                <LoadingGate isLoading={isConnectionsListLoading}>
                  {connectionsList.length === 0 ? (
                    <Typography variant="body2" color="textSecondary">
                      No connections to show yet.
                    </Typography>
                  ) : (
                    <div className={classes.connectionsList}>
                      {connectionsList.map((connection) => (
                        <div
                          key={connection.connectionId}
                          role="button"
                          tabIndex={0}
                          className={classes.connectionCard}
                          onClick={() => handleViewConnectionProfile(connection.user._id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              handleViewConnectionProfile(connection.user._id);
                            }
                          }}
                        >
                          <Avatar
                            src={resolveProfilePhoto(connection.user.photoURL)}
                            alt={connection.user.displayName}
                            className={classes.connectionAvatar}
                          />
                          <div className={classes.connectionCardInfo}>
                            <Typography className={classes.connectionCardName}>
                              {connection.user.displayName}
                            </Typography>
                            <Typography className={classes.connectionCardTitle}>
                              {connection.user.title || "No title listed"}
                            </Typography>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </LoadingGate>
              </div>
            )}
            <Divider style={{ margin: "16px 0 0" }} />

            <Tabs
              value={activeTab}
              onChange={(_, nextTab) => setActiveTab(nextTab)}
              indicatorColor="primary"
              textColor="primary"
              variant="fullWidth"
              className={classes.tabs}
            >
              <Tab label="Posts" className={classes.tab} />
              <Tab label="About" className={classes.tab} />
            </Tabs>

            {activeTab === 0 && (
              <div className={`${classes.section} ${classes.postsSection}`}>
                <LoadingGate isLoading={posts === undefined}>
                  {userPosts.length === 0 ? (
                    <Typography variant="body2" color="textSecondary">
                      No posts yet.
                    </Typography>
                  ) : (
                    <div className={classes.postsList}>
                      {userPosts.map((post) => (
                        <Post
                          key={post._id}
                          postId={post._id}
                          authorId={post.authorId}
                          likesCount={post.likesCount}
                          commentsCount={post.commentsCount}
                          liked={profileLikeStatuses?.[post._id] ?? undefined}
                          profile={resolveProfilePhoto(post.author?.photoURL ?? userAvatar)}
                          username={post.author?.displayName ?? userName}
                          timestamp={post.createdAt}
                          description={post.description}
                          fileType={post.fileType}
                          fileData={post.fileData}
                        />
                      ))}
                    </div>
                  )}
                </LoadingGate>
              </div>
            )}

            {activeTab === 1 && (
              <div className={classes.section}>
                <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 6 }}>
                  About
                </Typography>
                <Typography
                  variant="body2"
                  color="textSecondary"
                  style={{ lineHeight: 1.65, whiteSpace: "pre-line" }}
                >
                  {about}
                </Typography>

                <Divider style={{ margin: "16px 0 12px" }} />

                <Typography variant="subtitle2" style={{ fontWeight: 700, marginBottom: 6 }}>
                  Experience
                </Typography>
                {experience.map((exp, index) => (
                  <Typography
                    key={`${exp}-${index}`}
                    variant="body2"
                    color="textSecondary"
                    style={{ marginBottom: 4, lineHeight: 1.55 }}
                  >
                    {exp}
                  </Typography>
                ))}
              </div>
            )}
          </>
        </LoadingGate>
      </Paper>
    </div>
  );
};

export default Profile;
