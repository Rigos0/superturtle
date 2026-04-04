import { afterEach, describe, expect, it, mock } from "bun:test";

type ReplyRecord = {
  text: string;
};

function makeVoiceCtx() {
  const replies: ReplyRecord[] = [];
  return {
    ctx: {
      from: { id: 123, username: "tester" },
      chat: { id: 456, type: "private" },
      message: {
        voice: { file_id: "voice-1", duration: 3 },
      },
      reply: async (text: string) => {
        replies.push({ text });
        return { message_id: replies.length, chat: { id: 456 } };
      },
    },
    replies,
  };
}

async function loadVoiceModuleForRemoteAgent() {
  const actualConfig = await import("../config");
  const actualTeleport = await import("../teleport");
  const actualSecurity = await import("../security");
  const actualLogger = await import("../logger");

  mock.module("../config", () => ({
    ...actualConfig,
    ALLOWED_USERS: [123],
    SUPERTURTLE_RUNTIME_ROLE: "teleport-remote",
    SUPERTURTLE_REMOTE_MODE: "agent",
  }));
  mock.module("../teleport", () => ({
    ...actualTeleport,
    isTeleportRemoteRuntime: () => true,
    isTeleportRemoteControlMode: () => false,
    isTeleportRemoteAgentMode: () => true,
    getTeleportRemoteUnsupportedMessage: () =>
      actualTeleport.TELEPORT_AGENT_TEXT_ONLY_MESSAGE,
  }));
  mock.module("../security", () => ({
    ...actualSecurity,
    isAuthorized: () => true,
    rateLimiter: {
      ...actualSecurity.rateLimiter,
      check: () => [true, null],
    },
  }));
  mock.module("../logger", () => ({
    ...actualLogger,
    eventLog: { info() {} },
    streamLog: { child() { return { error() {}, info() {}, warn() {}, debug() {} }; } },
  }));

  return import(`./voice.ts?remote-agent=${Date.now()}-${Math.random()}`);
}

afterEach(() => {
  mock.restore();
});

describe("remote media scope", () => {
  it("returns the text-only message for voice in remote agent mode", async () => {
    const { handleVoice } = await loadVoiceModuleForRemoteAgent();
    const { ctx, replies } = makeVoiceCtx();

    await handleVoice(ctx as never);

    expect(replies).toEqual([
      {
        text: "This managed runtime currently supports text chat only in this branch.",
      },
    ]);
  });
});
