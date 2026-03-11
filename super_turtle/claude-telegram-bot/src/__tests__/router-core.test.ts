import { describe, test, expect, beforeEach } from "bun:test";
import {
  getThreadId,
  WorkerTable,
  UpdateCache,
  routeUpdate,
  pickEmoji,
  generateTopicName,
} from "../router-core";
import type { Update, Message, CallbackQuery, Chat, User } from "grammy/types";

// ============== Test Helpers ==============
//
// Grammy's Update type uses strict intersections:
//   message:              Message & Update.NonChannel  (requires `from: User`, non-channel chat)
//   edited_message:       Message & Update.Edited & Update.NonChannel  (also requires `edit_date: number`)
//   channel_post:         Message & Update.Channel  (requires `chat: ChannelChat`)
//   edited_channel_post:  Message & Update.Edited & Update.Channel
//
// These helpers build minimal objects satisfying those constraints.

const TEST_USER: User = { id: 1, is_bot: false, first_name: "Test" };

type NonChannelChat = Chat.PrivateChat | Chat.SupergroupChat | Chat.GroupChat;

function makeNonChannelChat(
  id: number,
  type: "private" | "supergroup" | "group",
): NonChannelChat {
  if (type === "private") return { id, type, first_name: "Test" };
  return { id, type, title: "Test" };
}

interface MsgOverrides {
  chat_id?: number;
  chat_type?: "private" | "supergroup" | "group";
  message_thread_id?: number;
  text?: string;
  new_chat_members?: User[];
}

/** Non-channel message for `Update.message`. Includes `from` to satisfy `NonChannel`. */
function makeMsg(
  overrides: MsgOverrides = {},
): Message & Update.NonChannel {
  const chat = makeNonChannelChat(
    overrides.chat_id ?? 1,
    overrides.chat_type ?? "private",
  );
  return {
    message_id: 1,
    date: 0,
    chat,
    from: TEST_USER,
    ...(overrides.message_thread_id !== undefined && {
      message_thread_id: overrides.message_thread_id,
    }),
    ...(overrides.text !== undefined && { text: overrides.text }),
    ...(overrides.new_chat_members !== undefined && {
      new_chat_members: overrides.new_chat_members,
    }),
  } as Message & Update.NonChannel;
}

/** Edited non-channel message for `Update.edited_message`. */
function makeEditedMsg(
  overrides: MsgOverrides = {},
): Message & Update.Edited & Update.NonChannel {
  const base = makeMsg(overrides);
  return { ...base, edit_date: 1 } as Message &
    Update.Edited &
    Update.NonChannel;
}

interface ChannelMsgOverrides {
  chat_id?: number;
  message_thread_id?: number;
}

/** Channel message for `Update.channel_post`. */
function makeChannelMsg(
  overrides: ChannelMsgOverrides = {},
): Message & Update.Channel {
  return {
    message_id: 1,
    date: 0,
    chat: {
      id: overrides.chat_id ?? -1001234,
      type: "channel" as const,
      title: "Test",
    },
    ...(overrides.message_thread_id !== undefined && {
      message_thread_id: overrides.message_thread_id,
    }),
  } as Message & Update.Channel;
}

/** Edited channel message for `Update.edited_channel_post`. */
function makeEditedChannelMsg(
  overrides: ChannelMsgOverrides = {},
): Message & Update.Edited & Update.Channel {
  const base = makeChannelMsg(overrides);
  return { ...base, edit_date: 1 } as Message &
    Update.Edited &
    Update.Channel;
}

function makeCallbackQuery(
  overrides: {
    id?: string;
    message?: Message;
  } = {},
): CallbackQuery {
  return {
    id: overrides.id ?? "1",
    chat_instance: "1",
    from: TEST_USER,
    ...(overrides.message && { message: overrides.message }),
  } as CallbackQuery;
}

function makeUpdate(partial: Partial<Update> & { update_id: number }): Update {
  return partial as Update;
}

describe("getThreadId", () => {
  test("extracts from message.message_thread_id", () => {
    expect(
      getThreadId(
        makeUpdate({
          update_id: 1,
          message: makeMsg({ chat_type: "supergroup", message_thread_id: 42 }),
        }),
      ),
    ).toBe(42);
  });

  test("extracts from edited_message", () => {
    expect(
      getThreadId(
        makeUpdate({
          update_id: 1,
          edited_message: makeEditedMsg({ chat_type: "supergroup", message_thread_id: 42 }),
        }),
      ),
    ).toBe(42);
  });

  test("extracts from callback_query.message", () => {
    expect(
      getThreadId(
        makeUpdate({
          update_id: 1,
          callback_query: makeCallbackQuery({
            message: makeMsg({ chat_type: "supergroup", message_thread_id: 42 }),
          }),
        }),
      ),
    ).toBe(42);
  });

  test("returns null for DM (no thread)", () => {
    expect(
      getThreadId(
        makeUpdate({
          update_id: 1,
          message: makeMsg({ chat_type: "private" }),
        }),
      ),
    ).toBeNull();
  });

  test("returns null for empty update", () => {
    expect(getThreadId(makeUpdate({ update_id: 1 }))).toBeNull();
  });

  test("extracts from channel_post.message_thread_id", () => {
    expect(
      getThreadId(
        makeUpdate({
          update_id: 1,
          channel_post: makeChannelMsg({ chat_id: -1001234, message_thread_id: 77 }),
        }),
      ),
    ).toBe(77);
  });

  test("extracts from edited_channel_post.message_thread_id", () => {
    expect(
      getThreadId(
        makeUpdate({
          update_id: 1,
          edited_channel_post: makeEditedChannelMsg({ chat_id: -1001234, message_thread_id: 88 }),
        }),
      ),
    ).toBe(88);
  });
});

describe("WorkerTable", () => {
  let table: WorkerTable;
  beforeEach(() => {
    table = new WorkerTable();
  });

  test("add and find by thread", () => {
    table.add("w1", "/proj", 42);
    expect(table.findByThread(42)).toBe("w1");
  });

  test("find default worker (threadId=null)", () => {
    table.add("w1", "/proj", null);
    expect(table.findDefault()).toBe("w1");
    expect(table.findByThread(42)).toBeNull();
  });

  test("remove worker", () => {
    table.add("w1", "/proj", 42);
    table.remove("w1");
    expect(table.findByThread(42)).toBeNull();
  });

  test("isForumMode with single default", () => {
    table.add("w1", "/proj", null);
    expect(table.isForumMode()).toBe(false);
  });

  test("isForumMode with two workers", () => {
    table.add("w1", "/proj", null);
    table.add("w2", "/proj2", 42);
    expect(table.isForumMode()).toBe(true);
  });

  test("isForumMode with single threaded worker", () => {
    table.add("w1", "/proj", 42);
    expect(table.isForumMode()).toBe(true);
  });

  test("count", () => {
    expect(table.count()).toBe(0);
    table.add("w1", "/proj", null);
    expect(table.count()).toBe(1);
    table.add("w2", "/proj2", 42);
    expect(table.count()).toBe(2);
  });

  test("getEntry returns worker info", () => {
    table.add("w1", "/proj", 42);
    const entry = table.getEntry("w1");
    expect(entry?.workingDir).toBe("/proj");
    expect(entry?.threadId).toBe(42);
  });

  test("getEntry returns undefined for missing", () => {
    expect(table.getEntry("nope")).toBeUndefined();
  });

  test("entries returns all workers", () => {
    table.add("w1", "/p1", 1);
    table.add("w2", "/p2", 2);
    expect(table.entries()).toHaveLength(2);
  });

  test("duplicate thread ID collision: first-registered wins", () => {
    // Two workers claim the same threadId.
    // WorkerTable.findByThread iterates Map values; Map preserves insertion
    // order, so the first match wins.
    table.add("w1", "/proj1", 42);
    table.add("w2", "/proj2", 42);
    const found = table.findByThread(42);
    // Map iteration is insertion-order, so first registered ("w1") wins
    expect(found).toBe("w1");
  });

  test("findByWorkingDir returns worker for matching dir", () => {
    table.add("w1", "/projects/alpha", 1);
    table.add("w2", "/projects/beta", 2);
    expect(table.findByWorkingDir("/projects/alpha")).toBe("w1");
    expect(table.findByWorkingDir("/projects/beta")).toBe("w2");
  });

  test("findByWorkingDir returns null for unknown dir", () => {
    table.add("w1", "/projects/alpha", 1);
    expect(table.findByWorkingDir("/projects/unknown")).toBeNull();
  });
});

describe("pickEmoji", () => {
  test("same input always produces the same emoji", () => {
    expect(pickEmoji("/some/path")).toBe(pickEmoji("/some/path"));
  });

  test("different inputs can produce different emojis", () => {
    // Collect emojis for many different paths — at least 2 distinct values expected
    const emojis = new Set<string>();
    for (let i = 0; i < 20; i++) {
      emojis.add(pickEmoji(`/projects/project-${i}`));
    }
    expect(emojis.size).toBeGreaterThan(1);
  });

  test("returns a non-empty string", () => {
    expect(pickEmoji("/any/path").length).toBeGreaterThan(0);
  });
});

describe("generateTopicName", () => {
  test("uses basename and emoji for default branch", () => {
    const name = generateTopicName("/projects/my-app", "main");
    expect(name).toMatch(/^\S+ my-app$/);
  });

  test("includes branch for non-default branch", () => {
    const name = generateTopicName("/projects/my-app", "fix/auth");
    expect(name).toMatch(/^\S+ my-app \/ fix\/auth$/);
  });

  test("omits branch when null", () => {
    const name = generateTopicName("/projects/my-app", null);
    expect(name).toMatch(/^\S+ my-app$/);
  });

  test("omits branch for master", () => {
    const name = generateTopicName("/projects/my-app", "master");
    expect(name).toMatch(/^\S+ my-app$/);
  });

  test("omits branch for HEAD", () => {
    const name = generateTopicName("/projects/my-app", "HEAD");
    expect(name).toMatch(/^\S+ my-app$/);
  });

  test("truncates to 128 code points for long names", () => {
    const longDir = "/projects/" + "a".repeat(100);
    const longBranch = "feature/" + "b".repeat(100);
    const name = generateTopicName(longDir, longBranch);
    expect([...name].length).toBeLessThanOrEqual(128);
    expect(name).toEndWith("...");
  });
});

describe("UpdateCache", () => {
  let cache: UpdateCache;
  beforeEach(() => {
    cache = new UpdateCache(5, 60_000);
  });

  test("store and drain", () => {
    cache.push(42, makeUpdate({ update_id: 1 }));
    cache.push(42, makeUpdate({ update_id: 2 }));
    const drained = cache.drain(42);
    expect(drained).toHaveLength(2);
    expect(cache.drain(42)).toHaveLength(0);
  });

  test("respects max size", () => {
    for (let i = 0; i < 10; i++) {
      cache.push(42, makeUpdate({ update_id: i }));
    }
    const drained = cache.drain(42);
    expect(drained).toHaveLength(5);
    expect(drained[0]!.update_id).toBe(5); // oldest kept
  });

  test("separate threads don't interfere", () => {
    cache.push(42, makeUpdate({ update_id: 1 }));
    cache.push(99, makeUpdate({ update_id: 2 }));
    expect(cache.drain(42)).toHaveLength(1);
    expect(cache.drain(99)).toHaveLength(1);
  });

  test("drain empty thread returns empty", () => {
    expect(cache.drain(999)).toHaveLength(0);
  });

  test("TTL expiration drops stale updates", async () => {
    const shortCache = new UpdateCache(100, 1); // 1ms TTL
    shortCache.push(42, makeUpdate({ update_id: 1 }));
    await Bun.sleep(5);
    const drained = shortCache.drain(42);
    expect(drained).toHaveLength(0);
  });

  test("global thread limit evicts oldest thread", () => {
    const limitedCache = new UpdateCache(100, 60_000, 2); // maxThreads=2

    // Push updates for 3 different threads; thread 10 is pushed first (oldest)
    limitedCache.push(10, makeUpdate({ update_id: 1 }));
    limitedCache.push(20, makeUpdate({ update_id: 2 }));
    // At this point cache has 2 threads. Pushing thread 30 should evict thread 10.
    limitedCache.push(30, makeUpdate({ update_id: 3 }));

    // Thread 10 was evicted
    expect(limitedCache.drain(10)).toHaveLength(0);
    // Threads 20 and 30 remain
    expect(limitedCache.drain(20)).toHaveLength(1);
    expect(limitedCache.drain(30)).toHaveLength(1);
  });
});

describe("routeUpdate", () => {
  let table: WorkerTable;
  let cache: UpdateCache;
  beforeEach(() => {
    table = new WorkerTable();
    cache = new UpdateCache(100, 300_000);
  });

  test("single default worker gets all updates", () => {
    table.add("w1", "/proj", null);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_type: "private" }),
      }),
    );
    expect(result.type).toBe("forward");
    if (result.type === "forward") {
      expect(result.workerId).toBe("w1");
    }
  });

  test("single default worker gets threaded updates too", () => {
    table.add("w1", "/proj", null);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_type: "supergroup", message_thread_id: 42 }),
      }),
    );
    expect(result.type).toBe("forward");
    if (result.type === "forward") {
      expect(result.workerId).toBe("w1");
    }
  });

  test("single forum-mode worker forwards matching thread", () => {
    // One worker with a threadId → isForumMode() returns true,
    // so the "single default forwards all" shortcut is skipped.
    table.add("w1", "/proj", 42);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_type: "supergroup", message_thread_id: 42 }),
      }),
    );
    expect(result.type).toBe("forward");
    if (result.type === "forward") {
      expect(result.workerId).toBe("w1");
    }
  });

  test("single forum-mode worker caches mismatched thread", () => {
    table.add("w1", "/proj", 42);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_type: "supergroup", message_thread_id: 999 }),
      }),
    );
    expect(result.type).toBe("cached");
    expect(cache.drain(999)).toHaveLength(1);
  });

  test("single forum-mode worker redirects non-threaded message", () => {
    table.add("w1", "/proj", 42);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_id: -100123, chat_type: "supergroup", text: "hello" }),
      }),
    );
    expect(result.type).toBe("redirect");
    if (result.type === "redirect") {
      expect(result.chatId).toBe(-100123);
    }
  });

  test("multi-worker routes by thread", () => {
    table.add("w1", "/proj1", 42);
    table.add("w2", "/proj2", 99);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_type: "supergroup", message_thread_id: 42 }),
      }),
    );
    expect(result.type).toBe("forward");
    if (result.type === "forward") {
      expect(result.workerId).toBe("w1");
    }
  });

  test("unknown thread in multi-worker → cache", () => {
    table.add("w1", "/proj1", 42);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_type: "supergroup", message_thread_id: 999 }),
      }),
    );
    expect(result.type).toBe("cached");
    expect(cache.drain(999)).toHaveLength(1);
  });

  test("non-thread message in multi-worker → redirect", () => {
    table.add("w1", "/proj1", 42);
    table.add("w2", "/proj2", 99);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_id: -100123, chat_type: "supergroup", text: "hello" }),
      }),
    );
    expect(result.type).toBe("redirect");
    if (result.type === "redirect") {
      expect(result.chatId).toBe(-100123);
    }
  });

  test("no workers → cache under default key", () => {
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_type: "private" }),
      }),
    );
    expect(result.type).toBe("cached");
  });

  test("callback query in non-thread multi-worker → ack", () => {
    table.add("w1", "/proj1", 42);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        callback_query: makeCallbackQuery({
          id: "cb1",
          message: makeMsg({ chat_id: -100123, chat_type: "supergroup" }),
        }),
      }),
    );
    expect(result.type).toBe("ack_callback");
    if (result.type === "ack_callback") {
      expect(result.callbackQueryId).toBe("cb1");
    }
  });

  test("service message (no content) in multi-worker → drop", () => {
    table.add("w1", "/proj1", 42);
    table.add("w2", "/proj2", 99);
    const result = routeUpdate(
      table,
      cache,
      makeUpdate({
        update_id: 1,
        message: makeMsg({ chat_id: -100123, chat_type: "supergroup", new_chat_members: [] }),
      }),
    );
    expect(result.type).toBe("drop");
  });
});
