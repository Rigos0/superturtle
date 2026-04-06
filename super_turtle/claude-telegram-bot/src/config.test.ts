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
  turtleGreetings?: string | undefined;
  defaultClaudeModel?: string | undefined;
  defaultClaudeEffort?: string | undefined;
  defaultCodexModel?: string | undefined;
  defaultCodexEffort?: string | undefined;
  openrouterApiKey?: string | undefined;
  openrouterModel?: string | undefined;
  runtimeProfile?: string | undefined;
  driver?: string | undefined;
  runtimeRole?: string | undefined;
  remoteMode?: string | undefined;
  managedCloud?: string | undefined;
  remoteDriver?: string | undefined;
  mainProvider?: string | undefined;
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
  turtleGreetingsEnabled: "__TURTLE_GREETINGS_ENABLED__=",
  defaultClaudeModel: "__DEFAULT_CLAUDE_MODEL__=",
  defaultClaudeEffort: "__DEFAULT_CLAUDE_EFFORT__=",
  defaultCodexModel: "__DEFAULT_CODEX_MODEL__=",
  defaultCodexEffort: "__DEFAULT_CODEX_EFFORT__=",
  codexOpenrouterEnabled: "__CODEX_OPENROUTER_ENABLED__=",
  runtimeProfile: "__SUPERTURTLE_RUNTIME_PROFILE__=",
  driver: "__SUPERTURTLE_DRIVER__=",
  runtimeContractError: "__RUNTIME_CONTRACT_ERROR__=",
  mainProvider: "__MAIN_PROVIDER__=",
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
  applyOverride("TURTLE_GREETINGS", overrides.turtleGreetings);
  applyOverride("DEFAULT_CLAUDE_MODEL", overrides.defaultClaudeModel);
  applyOverride("DEFAULT_CLAUDE_EFFORT", overrides.defaultClaudeEffort);
  applyOverride("DEFAULT_CODEX_MODEL", overrides.defaultCodexModel);
  applyOverride("DEFAULT_CODEX_EFFORT", overrides.defaultCodexEffort);
  applyOverride("OPENROUTER_API_KEY", overrides.openrouterApiKey);
  applyOverride("OPENROUTER_MODEL", overrides.openrouterModel);
  applyOverride("SUPERTURTLE_RUNTIME_PROFILE", overrides.runtimeProfile);
  applyOverride("SUPERTURTLE_DRIVER", overrides.driver);
  applyOverride("SUPERTURTLE_RUNTIME_ROLE", overrides.runtimeRole);
  applyOverride("SUPERTURTLE_REMOTE_MODE", overrides.remoteMode);
  applyOverride("SUPERTURTLE_MANAGED_CLOUD", overrides.managedCloud);
  applyOverride("SUPERTURTLE_REMOTE_DRIVER", overrides.remoteDriver);
  applyOverride("MAIN_PROVIDER", overrides.mainProvider);

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
    console.log(${JSON.stringify(MARKERS.turtleGreetingsEnabled)} + String(config.TURTLE_GREETINGS_ENABLED));
    console.log(${JSON.stringify(MARKERS.defaultClaudeModel)} + String(config.DEFAULT_CLAUDE_MODEL));
    console.log(${JSON.stringify(MARKERS.defaultClaudeEffort)} + String(config.DEFAULT_CLAUDE_EFFORT));
    console.log(${JSON.stringify(MARKERS.defaultCodexModel)} + String(config.DEFAULT_CODEX_MODEL));
    console.log(${JSON.stringify(MARKERS.defaultCodexEffort)} + String(config.DEFAULT_CODEX_EFFORT));
    console.log(${JSON.stringify(MARKERS.codexOpenrouterEnabled)} + String(config.CODEX_OPENROUTER_ENABLED));
    console.log(${JSON.stringify(MARKERS.runtimeProfile)} + String(config.SUPERTURTLE_RUNTIME_PROFILE));
    console.log(${JSON.stringify(MARKERS.driver)} + String(config.SUPERTURTLE_DRIVER));
    console.log(${JSON.stringify(MARKERS.runtimeContractError)} + String(config.RUNTIME_CONTRACT_ERROR));
    console.log(${JSON.stringify(MARKERS.mainProvider)} + String(config.MAIN_PROVIDER));
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
    expect(extractMarker(result.stdout, MARKERS.dashboardPort)).toBe(expectedDashboardPort("test-token"));
    expect(extractMarker(result.stdout, MARKERS.dashboardPublicBaseUrl)).toBe(
      `http://localhost:${expectedDashboardPort("test-token")}`
    );
    expect(extractMarker(result.stdout, MARKERS.showToolStatus)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.turtleGreetingsEnabled)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeModel)).toBe("claude-opus-4-6");
    expect(extractMarker(result.stdout, MARKERS.defaultClaudeEffort)).toBe("high");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexModel)).toBe("gpt-5.3-codex");
    expect(extractMarker(result.stdout, MARKERS.defaultCodexEffort)).toBe("medium");
    expect(extractMarker(result.stdout, MARKERS.codexOpenrouterEnabled)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.runtimeProfile)).toBe("local");
    expect(extractMarker(result.stdout, MARKERS.driver)).toBe("claude");
    expect(extractMarker(result.stdout, MARKERS.runtimeContractError)).toBe("null");
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

  it("keeps turtle greetings opt-in", async () => {
    const disabledByDefault = await probeConfig({
      turtleGreetings: undefined,
    });
    const enabledExplicitly = await probeConfig({
      turtleGreetings: "true",
    });

    expect(disabledByDefault.exitCode).toBe(0);
    expect(extractMarker(disabledByDefault.stdout, MARKERS.turtleGreetingsEnabled)).toBe("false");
    expect(enabledExplicitly.exitCode).toBe(0);
    expect(extractMarker(enabledExplicitly.stdout, MARKERS.turtleGreetingsEnabled)).toBe("true");
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
    expect(extractMarker(result.stdout, MARKERS.codexOpenrouterEnabled)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.mainProvider)).toBe("codex");
  });

  it("switches the default Codex model to the configured OpenRouter model", async () => {
    const result = await probeConfig({
      openrouterApiKey: "sk-or-test",
      openrouterModel: "anthropic/claude-3.7-sonnet",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.defaultCodexModel)).toBe(
      "anthropic/claude-3.7-sonnet"
    );
    expect(extractMarker(result.stdout, MARKERS.codexOpenrouterEnabled)).toBe("true");
  });

  it("uses the new runtime contract env vars when provided", async () => {
    const result = await probeConfig({
      runtimeProfile: "managed",
      driver: "codex",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.runtimeProfile)).toBe("managed");
    expect(extractMarker(result.stdout, MARKERS.driver)).toBe("codex");
    expect(extractMarker(result.stdout, MARKERS.runtimeContractError)).toBe("null");
  });

  it("maps legacy managed env vars into the resolved new contract", async () => {
    const result = await probeConfig({
      runtimeRole: "teleport-remote",
      remoteMode: "agent",
      remoteDriver: "codex",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.runtimeProfile)).toBe("managed");
    expect(extractMarker(result.stdout, MARKERS.driver)).toBe("codex");
    expect(extractMarker(result.stdout, MARKERS.runtimeContractError)).toBe("null");
  });

  it("fails legacy teleport control mode through the resolved contract", async () => {
    const result = await probeConfig({
      runtimeRole: "teleport-remote",
      remoteMode: "control",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.runtimeProfile)).toBe("managed");
    expect(extractMarker(result.stdout, MARKERS.runtimeContractError)).toContain(
      "Teleport is disabled in this branch."
    );
  });

  it("marks managed plus claude as unsupported", async () => {
    const result = await probeConfig({
      runtimeProfile: "managed",
      driver: "claude",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.runtimeProfile)).toBe("managed");
    expect(extractMarker(result.stdout, MARKERS.driver)).toBe("claude");
    expect(extractMarker(result.stdout, MARKERS.runtimeContractError)).toContain(
      "Managed runtime currently supports SUPERTURTLE_DRIVER=codex only in this branch."
    );
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
    expect(extractMarker(result.stdout, MARKERS.codexOpenrouterEnabled)).toBe("false");
    expect(extractMarker(result.stdout, MARKERS.mainProvider)).toBe("claude");
  });
});
