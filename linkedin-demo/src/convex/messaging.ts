import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const normalizeParticipants = (participantIds: string[]) => {
  return [...new Set(participantIds)].sort();
};

const sameParticipants = (a: string[], b: string[]) => {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((id, index) => id === b[index]);
};

export const createConversation = mutation({
  args: {
    participantIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const normalizedArgs = normalizeParticipants(args.participantIds.map(String));
    if (normalizedArgs.length < 2) {
      throw new Error("A conversation must include at least two participants");
    }

    const conversations = await ctx.db.query("conversations").collect();
    const existingConversation = conversations.find((conversation) => {
      const normalizedConversation = normalizeParticipants(
        conversation.participants.map(String),
      );
      return sameParticipants(normalizedConversation, normalizedArgs);
    });

    if (existingConversation) {
      return existingConversation._id;
    }

    return await ctx.db.insert("conversations", {
      participants: args.participantIds,
      createdAt: Date.now(),
    });
  },
});

export const sendMessage = mutation({
  args: {
    conversationId: v.id("conversations"),
    senderId: v.id("users"),
    body: v.string(),
  },
  handler: async (ctx, args) => {
    const body = args.body.trim();
    if (!body) {
      throw new Error("Message body is required");
    }

    return await ctx.db.insert("messages", {
      conversationId: args.conversationId,
      senderId: args.senderId,
      body,
      createdAt: Date.now(),
    });
  },
});

export const listConversations = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db.query("conversations").collect();
    const relevantConversations = conversations.filter((conversation) =>
      conversation.participants.includes(args.userId),
    );

    const conversationsWithDetails = await Promise.all(
      relevantConversations.map(async (conversation) => {
        const otherParticipantId = conversation.participants.find(
          (participantId) => participantId !== args.userId,
        );

        const otherParticipant = otherParticipantId
          ? await ctx.db.get(otherParticipantId)
          : null;

        const messages = await ctx.db
          .query("messages")
          .filter((q) => q.eq(q.field("conversationId"), conversation._id))
          .collect();

        const latestMessage = [...messages].sort(
          (a, b) => b.createdAt - a.createdAt,
        )[0] ?? null;

        return {
          ...conversation,
          otherParticipant: otherParticipant
            ? {
                _id: otherParticipant._id,
                displayName: otherParticipant.displayName,
                photoURL: otherParticipant.photoURL,
              }
            : null,
          latestMessage,
          latestMessageCreatedAt: latestMessage
            ? latestMessage.createdAt
            : conversation.createdAt,
        };
      }),
    );

    return conversationsWithDetails.sort(
      (a, b) => b.latestMessageCreatedAt - a.latestMessageCreatedAt,
    );
  },
});

export const listMessages = query({
  args: {
    conversationId: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("messages")
      .filter((q) => q.eq(q.field("conversationId"), args.conversationId))
      .collect();

    const sortedMessages = [...messages].sort((a, b) => a.createdAt - b.createdAt);

    return await Promise.all(
      sortedMessages.map(async (message) => {
        const sender = await ctx.db.get(message.senderId);
        return {
          ...message,
          sender: sender
            ? {
                _id: sender._id,
                displayName: sender.displayName,
                photoURL: sender.photoURL,
              }
            : null,
        };
      }),
    );
  },
});
