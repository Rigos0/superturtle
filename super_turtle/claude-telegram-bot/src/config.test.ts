import { describe, expect, it } from "bun:test";
import { resolve } from "path";

type ConfigProbeResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ConfigProbeOverrides = {
  codexEnabled?: string | undefined;
  metaCodexSandboxMode?: string | undefined;
  metaCodexApprovalPolicy?: string | undefined;
  metaCodexNetworkAccess?: string | undefined;
  dashboardEnabled?: string | undefined;
  showToolStatus?: string | undefined;
  defaultClaudeModel?: string | undefined;
  defaultClaudeEffort?: string | undefined;
  defaultCodexModel?: string | undefined;
  defaultCodexEffort?: string | undefined;
  mainProvider?: string | undefined;
  dashboardPort?: string | undefined;
  dashboardHost?: string | undefined;
  telegramForumChatId?: string | undefined;
  telegramThreadId?: string | undefined;
};

const configPath = resolve(import.meta.dir, "config.ts");

const MARKERS = {
  codexEnabled: "__CODEX_ENABLED__=",
  sandboxMode: "__META_CODEX_SANDBOX_MODE__=",
  approvalPolicy: "__META_CODEX_APPROVAL_POLICY__=",
  networkAccess: "__META_CODEX_NETWORK_ACCESS__=",
  dashboardEnabled: "__DASHBOARD_ENABLED__=",
  dashboardPort: "__DASHBOARD_PORT__=",
  dashboardPublicBaseUrl: "__DASHBOARD_PUBLIC_BASE_URL__=",
  showToolStatus: "__SHOW_TOOL_STATUS__=",
  defaultClaudeModel: "__DEFAULT_CLAUDE_MODEL__=",
  defaultClaudeEffort: "__DEFAULT_CLAUDE_EFFORT__=",
  defaultCodexModel: "__DEFAULT_CODEX_MODEL__=",
  defaultCodexEffort: "__DEFAULT_CODEX_EFFORT__=",
  mainProvider: "__MAIN_PROVIDER__=",
  forumChatId: "__TELEGRAM_FORUM_CHAT_ID__=",
  threadId: "__TELEGRAM_THREAD_ID__=",
} as const;

async function probeConfig(overrides: ConfigProbeOverrides): Promise<ConfigProbeResult> {
  const env: Record<string, string> = {
    ...process.env,
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_ALLOWED_USERS: "123",
    CLAUDE_WORKING_DIR: process.cwd(),
  };

  const applyOverride = (envKey: string, value: string | undefined) => {
    if (value === undefined) {
      delete env[envKey];
      return;
    }
    env[envKey] = value;
  };

  applyOverride("CODEX_ENABLED", overrides.codexEnabled);
  applyOverride("META_CODEX_SANDBOX_MODE", overrides.metaCodexSandboxMode);
  applyOverride("META_CODEX_APPROVAL_POLICY", overrides.metaCodexApprovalPolicy);
  applyOverride("META_CODEX_NETWORK_ACCESS", overrides.metaCodexNetworkAccess);
  applyOverride("DASHBOARD_ENABLED", overrides.dashboardEnabled);
  applyOverride("SHOW_TOOL_STATUS", overrides.showToolStatus);
  applyOverride("DEFAULT_CLAUDE_MODEL", overrides.defaultClaudeModel);
  applyOverride("DEFAULT_CLAUDE_EFFORT", overrides.defaultClaudeEffort);
  applyOverride("DEFAULT_CODEX_MODEL", overrides.defaultCodexModel);
  applyOverride("DEFAULT_CODEX_EFFORT", overrides.defaultCodexEffort);
  applyOverride("MAIN_PROVIDER", overrides.mainProvider);
  applyOverride("DASHBOARD_PORT", overrides.dashboardPort);
  applyOverride("DASHBOARD_HOST", overrides.dashboardHost);
  applyOverride("TELEGRAM_FORUM_CHAT_ID", overrides.telegramForumChatId);
  applyOverride("TELEGRAM_THREAD_ID", overrides.telegramThreadId);

  const script = `
    const config = await import(${JSON.stringify(configPath)});
    console.log(${JSON.stringify(MARKERS.codexEnabled)} + String(config.CODEX_ENABLED));
    console.log(${JSON.stringify(MARKERS.sandboxMode)} + String(config.META_CODEX_SANDBOX_MODE));
    console.log(${JSON.stringify(MARKERS.approvalPolicy)} + String(config.META_CODEX_APPROVAL_POLICY));
    console.log(${JSON.stringify(MARKERS.networkAccess)} + String(config.META_CODEX_NETWORK_ACCESS));
    console.log(${JSON.stringify(MARKERS.dashboardEnabled)} + String(config.DASHBOARD_ENABLED));
    console.log(${JSON.stringify(MARKERS.dashboardPort)} + String(config.DASHBOARD_PORT));
    console.log(${JSON.stringify(MARKERS.dashboardPublicBaseUrl)} + String(config.DASHBOARD_PUBLIC_BASE_URL));
    console.log(${JSON.stringify(MARKERS.showToolStatus)} + String(config.SHOW_TOOL_STATUS));
    console.log(${JSON.stringify(MARKERS.defaultClaudeModel)} + String(config.DEFAULT_CLAUDE_MODEL));
    console.log(${JSON.stringify(MARKERS.defaultClaudeEffort)} + String(config.DEFAULT_CLAUDE_EFFORT));
    console.log(${JSON.stringify(MARKERS.defaultCodexModel)} + String(config.DEFAULT_CODEX_MODEL));
    console.log(${JSON.stringify(MARKERS.defaultCodexEffort)} + String(config.DEFAULT_CODEX_EFFORT));
    console.log(${JSON.stringify(MARKERS.mainProvider)} + String(config.MAIN_PROVIDER));
    console.log(${JSON.stringify(MARKERS.forumChatId)} + String(config.TELEGRAM_FORUM_CHAT_ID));
    console.log(${JSON.stringify(MARKERS.threadId)} + String(config.TELEGRAM_THREAD_ID));
  `;

  const proc = Bun.spawn({
    cmd: ["bun", "--no-env-file", "-e", script],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

function extractMarker(stdout: string, marker: string): string | null {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(marker));

  return line ? line.slice(marker.length) : null;
}

function expectedDashboardPort(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash * 31) + seed.charCodeAt(index)) >>> 0;
  }
  return String(46000 + (hash % 1000));
}

describe("config defaults", () => {
  it("uses expected default runtime values when env vars are unset", async () => {
    const result = await probeConfig({
      codexEnabled: undefined,
      metaCodexSandboxMode: undefined,
      metaCodexApprovalPolicy: undefined,
      metaCodexNetworkAccess: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.codexEnabled)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.sandboxMode)).toBe("workspace-write");
    expect(extractMarker(result.stdout, MARKERS.approvalPolicy)).toBe("never");
    expect(extractMarker(result.stdout, MARKERS.networkAccess)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.dashboardEnabled)).toBe("true");
    expect(extractMarker(result.stdout, MARKERS.dashboardPort)).toBe(expectedDashboardPort(`test-token.${process.cwd()}`));
    expect(extractMarker(result.stdout, MARKERS.dashboardPublicBaseUrl)).toBe(
      `http://localhost:${expectedDashboardPort(`test-token.${process.cwd()}`)}`
    );
    expect(extractMarker(result.stdout, MARKERS.showToolStatus)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeModel)).toBe("claude-opus-4-6");
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeEffort)).toBe("high");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexModel)).toBe("gpt-5.3-codex");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexEffort)).toBe("medium");
    expect(extractMarker(result.stdout, MARKERS.mainProvider)).toBe("claude");
  });
});

describe("config overrides", () => {
  it("accepts explicit valid Codex runtime policy values", async () => {
    const result = await probeConfig({
      codexEnabled: "true",
      metaCodexSandboxMode: "workspace-write",
      metaCodexApprovalPolicy: "on-request",
      metaCodexNetworkAccess: "false",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.codexEnabled)).toBe("true");
    expect(extractMarker(result.stdout, MARKERS.sandboxMode)).toBe("workspace-write");
    expect(extractMarker(result.stdout, MARKERS.approvalPolicy)).toBe("on-request");
    expect(extractMarker(result.stdout, MARKERS.networkAccess)).toBe("false");
  });

  it("lets operators disable the dashboard explicitly", async () => {
    const result = await probeConfig({
      dashboardEnabled: "false",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.dashboardEnabled)).toBe("false");
  });

  it("accepts explicit tool status visibility override", async () => {
    const result = await probeConfig({
      showToolStatus: "true",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.showToolStatus)).toBe("true");
  });

  it("accepts explicit valid default model and effort overrides", async () => {
    const result = await probeConfig({
      defaultClaudeModel: "claude-sonnet-4-6",
      defaultClaudeEffort: "medium",
      defaultCodexModel: "gpt-5.3-codex-spark",
      defaultCodexEffort: "low",
      mainProvider: "codex",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeModel)).toBe("claude-sonnet-4-6");
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeEffort)).toBe("medium");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexModel)).toBe("gpt-5.3-codex-spark");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexEffort)).toBe("low");
    expect(extractMarker(result.stdout, MARKERS.mainProvider)).toBe("codex");
  });

  it("falls back to safe defaults for invalid policy values", async () => {
    const result = await probeConfig({
      metaCodexSandboxMode: "invalid-mode",
      metaCodexApprovalPolicy: "always-ask",
      metaCodexNetworkAccess: "maybe",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.sandboxMode)).toBe("workspace-write");
    expect(extractMarker(result.stdout, MARKERS.approvalPolicy)).toBe("never");
    expect(extractMarker(result.stdout, MARKERS.networkAccess)).toBe("false");
  });

  it("falls back to built-in defaults for invalid default model and effort values", async () => {
    const result = await probeConfig({
      defaultClaudeModel: "claude-bad-model",
      defaultClaudeEffort: "turbo",
      defaultCodexModel: "gpt-bad-codex",
      defaultCodexEffort: "ultra",
      mainProvider: "gemini",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeModel)).toBe("claude-opus-4-6");
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeEffort)).toBe("high");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexModel)).toBe("gpt-5.3-codex");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexEffort)).toBe("medium");
    expect(extractMarker(result.stdout, MARKERS.mainProvider)).toBe("claude");
  });
});

describe("forum topic routing config", () => {
  it("defaults to null when env vars are unset", async () => {
    const result = await probeConfig({
      telegramForumChatId: undefined,
      telegramThreadId: undefined,
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.forumChatId)).toBe("null");
    expect(extractMarker(result.stdout, MARKERS.threadId)).toBe("null");
  });

  it("parses valid chat ID and thread ID", async () => {
    const result = await probeConfig({
      telegramForumChatId: "-1003792037700",
      telegramThreadId: "42",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.forumChatId)).toBe("-1003792037700");
    expect(extractMarker(result.stdout, MARKERS.threadId)).toBe("42");
  });

  it("returns null for non-numeric values", async () => {
    const result = await probeConfig({
      telegramForumChatId: "not-a-number",
      telegramThreadId: "abc",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.forumChatId)).toBe("null");
    expect(extractMarker(result.stdout, MARKERS.threadId)).toBe("null");
  });

  it("returns null for empty strings", async () => {
    const result = await probeConfig({
      telegramForumChatId: "",
      telegramThreadId: "",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.forumChatId)).toBe("null");
    expect(extractMarker(result.stdout, MARKERS.threadId)).toBe("null");
  });

  it("handles whitespace-padded values", async () => {
    const result = await probeConfig({
      telegramForumChatId: "  -1003792037700  ",
      telegramThreadId: "  7  ",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.forumChatId)).toBe("-1003792037700");
    expect(extractMarker(result.stdout, MARKERS.threadId)).toBe("7");
  });
});
