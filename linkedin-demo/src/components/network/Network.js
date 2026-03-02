import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Avatar, Button, Paper, TextField, Typography } from "@material-ui/core";
import { api } from "../../convex/_generated/api";
import useConvexUser from "../../hooks/useConvexUser";
import useErrorToast from "../../hooks/useErrorToast";
import { resolvePhoto } from "../../utils/photo";
import ConfirmDialog from "../common/ConfirmDialog";
import LoadingGate from "../LoadingGate";
import Style from "./Style";

const NetworkUserCard = ({
  candidateUser,
  authUserId,
  canConnect,
  classes,
  onNavigateProfile,
  sendConnectionRequest,
  acceptConnection,
  rejectConnection,
  removeConnection,
  followUser,
  unfollowUser,
  showError,
}) => {
  const connectionStatus = useQuery(
    api.connections.getConnectionStatus,
    authUserId
      ? { userId1: authUserId, userId2: candidateUser._id }
      : "skip",
  );
  const connectionCount = useQuery(
    api.connections.getConnectionCount,
    candidateUser?._id ? { userId: candidateUser._id } : "skip",
  );
  const candidateProfile = useQuery(
    api.users.getUser,
    candidateUser?._id ? { id: candidateUser._id } : "skip",
  );
  const mutualConnectionsCount = useQuery(
    api.connections.getMutualConnectionsCount,
    authUserId
      ? { viewerUserId: authUserId, targetUserId: candidateUser._id }
      : "skip",
  );
  const isFollowing = useQuery(
    api.follows.isFollowing,
    authUserId
      ? { followerId: authUserId, followedId: candidateUser._id }
      : "skip",
  );
  const [isConnectionActionPending, setIsConnectionActionPending] = useState(false);
  const [isFollowActionPending, setIsFollowActionPending] = useState(false);
  const [isConnectedActionHovered, setIsConnectedActionHovered] = useState(false);
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);
  const connectionState = connectionStatus?.status ?? "none";
  const candidateUsername = candidateProfile?.username ?? candidateUser?.username ?? null;

  useEffect(() => {
    if (connectionState !== "accepted") {
      setIsConnectedActionHovered(false);
    }
  }, [connectionState]);

  const handleConnect = async (event) => {
    event.stopPropagation();
    if (!authUserId || !candidateUser?._id || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);
    try {
      await sendConnectionRequest({
        fromUserId: authUserId,
        toUserId: candidateUser._id,
      });
    } catch (error) {
      console.error("Failed to send connection request:", error);
      showError("Failed to send connection request. Please try again.");
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleAccept = async (event) => {
    event.stopPropagation();
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);
    try {
      await acceptConnection({ connectionId: connectionStatus.connectionId });
    } catch (error) {
      console.error("Failed to accept connection request:", error);
      showError("Failed to accept connection request. Please try again.");
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleReject = async (event) => {
    event.stopPropagation();
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);
    try {
      await rejectConnection({ connectionId: connectionStatus.connectionId });
    } catch (error) {
      console.error("Failed to reject connection request:", error);
      showError("Failed to reject connection request. Please try again.");
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleRemove = (event) => {
    event.stopPropagation();
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsRemoveDialogOpen(true);
  };

  const handleRemoveDialogClose = () => {
    if (isConnectionActionPending) {
      return;
    }

    setIsRemoveDialogOpen(false);
  };

  const handleConfirmRemove = async () => {
    if (!connectionStatus?.connectionId || isConnectionActionPending) {
      return;
    }

    setIsConnectionActionPending(true);
    try {
      await removeConnection({ connectionId: connectionStatus.connectionId });
      setIsConnectedActionHovered(false);
      setIsRemoveDialogOpen(false);
    } catch (error) {
      console.error("Failed to remove connection:", error);
      showError("Failed to remove connection. Please try again.");
    } finally {
      setIsConnectionActionPending(false);
    }
  };

  const handleToggleFollow = async (event) => {
    event.stopPropagation();
    if (!authUserId || !candidateUser?._id || isFollowActionPending || isFollowing === undefined) {
      return;
    }

    setIsFollowActionPending(true);
    try {
      if (isFollowing) {
        await unfollowUser({
          followerId: authUserId,
          followedId: candidateUser._id,
        });
      } else {
        await followUser({
          followerId: authUserId,
          followedId: candidateUser._id,
        });
      }
    } catch (error) {
      console.error("Failed to update follow state:", error);
      showError("Failed to update follow state. Please try again.");
    } finally {
      setIsFollowActionPending(false);
    }
  };

  const renderConnectionAction = () => {
    if (connectionState === "pending" && connectionStatus?.direction === "received") {
      return (
        <>
          <Button
            variant="contained"
            size="small"
            className={classes.acceptButton}
            onClick={handleAccept}
            disabled={isConnectionActionPending}
          >
            Accept
          </Button>
          <Button
            variant="outlined"
            size="small"
            className={classes.rejectButton}
            onClick={handleReject}
            disabled={isConnectionActionPending}
          >
            Reject
          </Button>
        </>
      );
    }

    if (connectionState === "accepted") {
      return (
        <Button
          variant="outlined"
          size="small"
          className={classes.connectButton}
          onClick={handleRemove}
          onMouseEnter={() => setIsConnectedActionHovered(true)}
          onMouseLeave={() => setIsConnectedActionHovered(false)}
          onFocus={() => setIsConnectedActionHovered(true)}
          onBlur={() => setIsConnectedActionHovered(false)}
          disabled={isConnectionActionPending}
          style={{
            borderColor: isConnectedActionHovered ? "#c62828" : "#2e7d32",
            color: isConnectedActionHovered ? "#c62828" : "#2e7d32",
          }}
        >
          {isConnectedActionHovered ? "Remove" : "Connected ✓"}
        </Button>
      );
    }

    if (connectionState === "pending") {
      return (
        <Button
          variant="outlined"
          size="small"
          disabled
          className={`${classes.connectButton} ${classes.connectButtonPending}`}
        >
          Pending
        </Button>
      );
    }

    return (
      <Button
        variant="outlined"
        size="small"
        className={classes.connectButton}
        onClick={handleConnect}
        disabled={connectionStatus === undefined || isConnectionActionPending}
      >
        Connect
      </Button>
    );
  };

  return (
    <>
      <Paper
        elevation={1}
        className={classes.card}
        role="button"
        tabIndex={0}
        onClick={() =>
          onNavigateProfile({
            username: candidateUsername,
            userId: candidateUser._id,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onNavigateProfile({
              username: candidateUsername,
              userId: candidateUser._id,
            });
          }
        }}
      >
        <Avatar
          src={resolvePhoto(candidateUser.photoURL)}
          alt={candidateUser.displayName}
          className={classes.avatar}
        />
        <div className={classes.info}>
          <Typography className={classes.displayName}>{candidateUser.displayName}</Typography>
          <Typography className={classes.title}>{candidateUser.title}</Typography>
          <Typography className={classes.location}>
            {candidateUser.location?.trim().length > 0
              ? candidateUser.location
              : "Location not listed"}
          </Typography>
          <Typography className={classes.connectionCount}>
            {(connectionCount ?? 0)} connections
          </Typography>
          {authUserId && mutualConnectionsCount !== undefined && (
            <Typography className={classes.mutualConnectionCount}>
              {mutualConnectionsCount} mutual connection
              {mutualConnectionsCount === 1 ? "" : "s"}
            </Typography>
          )}
        </div>
        {canConnect && (
          <div className={classes.actionRow}>
            {renderConnectionAction()}
            <Button
              variant={isFollowing ? "contained" : "outlined"}
              size="small"
              className={`${classes.followButton} ${
                isFollowing ? classes.followButtonFollowing : ""
              }`}
              onClick={handleToggleFollow}
              disabled={isFollowActionPending || isFollowing === undefined}
            >
              {isFollowing ? "Following" : "Follow"}
            </Button>
          </div>
        )}
      </Paper>
      <ConfirmDialog
        open={isRemoveDialogOpen}
        onClose={handleRemoveDialogClose}
        onConfirm={handleConfirmRemove}
        description={`Remove ${candidateUser.displayName} from your connections?`}
        confirmLabel="Remove connection"
        isPending={isConnectionActionPending}
        dialogId={`remove-connection-dialog-title-${candidateUser._id}`}
      />
    </>
  );
};

const Network = ({ onNavigateProfile }) => {
  const classes = Style();
  const authUser = useConvexUser();
  const sendConnectionRequest = useMutation(api.connections.sendConnectionRequest);
  const acceptConnection = useMutation(api.connections.acceptConnection);
  const rejectConnection = useMutation(api.connections.rejectConnection);
  const removeConnection = useMutation(api.connections.removeConnection);
  const followUser = useMutation(api.follows.followUser);
  const unfollowUser = useMutation(api.follows.unfollowUser);
  const users = useQuery(api.users.listAllUsers);
  const pendingRequests = useQuery(
    api.connections.listPendingRequests,
    authUser?._id ? { userId: authUser._id } : "skip",
  );
  const [searchTerm, setSearchTerm] = useState("");
  const [pendingRequestActionIds, setPendingRequestActionIds] = useState(() => new Set());
  const { showError, ErrorToast } = useErrorToast();
  const canConnect = Boolean(authUser?._id);
  const normalizedTerm = searchTerm.trim().toLowerCase();
  const filteredUsers = useMemo(() => {
    if (!users) {
      return [];
    }

    const usersWithoutSelf = users.filter((user) => user._id !== authUser?._id);

    if (!normalizedTerm) {
      return usersWithoutSelf;
    }

    return usersWithoutSelf.filter((user) => {
      const fields = [user.displayName, user.title, user.location].filter(Boolean);
      return fields.some((field) => field.toLowerCase().includes(normalizedTerm));
    });
  }, [users, normalizedTerm, authUser?._id]);
  const pendingRequestList = useMemo(() => pendingRequests ?? [], [pendingRequests]);

  if (users?.length === 0) {
    return (
      <Paper className={classes.stateCard} elevation={1}>
        <Typography variant="body2" color="textSecondary">
          No users found yet.
        </Typography>
      </Paper>
    );
  }

  return (
    <div className={classes.network}>
      <div className={classes.controls}>
        <TextField
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          placeholder="Search your network"
          variant="outlined"
          size="small"
          fullWidth
          className={classes.searchField}
          inputProps={{ "aria-label": "Search users in network" }}
        />
      </div>
      {authUser?._id && (
        <LoadingGate isLoading={pendingRequests === undefined}>
          <Paper className={classes.pendingSection} elevation={1}>
            <Typography className={classes.pendingSectionTitle}>Pending Requests</Typography>
            {pendingRequestList.length === 0 ? (
              <Typography variant="body2" color="textSecondary">
                No pending requests.
              </Typography>
            ) : (
              <div className={classes.pendingRequestsList}>
                {pendingRequestList.map((request) => {
                  const isRequestActionPending = pendingRequestActionIds.has(request.connectionId);

                  return (
                    <Paper
                      key={request.connectionId}
                      elevation={0}
                      className={classes.pendingRequestCard}
                      role="button"
                      tabIndex={0}
                      onClick={() =>
                        onNavigateProfile({
                          username: request.user.username ?? null,
                          userId: request.user._id,
                        })
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onNavigateProfile({
                            username: request.user.username ?? null,
                            userId: request.user._id,
                          });
                        }
                      }}
                    >
                      <Avatar
                        src={resolvePhoto(request.user.photoURL)}
                        alt={request.user.displayName}
                        className={classes.avatar}
                      />
                      <div className={classes.info}>
                        <Typography className={classes.displayName}>
                          {request.user.displayName}
                        </Typography>
                        <Typography className={classes.title}>
                          {request.user.title || "No title listed"}
                        </Typography>
                      </div>
                      <div className={classes.actionRow}>
                        <Button
                          variant="contained"
                          size="small"
                          className={classes.acceptButton}
                          disabled={isRequestActionPending}
                          onClick={async (event) => {
                            event.stopPropagation();
                            if (isRequestActionPending) {
                              return;
                            }

                            setPendingRequestActionIds((prev) => {
                              const next = new Set(prev);
                              next.add(request.connectionId);
                              return next;
                            });

                            try {
                              await acceptConnection({ connectionId: request.connectionId });
                            } catch (error) {
                              console.error("Failed to accept request:", error);
                              showError("Failed to accept connection request. Please try again.");
                            } finally {
                              setPendingRequestActionIds((prev) => {
                                const next = new Set(prev);
                                next.delete(request.connectionId);
                                return next;
                              });
                            }
                          }}
                        >
                          Accept
                        </Button>
                        <Button
                          variant="outlined"
                          size="small"
                          className={classes.rejectButton}
                          disabled={isRequestActionPending}
                          onClick={async (event) => {
                            event.stopPropagation();
                            if (isRequestActionPending) {
                              return;
                            }

                            setPendingRequestActionIds((prev) => {
                              const next = new Set(prev);
                              next.add(request.connectionId);
                              return next;
                            });

                            try {
                              await rejectConnection({ connectionId: request.connectionId });
                            } catch (error) {
                              console.error("Failed to reject request:", error);
                              showError("Failed to reject connection request. Please try again.");
                            } finally {
                              setPendingRequestActionIds((prev) => {
                                const next = new Set(prev);
                                next.delete(request.connectionId);
                                return next;
                              });
                            }
                          }}
                        >
                          Reject
                        </Button>
                      </div>
                    </Paper>
                  );
                })}
              </div>
            )}
          </Paper>
        </LoadingGate>
      )}
      <LoadingGate isLoading={users === undefined}>
        <>
          <div className={classes.grid}>
            {filteredUsers.map((candidateUser) => (
              <NetworkUserCard
                key={candidateUser._id}
                candidateUser={candidateUser}
                authUserId={authUser?._id ?? null}
                canConnect={canConnect}
                classes={classes}
                onNavigateProfile={onNavigateProfile}
                sendConnectionRequest={sendConnectionRequest}
                acceptConnection={acceptConnection}
                rejectConnection={rejectConnection}
                removeConnection={removeConnection}
                followUser={followUser}
                unfollowUser={unfollowUser}
                showError={showError}
              />
            ))}
          </div>
          {filteredUsers.length === 0 && (
            <Paper className={classes.stateCard} elevation={1}>
              <Typography variant="body2" color="textSecondary">
                {normalizedTerm
                  ? `No people match "${searchTerm.trim()}".`
                  : "No people to show yet."}
              </Typography>
            </Paper>
          )}
        </>
      </LoadingGate>
      <ErrorToast />
    </div>
  );
};

export default Network;
