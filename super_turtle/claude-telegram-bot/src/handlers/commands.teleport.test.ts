import { afterEach, describe, expect, it, mock } from "bun:test";

type ReplyRecord = {
  text: string;
};

function makeCtx(messageText: string) {
  const replies: ReplyRecord[] = [];
  return {
    ctx: {
      from: { id: 123 },
      chat: { id: 456 },
      message: { text: messageText },
      reply: async (text: string) => {
        replies.push({ text });
        return {
          chat: { id: 456 },
          message_id: replies.length,
        };
      },
    },
    replies,
  };
}

async function loadCommandsModule() {
  const actualConfig = await import("../config");
  mock.module("../config", () => ({
    ...actualConfig,
    ALLOWED_USERS: [123],
  }));

  return import(`./commands.ts?teleport-disabled-test=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  mock.restore();
});

describe("teleport commands", () => {
  it("fails /teleport with the branch-level disabled message", async () => {
    const { handleTeleport } = await loadCommandsModule();
    const { ctx, replies } = makeCtx("/teleport");

    await handleTeleport(ctx as never);

    expect(replies).toEqual([
      {
        text: "ℹ️ Teleport is disabled in this branch. Use SUPERTURTLE_RUNTIME_PROFILE=managed for the managed E2B runtime.",
      },
    ]);
  });

  it("fails /home with the branch-level disabled message", async () => {
    const { handleHome } = await loadCommandsModule();
    const { ctx, replies } = makeCtx("/home");

    await handleHome(ctx as never);

    expect(replies).toEqual([
      {
        text: "ℹ️ Teleport is disabled in this branch. Use SUPERTURTLE_RUNTIME_PROFILE=managed for the managed E2B runtime.",
      },
    ]);
  });
});
