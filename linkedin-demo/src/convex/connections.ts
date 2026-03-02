import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { buildAuthorSummary } from "./helpers";

export const sendConnectionRequest = mutation({
  args: {
    fromUserId: v.id("users"),
    toUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    if (args.fromUserId === args.toUserId) {
      throw new Error("Cannot connect with yourself");
    }

    const [existingForward, existingReverse] = await Promise.all([
      ctx.db
        .query("connections")
        .withIndex("byUsers", (q) =>
          q.eq("userId1", args.fromUserId).eq("userId2", args.toUserId),
        )
        .first(),
      ctx.db
        .query("connections")
        .withIndex("byUsers", (q) =>
          q.eq("userId1", args.toUserId).eq("userId2", args.fromUserId),
        )
        .first(),
    ]);

    if (existingForward || existingReverse) {
      throw new Error("Connection already exists");
    }

    const connectionId = await ctx.db.insert("connections", {
      userId1: args.fromUserId,
      userId2: args.toUserId,
      status: "pending",
      requestedBy: args.fromUserId,
      createdAt: Date.now(),
    });

    await ctx.db.insert("notifications", {
      userId: args.toUserId,
      type: "connection_request",
      fromUserId: args.fromUserId,
      read: false,
      createdAt: Date.now(),
    });

    return connectionId;
  },
});

export const acceptConnection = mutation({
  args: {
    connectionId: v.id("connections"),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    if (connection.status !== "accepted") {
      await ctx.db.patch(args.connectionId, {
        status: "accepted",
      });

      const acceptedBy =
        connection.requestedBy === connection.userId1
          ? connection.userId2
          : connection.userId1;

      await ctx.db.insert("notifications", {
        userId: connection.requestedBy,
        type: "connection_accepted",
        fromUserId: acceptedBy,
        read: false,
        createdAt: Date.now(),
      });
    }
  },
});

export const rejectConnection = mutation({
  args: {
    connectionId: v.id("connections"),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    await ctx.db.delete(args.connectionId);
  },
});

export const removeConnection = mutation({
  args: {
    connectionId: v.id("connections"),
  },
  handler: async (ctx, args) => {
    const connection = await ctx.db.get(args.connectionId);
    if (!connection) {
      throw new Error("Connection not found");
    }

    await ctx.db.delete(args.connectionId);
  },
});

export const getConnectionStatus = query({
  args: {
    userId1: v.id("users"),
    userId2: v.id("users"),
  },
  handler: async (ctx, args) => {
    const [forwardConnection, reverseConnection] = await Promise.all([
      ctx.db
        .query("connections")
        .withIndex("byUsers", (q) =>
          q.eq("userId1", args.userId1).eq("userId2", args.userId2),
        )
        .first(),
      ctx.db
        .query("connections")
        .withIndex("byUsers", (q) =>
          q.eq("userId1", args.userId2).eq("userId2", args.userId1),
        )
        .first(),
    ]);

    const connection = forwardConnection ?? reverseConnection;

    if (!connection) {
      return { status: "none" as const };
    }

    if (connection.status === "accepted") {
      return {
        status: "accepted" as const,
        connectionId: connection._id,
      };
    }

    return {
      status: "pending" as const,
      connectionId: connection._id,
      direction:
        connection.requestedBy === args.userId1
          ? ("sent" as const)
          : ("received" as const),
    };
  },
});

export const listConnections = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const [requestedConnections, receivedConnections] = await Promise.all([
      ctx.db
        .query("connections")
        .withIndex("byUser1", (q) =>
          q.eq("userId1", args.userId).eq("status", "accepted"),
        )
        .collect(),
      ctx.db
        .query("connections")
        .withIndex("byUser2", (q) =>
          q.eq("userId2", args.userId).eq("status", "accepted"),
        )
        .collect(),
    ]);

    const allConnections = [
      ...requestedConnections.map((connection) => ({
        connectionId: connection._id,
        otherUserId: connection.userId2,
      })),
      ...receivedConnections.map((connection) => ({
        connectionId: connection._id,
        otherUserId: connection.userId1,
      })),
    ];

    const withUsers = await Promise.all(
      allConnections.map(async (connection) => {
        const user = await ctx.db.get(connection.otherUserId);
        if (!user) {
          return null;
        }

        const userSummary = await buildAuthorSummary(ctx, user);
        return {
          connectionId: connection.connectionId,
          user: userSummary
            ? {
                ...userSummary,
                location: user.location ?? "",
              }
            : null,
        };
      }),
    );

    return withUsers
      .filter(
        (
          connection,
        ): connection is NonNullable<typeof connection> & {
          user: NonNullable<NonNullable<typeof connection>["user"]>;
        } => connection !== null && connection.user !== null,
      )
      .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
  },
});

export const listPendingRequests = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const pendingConnections = await ctx.db
      .query("connections")
      .withIndex("byUser2", (q) =>
        q.eq("userId2", args.userId).eq("status", "pending"),
      )
      .collect();

    const withUsers = await Promise.all(
      pendingConnections.map(async (connection) => {
        const requester = await ctx.db.get(connection.requestedBy);
        if (!requester) {
          return null;
        }

        const requesterSummary = await buildAuthorSummary(ctx, requester);
        return {
          connectionId: connection._id,
          user: requesterSummary
            ? {
                ...requesterSummary,
                location: requester.location ?? "",
              }
            : null,
        };
      }),
    );

    return withUsers
      .filter(
        (
          connection,
        ): connection is NonNullable<typeof connection> & {
          user: NonNullable<NonNullable<typeof connection>["user"]>;
        } => connection !== null && connection.user !== null,
      )
      .sort((a, b) => a.user.displayName.localeCompare(b.user.displayName));
  },
});

export const getConnectionCount = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const [requestedConnections, receivedConnections] = await Promise.all([
      ctx.db
        .query("connections")
        .withIndex("byUser1", (q) =>
          q.eq("userId1", args.userId).eq("status", "accepted"),
        )
        .collect(),
      ctx.db
        .query("connections")
        .withIndex("byUser2", (q) =>
          q.eq("userId2", args.userId).eq("status", "accepted"),
        )
        .collect(),
    ]);

    return requestedConnections.length + receivedConnections.length;
  },
});

export const getMutualConnectionsCount = query({
  args: {
    viewerUserId: v.id("users"),
    targetUserId: v.id("users"),
  },
  handler: async (ctx, args) => {
    if (args.viewerUserId === args.targetUserId) {
      return 0;
    }

    const [
      viewerRequestedConnections,
      viewerReceivedConnections,
      targetRequestedConnections,
      targetReceivedConnections,
    ] = await Promise.all([
      ctx.db
        .query("connections")
        .withIndex("byUser1", (q) =>
          q.eq("userId1", args.viewerUserId).eq("status", "accepted"),
        )
        .collect(),
      ctx.db
        .query("connections")
        .withIndex("byUser2", (q) =>
          q.eq("userId2", args.viewerUserId).eq("status", "accepted"),
        )
        .collect(),
      ctx.db
        .query("connections")
        .withIndex("byUser1", (q) =>
          q.eq("userId1", args.targetUserId).eq("status", "accepted"),
        )
        .collect(),
      ctx.db
        .query("connections")
        .withIndex("byUser2", (q) =>
          q.eq("userId2", args.targetUserId).eq("status", "accepted"),
        )
        .collect(),
    ]);

    const viewerConnectionUserIds = new Set([
      ...viewerRequestedConnections.map((connection) => connection.userId2),
      ...viewerReceivedConnections.map((connection) => connection.userId1),
    ]);

    if (viewerConnectionUserIds.size === 0) {
      return 0;
    }

    const targetConnectionUserIds = new Set([
      ...targetRequestedConnections.map((connection) => connection.userId2),
      ...targetReceivedConnections.map((connection) => connection.userId1),
    ]);

    if (targetConnectionUserIds.size === 0) {
      return 0;
    }

    const smallerSet =
      viewerConnectionUserIds.size <= targetConnectionUserIds.size
        ? viewerConnectionUserIds
        : targetConnectionUserIds;
    const largerSet =
      smallerSet === viewerConnectionUserIds
        ? targetConnectionUserIds
        : viewerConnectionUserIds;

    let mutualCount = 0;
    for (const connectionUserId of smallerSet) {
      if (largerSet.has(connectionUserId)) {
        mutualCount += 1;
      }
    }

    return mutualCount;
  },
});
