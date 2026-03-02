import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { Avatar, Button, Paper, TextField, Typography } from "@material-ui/core";
import { api } from "../../convex/_generated/api";
import { DEFAULT_PHOTO } from "../../constants";
import useConvexUser from "../../hooks/useConvexUser";
import LoadingGate from "../LoadingGate";
import Style from "./Style";

const resolvePhoto = (photoURL) => {
  if (!photoURL || (typeof photoURL === "string" && photoURL.startsWith("/"))) {
    return DEFAULT_PHOTO;
  }

  return photoURL;
};

const Network = ({ onNavigateProfile }) => {
  const classes = Style();
  const authUser = useConvexUser();
  const users = useQuery(api.users.listAllUsers);
  const [searchTerm, setSearchTerm] = useState("");
  const [pendingIds, setPendingIds] = useState(() => new Set());
  const canConnect = Boolean(authUser?._id);
  const normalizedTerm = searchTerm.trim().toLowerCase();
  const filteredUsers = useMemo(() => {
    if (!users) {
      return [];
    }

    if (!normalizedTerm) {
      return users;
    }

    return users.filter((user) => {
      const fields = [user.displayName, user.title, user.location].filter(Boolean);
      return fields.some((field) => field.toLowerCase().includes(normalizedTerm));
    });
  }, [users, normalizedTerm]);

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
      <LoadingGate isLoading={users === undefined}>
        <>
          <div className={classes.grid}>
            {filteredUsers.map((user) => {
              const isPending = pendingIds.has(user._id);

              return (
                <Paper
                  key={user._id}
                  elevation={1}
                  className={classes.card}
                  role="button"
                  tabIndex={0}
                  onClick={() => onNavigateProfile(user._id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onNavigateProfile(user._id);
                    }
                  }}
                >
                  <Avatar
                    src={resolvePhoto(user.photoURL)}
                    alt={user.displayName}
                    className={classes.avatar}
                  />
                  <div className={classes.info}>
                    <Typography className={classes.displayName}>{user.displayName}</Typography>
                    <Typography className={classes.title}>{user.title}</Typography>
                    <Typography className={classes.location}>
                      {user.location?.trim().length > 0 ? user.location : "Location not listed"}
                    </Typography>
                  </div>
                  {canConnect && (
                    <Button
                      variant="outlined"
                      size="small"
                      disabled={isPending}
                      className={`${classes.connectButton} ${
                        isPending ? classes.connectButtonPending : ""
                      }`}
                      onClick={(event) => {
                        event.stopPropagation();

                        if (isPending) {
                          return;
                        }

                        setPendingIds((prev) => {
                          const next = new Set(prev);
                          next.add(user._id);
                          return next;
                        });
                      }}
                    >
                      {isPending ? "Pending" : "Connect"}
                    </Button>
                  )}
                </Paper>
              );
            })}
          </div>
          {filteredUsers.length === 0 && (
            <Paper className={classes.stateCard} elevation={1}>
              <Typography variant="body2" color="textSecondary">
                No people match "{searchTerm.trim()}".
              </Typography>
            </Paper>
          )}
        </>
      </LoadingGate>
    </div>
  );
};

export default Network;
