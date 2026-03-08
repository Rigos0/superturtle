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
  dashboardPort?: string | undefined;
  dashboardHost?: string | undefined;
};

const configPath = resolve(import.meta.dir, "config.ts");

const MARKERS = {
  codexEnabled: "__CODEX_ENABLED__=",
  sandboxMode: "__META_CODEX_SANDBOX_MODE__=",
  approvalPolicy: "__META_CODEX_APPROVAL_POLICY__=",
  networkAccess: "__META_CODEX_NETWORK_ACCESS__=",
  dashboardPort: "__DASHBOARD_PORT__=",
  dashboardPublicBaseUrl: "__DASHBOARD_PUBLIC_BASE_URL__=",
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
  applyOverride("DASHBOARD_PORT", overrides.dashboardPort);
  applyOverride("DASHBOARD_HOST", overrides.dashboardHost);

  const script = `
    const config = await import(${JSON.stringify(configPath)});
    console.log(${JSON.stringify(MARKERS.codexEnabled)} + String(config.CODEX_ENABLED));
    console.log(${JSON.stringify(MARKERS.sandboxMode)} + String(config.META_CODEX_SANDBOX_MODE));
    console.log(${JSON.stringify(MARKERS.approvalPolicy)} + String(config.META_CODEX_APPROVAL_POLICY));
    console.log(${JSON.stringify(MARKERS.networkAccess)} + String(config.META_CODEX_NETWORK_ACCESS));
    console.log(${JSON.stringify(MARKERS.dashboardPort)} + String(config.DASHBOARD_PORT));
    console.log(${JSON.stringify(MARKERS.dashboardPublicBaseUrl)} + String(config.DASHBOARD_PUBLIC_BASE_URL));
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
    expect(extractMarker(result.stdout, MARKERS.dashboardPort)).toBe(expectedDashboardPort("test-token"));
    expect(extractMarker(result.stdout, MARKERS.dashboardPublicBaseUrl)).toBe(
      `http://localhost:${expectedDashboardPort("test-token")}`
    );
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

  it("accepts explicit dashboard port and host overrides", async () => {
    const result = await probeConfig({
      dashboardPort: "46888",
      dashboardHost: "http://localhost",
    });

    expect(result.exitCode).toBe(0);
    expect(extractMarker(result.stdout, MARKERS.dashboardPort)).toBe("46888");
    expect(extractMarker(result.stdout, MARKERS.dashboardPublicBaseUrl)).toBe("http://localhost:46888");
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
});
