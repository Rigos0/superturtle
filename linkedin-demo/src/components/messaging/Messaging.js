import React, { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Avatar,
  Button,
  CircularProgress,
  IconButton,
  Paper,
  TextField,
  Typography,
} from "@material-ui/core";
import Skeleton from "@material-ui/lab/Skeleton";
import ArrowBackIcon from "@material-ui/icons/ArrowBack";
import SendIcon from "@material-ui/icons/Send";
import { api } from "../../convex/_generated/api";
import { DEFAULT_PHOTO } from "../../constants";
import useConvexUser from "../../hooks/useConvexUser";
import useStyles from "./Style";

const truncatePreview = (value = "", maxLength = 50) => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
};

const formatTimeAgo = (timestamp) => {
  if (!timestamp) {
    return "";
  }

  const now = Date.now();
  const seconds = Math.max(1, Math.floor((now - timestamp) / 1000));

  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }

  return new Date(timestamp).toLocaleDateString();
};

const resolvePhoto = (photoURL) => {
  if (!photoURL || (typeof photoURL === "string" && photoURL.startsWith("/"))) {
    return DEFAULT_PHOTO;
  }
  return photoURL;
};

const Messaging = () => {
  const classes = useStyles();
  const user = useConvexUser();
  const sendMessage = useMutation(api.messaging.sendMessage);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [body, setBody] = useState("");
  const messageEndRef = useRef(null);

  const conversations = useQuery(
    api.messaging.listConversations,
    user?._id ? { userId: user._id } : "skip"
  );

  const selectedConversation = useMemo(
    () => conversations?.find((conversation) => conversation._id === selectedConversationId) ?? null,
    [conversations, selectedConversationId]
  );

  const messages = useQuery(
    api.messaging.listMessages,
    selectedConversationId ? { conversationId: selectedConversationId } : "skip"
  );

  useEffect(() => {
    if (!selectedConversationId || !conversations) {
      return;
    }

    const stillExists = conversations.some((conversation) => conversation._id === selectedConversationId);
    if (!stillExists) {
      setSelectedConversationId(null);
      setBody("");
    }
  }, [conversations, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId || !messageEndRef.current) {
      return;
    }

    messageEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, selectedConversationId]);

  const handleSendMessage = async (event) => {
    event.preventDefault();

    const trimmedBody = body.trim();
    if (!trimmedBody || !selectedConversationId || !user?._id) {
      return;
    }

    try {
      await sendMessage({
        conversationId: selectedConversationId,
        senderId: user._id,
        body: trimmedBody,
      });
      setBody("");
    } catch (error) {
      console.error("Failed to send message:", error);
    }
  };

  if (!user?._id) {
    return (
      <Paper className={classes.root} elevation={1}>
        <div className={classes.emptyState}>
          <Typography variant="body2">Sign in to use messaging.</Typography>
        </div>
      </Paper>
    );
  }

  if (conversations === undefined) {
    return (
      <Paper className={classes.root} elevation={1}>
        <div className={classes.listView}>
          <div className={classes.listHeader}>
            <Typography variant="h6" style={{ fontSize: 18, fontWeight: 700 }}>
              Messaging
            </Typography>
          </div>
          {Array.from({ length: 4 }).map((_, index) => (
            <div
              key={`conversation-skeleton-${index}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 16px",
                borderBottom: "1px solid #f1f3f4",
              }}
            >
              <Skeleton variant="circle" width={40} height={40} animation="wave" />
              <div style={{ flex: 1 }}>
                <Skeleton variant="text" width="56%" height={18} animation="wave" />
                <Skeleton variant="text" width="78%" height={16} animation="wave" />
              </div>
            </div>
          ))}
        </div>
      </Paper>
    );
  }

  if (!selectedConversationId) {
    return (
      <Paper className={classes.root} elevation={1}>
        <div className={classes.listView}>
          <div className={classes.listHeader}>
            <Typography variant="h6" style={{ fontSize: 18, fontWeight: 700 }}>
              Messaging
            </Typography>
          </div>
          {conversations.length === 0 ? (
            <div className={classes.emptyState}>
              <Typography variant="body2">No conversations yet.</Typography>
            </div>
          ) : (
            conversations.map((conversation) => {
              const preview = conversation.latestMessage?.body ?? "No messages yet";
              const displayName = conversation.otherParticipant?.displayName ?? "Unknown user";
              const photoURL = resolvePhoto(conversation.otherParticipant?.photoURL);
              const timestamp = conversation.latestMessage?.createdAt ?? conversation.createdAt;

              return (
                <button
                  type="button"
                  key={conversation._id}
                  className={classes.conversationItem}
                  onClick={() => setSelectedConversationId(conversation._id)}
                >
                  <Avatar src={photoURL} alt={displayName} />
                  <div className={classes.conversationMain}>
                    <div className={classes.conversationTopRow}>
                      <p className={classes.conversationName}>{displayName}</p>
                      <span className={classes.conversationTime}>{formatTimeAgo(timestamp)}</span>
                    </div>
                    <p className={classes.conversationPreview}>{truncatePreview(preview, 50)}</p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </Paper>
    );
  }

  const threadTitle = selectedConversation?.otherParticipant?.displayName ?? "Conversation";

  return (
    <Paper className={classes.root} elevation={1}>
      <div className={classes.threadHeader}>
        <IconButton
          className={classes.backButton}
          onClick={() => {
            setSelectedConversationId(null);
            setBody("");
          }}
          aria-label="Back to conversations"
        >
          <ArrowBackIcon />
        </IconButton>
        <Typography className={classes.threadTitle}>{threadTitle}</Typography>
      </div>

      <div className={classes.messageList}>
        {messages === undefined ? (
          <div className={classes.loadingState}>
            <CircularProgress size={22} style={{ color: "#2e7d32" }} />
          </div>
        ) : messages.length === 0 ? (
          <div className={classes.emptyState}>
            <Typography variant="body2">No messages yet. Start the conversation.</Typography>
          </div>
        ) : (
          messages.map((message) => {
            const isOwnMessage = message.senderId === user._id;

            return (
              <div
                key={message._id}
                className={`${classes.messageRow} ${isOwnMessage ? classes.ownRow : classes.otherRow}`}
              >
                <div
                  className={`${classes.bubble} ${
                    isOwnMessage ? classes.ownBubble : classes.otherBubble
                  }`}
                >
                  <Typography className={classes.messageText}>{message.body}</Typography>
                  <Typography className={classes.messageMeta}>
                    {formatTimeAgo(message.createdAt)}
                  </Typography>
                </div>
              </div>
            );
          })
        )}
        <div ref={messageEndRef} />
      </div>

      <form className={classes.inputBar} onSubmit={handleSendMessage}>
        <TextField
          className={classes.inputField}
          variant="outlined"
          size="small"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Type a message"
        />
        <Button
          className={classes.sendButton}
          type="submit"
          variant="contained"
          endIcon={<SendIcon />}
          disabled={!body.trim()}
        >
          Send
        </Button>
      </form>
    </Paper>
  );
};

export default Messaging;
