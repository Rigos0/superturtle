import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

process.env.TELEGRAM_BOT_TOKEN ||= "test-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "123";
process.env.CLAUDE_WORKING_DIR ||= process.cwd();

const { getTelegramCommandsForRuntime, parseExactSelfUpdateSpec, parseSelfUpdateRequest } =
  await import("./commands");

describe("/update command helpers", () => {
  it("requires an exact immutable superturtle package version", () => {
    expect(parseExactSelfUpdateSpec("superturtle@0.2.9-beta.143.1")).toEqual({
      installSpec: "superturtle@0.2.9-beta.143.1",
      version: "0.2.9-beta.143.1",
    });
    expect(parseExactSelfUpdateSpec("superturtle@managed-codex")).toBeNull();
    expect(parseExactSelfUpdateSpec("latest")).toBeNull();
  });

  it("defaults to a configured dist-tag and accepts explicit tags", () => {
    expect(parseSelfUpdateRequest(undefined, "managed-codex")).toEqual({
      kind: "dist-tag",
      distTag: "managed-codex",
    });
    expect(parseSelfUpdateRequest("managed-codex", "latest")).toEqual({
      kind: "dist-tag",
      distTag: "managed-codex",
    });
    expect(parseSelfUpdateRequest("superturtle@managed-codex", "latest")).toEqual({
      kind: "dist-tag",
      distTag: "managed-codex",
    });
  });

  it("exposes /update only on remote command surfaces", () => {
    expect(getTelegramCommandsForRuntime("local", "agent").map(({ command }) => command)).not.toContain("update");
    expect(getTelegramCommandsForRuntime("teleport-remote", "control").map(({ command }) => command)).toContain("update");
    expect(getTelegramCommandsForRuntime("teleport-remote", "agent").map(({ command }) => command)).toContain("update");
  });
});

describe("/update handoff", () => {
  it("writes pending update state and spawns the detached helper", async () => {
    const projectRoot = resolve(import.meta.dir, "../..");
    const tempRoot = mkdtempSync(join(tmpdir(), "superturtle-update-"));
    const workdir = join(tempRoot, "project");
    const dataDir = join(workdir, ".superturtle");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "service.pid"), "4242\n", "utf-8");

    const marker = "__UPDATE_PROBE__=";
    const script = `
      const { mkdirSync, writeFileSync, readFileSync } = await import("fs");
      const { join } = await import("path");

      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      process.env.TELEGRAM_ALLOWED_USERS = "123";
      process.env.CLAUDE_WORKING_DIR = ${JSON.stringify(workdir)};
      process.env.SUPERTURTLE_RUNTIME_ROLE = "teleport-remote";
      process.env.SUPERTURTLE_REMOTE_MODE = "agent";
      process.env.SUPERTURTLE_RUNTIME_UPDATE_DIST_TAG = "managed-codex";
      process.env.CODEX_ENABLED = "false";
      process.env.CODEX_CLI_AVAILABLE_OVERRIDE = "false";

      const dataDir = join(process.env.CLAUDE_WORKING_DIR, ".superturtle");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "service.pid"), "4242\\n", "utf-8");

      let spawnCmd = [];
      let spawnOpts = null;
      let unrefCalled = false;
      const originalSpawnSync = Bun.spawnSync;

      Bun.sleep = async () => {};
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          "managed-codex": "9.9.9-beta.1",
        }),
      });
      Bun.spawnSync = ((cmd, opts) => {
        const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
        if (parts[0] === "kill" && parts[1] === "-0" && parts[2] === "4242") {
          return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
        }
        if (parts[0]?.endsWith("/subturtle/ctl") && parts[1] === "list") {
          return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
        }
        return originalSpawnSync(cmd, opts);
      });

      Bun.spawn = (cmd, opts) => {
        spawnCmd = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
        spawnOpts = opts ?? null;
        return {
          pid: 9876,
          unref: () => {
            unrefCalled = true;
          },
        };
      };

      const { handleUpdate } = await import("./src/handlers/commands.ts");

      const replies = [];
      const ctx = {
        from: { id: 123 },
        chat: { id: 456 },
        message: { text: "/update" },
        reply: async (text) => {
          replies.push(String(text));
          return { message_id: 789 };
        },
      };

      await handleUpdate(ctx);
      const state = JSON.parse(readFileSync(join(dataDir, "self-update.json"), "utf-8"));
      console.log(${JSON.stringify(marker)} + JSON.stringify({
        replies,
        state,
        spawnCmd,
        spawnOpts,
        unrefCalled,
      }));
    `;

    const proc = Bun.spawn({
      cmd: ["bun", "--no-env-file", "-e", script],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_ALLOWED_USERS: "123",
        CLAUDE_WORKING_DIR: workdir,
        SUPERTURTLE_RUNTIME_ROLE: "teleport-remote",
        SUPERTURTLE_REMOTE_MODE: "agent",
        CODEX_ENABLED: "false",
        CODEX_CLI_AVAILABLE_OVERRIDE: "false",
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`update probe failed:\\n${stderr || stdout}`);
    }

    const payloadLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(marker));
    expect(payloadLine).toBeTruthy();
    const payload = JSON.parse(payloadLine!.slice(marker.length)) as {
      replies: string[];
      state: Record<string, unknown>;
      spawnCmd: string[];
      spawnOpts: {
        cwd?: string;
        stdin?: string;
        stdout?: string;
        stderr?: string;
        detached?: boolean;
      } | null;
      unrefCalled: boolean;
    };

    expect(payload.replies[0]).toContain("Updating remote runtime to superturtle@9.9.9-beta.1");
    expect(payload.replies[0]).toContain("Resolved from npm dist-tag `managed-codex`");
    expect(payload.state.status).toBe("pending");
    expect(payload.state.requested_spec).toBe("superturtle@9.9.9-beta.1");
    expect(payload.state.target_version).toBe("9.9.9-beta.1");
    expect(payload.state.helper_pid).toBe(9876);
    expect(payload.state.service_pid).toBe(4242);
    expect(payload.spawnCmd).toContain("self-update-runner");
    expect(payload.spawnCmd).toContain("superturtle@9.9.9-beta.1");
    expect(payload.spawnOpts?.detached).toBe(true);
    expect(payload.spawnOpts?.stdin).toBe("ignore");
    expect(payload.spawnOpts?.stdout).toBe("ignore");
    expect(payload.spawnOpts?.stderr).toBe("ignore");
    expect(payload.unrefCalled).toBe(true);

    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("discovers the remote service runner from the current process ancestry when service.pid is missing", async () => {
    const projectRoot = resolve(import.meta.dir, "../..");
    const tempRoot = mkdtempSync(join(tmpdir(), "superturtle-update-"));
    const workdir = join(tempRoot, "project");
    const dataDir = join(workdir, ".superturtle");
    mkdirSync(dataDir, { recursive: true });

    const marker = "__UPDATE_ANCESTRY_PROBE__=";
    const script = `
      const { mkdirSync, writeFileSync, readFileSync } = await import("fs");
      const { join } = await import("path");

      process.env.TELEGRAM_BOT_TOKEN = "test-token";
      process.env.TELEGRAM_ALLOWED_USERS = "123";
      process.env.CLAUDE_WORKING_DIR = ${JSON.stringify(workdir)};
      process.env.SUPERTURTLE_RUNTIME_ROLE = "teleport-remote";
      process.env.SUPERTURTLE_REMOTE_MODE = "agent";
      process.env.SUPERTURTLE_RUNTIME_UPDATE_DIST_TAG = "managed-codex";
      process.env.CODEX_ENABLED = "false";
      process.env.CODEX_CLI_AVAILABLE_OVERRIDE = "false";

      const dataDir = join(process.env.CLAUDE_WORKING_DIR, ".superturtle");
      mkdirSync(dataDir, { recursive: true });

      let spawnCmd = [];
      let unrefCalled = false;
      const originalSpawnSync = Bun.spawnSync;
      const processPid = process.pid;

      Bun.sleep = async () => {};
      globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          "managed-codex": "9.9.9-beta.2",
        }),
      });
      Bun.spawnSync = ((cmd, opts) => {
        const parts = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
        if (parts[0] === "kill" && parts[1] === "-0" && parts[2] === "4242") {
          return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
        }
        if (parts[0] === "ps" && parts[1] === "-o" && parts[5] === "-p") {
          const pid = parts[6];
          if (pid === String(processPid)) {
            return { exitCode: 0, stdout: Buffer.from("7777 bun run src/index.ts\\n"), stderr: Buffer.from("") };
          }
          if (pid === "7777") {
            return { exitCode: 0, stdout: Buffer.from("4242 /bin/bash ./run-loop.sh\\n"), stderr: Buffer.from("") };
          }
          if (pid === "4242") {
            const command = ["/usr/local/bin/node", "/workspace/bin/superturtle.js", "service", "run", "--cwd", "/workspace"].join(" ");
            return { exitCode: 0, stdout: Buffer.from(\`1 \${command}\\n\`), stderr: Buffer.from("") };
          }
        }
        if (parts[0]?.endsWith("/subturtle/ctl") && parts[1] === "list") {
          return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
        }
        return originalSpawnSync(cmd, opts);
      });

      Bun.spawn = (cmd, opts) => {
        spawnCmd = Array.isArray(cmd) ? cmd.map((part) => String(part)) : [String(cmd)];
        return {
          pid: 9877,
          unref: () => {
            unrefCalled = true;
          },
        };
      };

      const { handleUpdate } = await import("./src/handlers/commands.ts");

      const replies = [];
      const ctx = {
        from: { id: 123 },
        chat: { id: 456 },
        message: { text: "/update" },
        reply: async (text) => {
          replies.push(String(text));
          return { message_id: 790 };
        },
      };

      await handleUpdate(ctx);
      const state = JSON.parse(readFileSync(join(dataDir, "self-update.json"), "utf-8"));
      console.log(${JSON.stringify(marker)} + JSON.stringify({
        replies,
        state,
        spawnCmd,
        unrefCalled,
      }));
    `;

    const proc = Bun.spawn({
      cmd: ["bun", "--no-env-file", "-e", script],
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_ALLOWED_USERS: "123",
        CLAUDE_WORKING_DIR: workdir,
        SUPERTURTLE_RUNTIME_ROLE: "teleport-remote",
        SUPERTURTLE_REMOTE_MODE: "agent",
        CODEX_ENABLED: "false",
        CODEX_CLI_AVAILABLE_OVERRIDE: "false",
      },
    });

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      throw new Error(`update ancestry probe failed:\\n${stderr || stdout}`);
    }

    const payloadLine = stdout
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.startsWith(marker));
    expect(payloadLine).toBeTruthy();
    const payload = JSON.parse(payloadLine!.slice(marker.length)) as {
      replies: string[];
      state: Record<string, unknown>;
      spawnCmd: string[];
      unrefCalled: boolean;
    };

    expect(payload.replies[0]).toContain("Updating remote runtime to superturtle@9.9.9-beta.2");
    expect(payload.state.service_pid).toBe(4242);
    expect(payload.spawnCmd).toContain("self-update-runner");
    expect(payload.unrefCalled).toBe(true);

    rmSync(tempRoot, { recursive: true, force: true });
  });
});
