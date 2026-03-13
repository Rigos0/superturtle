#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { dirname, resolve } = require("path");
const { spawn, spawnSync } = require("child_process");

const REPO_ROOT = resolve(__dirname, "..", "..");
const HELPER_PATH = resolve(REPO_ROOT, "super_turtle", "bin", "teleport-e2b.js");

function writeExecutable(path, body) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, body, { mode: 0o755 });
}

function createFakeSdkModule(tmpDir, exportStyle) {
  const sdkPath = resolve(tmpDir, `fake-e2b-${exportStyle}.mjs`);
  writeExecutable(
    sdkPath,
    `import { spawnSync } from "child_process";
import fs from "fs";
import { dirname, resolve } from "path";

const sandboxRoot = process.env.FAKE_E2B_SANDBOX_ROOT;
const logPath = process.env.FAKE_E2B_LOG_PATH;
const failMainCommand = process.env.FAKE_E2B_FAIL_MAIN_COMMAND === "1";

function mapPath(remotePath) {
  return resolve(sandboxRoot, "." + remotePath);
}

function appendLog(entry) {
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\\n");
}

class FakeSandbox {
  constructor(sandboxId) {
    this.sandboxId = sandboxId;
    this.files = {
      write: async (destinationPath, data) => {
        const mappedPath = mapPath(destinationPath);
        fs.mkdirSync(dirname(mappedPath), { recursive: true });
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        fs.writeFileSync(mappedPath, payload);
        appendLog({
          type: "write",
          sandboxId: this.sandboxId,
          destinationPath,
          mappedPath,
          contentBase64: payload.toString("base64"),
        });
      },
    };
    this.commands = {
      run: async (command, options = {}) => {
        appendLog({
          type: "run",
          sandboxId: this.sandboxId,
          command,
          cwd: options.cwd || null,
          timeoutMs: options.timeoutMs || null,
        });

        const mkdirMatch = command.match(/^mkdir -p '(.+)'$/);
        if (mkdirMatch) {
          fs.mkdirSync(mapPath(mkdirMatch[1]), { recursive: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        const removeMatch = command.match(/^rm -f '(.+)'$/);
        if (removeMatch) {
          fs.rmSync(mapPath(removeMatch[1]), { force: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        const removeDirectoryMatch = command.match(/^rm -rf '([^']+)'$/);
        if (removeDirectoryMatch) {
          fs.rmSync(mapPath(removeDirectoryMatch[1]), { recursive: true, force: true });
          return { exitCode: 0, stdout: "", stderr: "" };
        }

        const archiveExtractMatch = command.match(/^tar -xzf '([^']+)' -C '([^']+)'$/);
        if (archiveExtractMatch) {
          const archivePath = archiveExtractMatch[1];
          const destinationDir = archiveExtractMatch[2];
          const result = spawnSync("tar", ["-xzf", mapPath(archivePath), "-C", mapPath(destinationDir)], {
            stdio: "pipe",
          });
          return {
            exitCode: result.status || 0,
            stdout: result.stdout.toString("utf-8"),
            stderr: result.stderr.toString("utf-8"),
          };
        }

        if (typeof options.onStdout === "function") {
          options.onStdout({ text: "stream stdout\\n" });
        }
        if (typeof options.onStderr === "function") {
          options.onStderr(Buffer.from("stream stderr\\n"));
        }

        if (failMainCommand) {
          return {
            exitCode: 17,
            stdout: "failed stdout\\n",
            stderr: "failed stderr\\n",
          };
        }

        return {
          exitCode: 0,
          stdout: "completed stdout\\n",
          stderr: "completed stderr\\n",
        };
      },
    };
  }

  static async connect(sandboxId) {
    appendLog({ type: "connect", sandboxId });
    return new FakeSandbox(sandboxId);
  }
}

${exportStyle === "default" ? "export default FakeSandbox;\n" : "export { FakeSandbox as Sandbox };\n"}`
  );
  return sdkPath;
}

function runHelper(args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", [HELPER_PATH, ...args], {
      cwd: REPO_ROOT,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });

    child.stdin.end(options.stdin || "");
  });
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs.readFileSync(logPath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function testUploadFileUsesSandboxSdk(tmpDir) {
  const sandboxRoot = resolve(tmpDir, "sandbox-upload");
  const logPath = resolve(tmpDir, "upload.log.jsonl");
  const sdkPath = createFakeSdkModule(tmpDir, "named");
  const sourcePath = resolve(tmpDir, "handoff.txt");
  fs.writeFileSync(sourcePath, "semantic handoff\n");

  const result = await runHelper(
    ["upload-file", "--sandbox-id", "sandbox_upload", "--source", sourcePath, "--destination", "/workspace/state/handoff.txt"],
    {
      env: {
        ...process.env,
        SUPERTURTLE_TELEPORT_E2B_SDK_PATH: sdkPath,
        FAKE_E2B_SANDBOX_ROOT: sandboxRoot,
        FAKE_E2B_LOG_PATH: logPath,
      },
    }
  );

  assert.strictEqual(result.code, 0, result.stderr);
  assert.strictEqual(fs.readFileSync(resolve(sandboxRoot, "workspace", "state", "handoff.txt"), "utf-8"), "semantic handoff\n");

  const logEntries = readLog(logPath);
  assert.deepStrictEqual(
    logEntries.map((entry) => entry.type),
    ["connect", "run", "write"]
  );
  assert.strictEqual(logEntries[0].sandboxId, "sandbox_upload");
  assert.match(logEntries[1].command, /^mkdir -p '\/workspace\/state'$/);
  assert.strictEqual(logEntries[2].destinationPath, "/workspace/state/handoff.txt");
}

async function testSyncArchiveUploadsAndExtractsRepoArchive(tmpDir) {
  const sandboxRoot = resolve(tmpDir, "sandbox-sync");
  const logPath = resolve(tmpDir, "sync.log.jsonl");
  const sdkPath = createFakeSdkModule(tmpDir, "named");
  const archiveSourceDir = resolve(tmpDir, "archive-source");
  const archivePath = resolve(tmpDir, "repo.tar.gz");

  fs.mkdirSync(resolve(archiveSourceDir, "runtime-import"), { recursive: true });
  fs.writeFileSync(resolve(archiveSourceDir, "runtime-import", "handoff.txt"), "semantic continuity\n");
  fs.writeFileSync(resolve(archiveSourceDir, "README.md"), "sandbox sync\n");

  const archiveResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveSourceDir, "."], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  assert.strictEqual(archiveResult.status, 0, archiveResult.stderr.toString("utf-8"));

  const result = await runHelper(
    [
      "sync-archive",
      "--sandbox-id",
      "sandbox_sync",
      "--source",
      archivePath,
      "--remote-root",
      "/workspace/project",
      "--archive-path",
      "/tmp/custom-sync.tar.gz",
    ],
    {
      env: {
        ...process.env,
        SUPERTURTLE_TELEPORT_E2B_SDK_PATH: sdkPath,
        FAKE_E2B_SANDBOX_ROOT: sandboxRoot,
        FAKE_E2B_LOG_PATH: logPath,
      },
    }
  );

  assert.strictEqual(result.code, 0, result.stderr);
  assert.strictEqual(fs.readFileSync(resolve(sandboxRoot, "workspace", "project", "runtime-import", "handoff.txt"), "utf-8"), "semantic continuity\n");
  assert.strictEqual(fs.readFileSync(resolve(sandboxRoot, "workspace", "project", "README.md"), "utf-8"), "sandbox sync\n");
  assert.ok(!fs.existsSync(resolve(sandboxRoot, "tmp", "custom-sync.tar.gz")), "expected temporary archive cleanup");

  const logEntries = readLog(logPath);
  assert.deepStrictEqual(
    logEntries.map((entry) => entry.type),
    ["connect", "run", "write", "run", "run", "run", "run", "run"]
  );
  assert.match(logEntries[1].command, /^mkdir -p '\/tmp'$/);
  assert.strictEqual(logEntries[2].destinationPath, "/tmp/custom-sync.tar.gz");
  assert.strictEqual(logEntries[3].command, "mkdir -p '/workspace'");
  assert.strictEqual(logEntries[4].command, "rm -rf '/workspace/project'");
  assert.strictEqual(logEntries[5].command, "mkdir -p '/workspace/project'");
  assert.strictEqual(logEntries[6].command, "tar -xzf '/tmp/custom-sync.tar.gz' -C '/workspace/project'");
  assert.strictEqual(logEntries[7].command, "rm -f '/tmp/custom-sync.tar.gz'");
}

async function testExtractArchiveMergesIntoExistingDestination(tmpDir) {
  const sandboxRoot = resolve(tmpDir, "sandbox-extract");
  const logPath = resolve(tmpDir, "extract.log.jsonl");
  const sdkPath = createFakeSdkModule(tmpDir, "named");
  const archiveSourceDir = resolve(tmpDir, "extract-source");
  const archivePath = resolve(tmpDir, "auth.tar.gz");

  fs.mkdirSync(resolve(archiveSourceDir, ".codex"), { recursive: true });
  fs.mkdirSync(resolve(sandboxRoot, "home", "user", ".codex"), { recursive: true });
  fs.writeFileSync(resolve(archiveSourceDir, ".codex", "auth.json"), '{"token":"codex-local"}\n');
  fs.writeFileSync(resolve(sandboxRoot, "home", "user", ".codex", "config.toml"), 'model = "gpt-5"\n');

  const archiveResult = spawnSync("tar", ["-czf", archivePath, "-C", archiveSourceDir, "."], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  assert.strictEqual(archiveResult.status, 0, archiveResult.stderr.toString("utf-8"));

  const result = await runHelper(
    [
      "extract-archive",
      "--sandbox-id",
      "sandbox_extract",
      "--source",
      archivePath,
      "--destination-root",
      "/home/user",
      "--archive-path",
      "/tmp/codex-auth.tar.gz",
    ],
    {
      env: {
        ...process.env,
        SUPERTURTLE_TELEPORT_E2B_SDK_PATH: sdkPath,
        FAKE_E2B_SANDBOX_ROOT: sandboxRoot,
        FAKE_E2B_LOG_PATH: logPath,
      },
    }
  );

  assert.strictEqual(result.code, 0, result.stderr);
  assert.strictEqual(
    fs.readFileSync(resolve(sandboxRoot, "home", "user", ".codex", "auth.json"), "utf-8"),
    '{"token":"codex-local"}\n'
  );
  assert.strictEqual(
    fs.readFileSync(resolve(sandboxRoot, "home", "user", ".codex", "config.toml"), "utf-8"),
    'model = "gpt-5"\n'
  );
  assert.ok(!fs.existsSync(resolve(sandboxRoot, "tmp", "codex-auth.tar.gz")), "expected temporary archive cleanup");

  const logEntries = readLog(logPath);
  assert.deepStrictEqual(
    logEntries.map((entry) => entry.type),
    ["connect", "run", "write", "run", "run", "run"]
  );
  assert.match(logEntries[1].command, /^mkdir -p '\/tmp'$/);
  assert.strictEqual(logEntries[2].destinationPath, "/tmp/codex-auth.tar.gz");
  assert.strictEqual(logEntries[3].command, "mkdir -p '/home/user'");
  assert.strictEqual(logEntries[4].command, "tar -xzf '/tmp/codex-auth.tar.gz' -C '/home/user'");
  assert.strictEqual(logEntries[5].command, "rm -f '/tmp/codex-auth.tar.gz'");
}

async function testRunScriptUsesDefaultExportAndCleansUpTempScript(tmpDir) {
  const sandboxRoot = resolve(tmpDir, "sandbox-run");
  const logPath = resolve(tmpDir, "run.log.jsonl");
  const sdkPath = createFakeSdkModule(tmpDir, "default");
  const scriptBody = "echo remote bootstrap\n";

  const result = await runHelper(
    ["run-script", "--sandbox-id", "sandbox_run", "--cwd", "/workspace", "--timeout-ms", "4321", "--", "bash", "-s", "--", "alpha", "beta"],
    {
      stdin: scriptBody,
      env: {
        ...process.env,
        SUPERTURTLE_TELEPORT_E2B_SDK_PATH: sdkPath,
        FAKE_E2B_SANDBOX_ROOT: sandboxRoot,
        FAKE_E2B_LOG_PATH: logPath,
      },
    }
  );

  assert.strictEqual(result.code, 0, result.stderr);
  assert.match(result.stdout, /stream stdout/);
  assert.match(result.stderr, /stream stderr/);

  const logEntries = readLog(logPath);
  assert.strictEqual(logEntries[0].type, "connect");
  const writeEntry = logEntries.find((entry) => entry.type === "write" && /^\/tmp\/superturtle-teleport-/.test(entry.destinationPath));
  assert.ok(writeEntry, "expected temporary remote script to be written");
  assert.strictEqual(Buffer.from(writeEntry.contentBase64, "base64").toString("utf-8"), scriptBody);

  const mainRunEntry = logEntries.find(
    (entry) => entry.type === "run" && entry.command.startsWith("'bash' '/tmp/superturtle-teleport-")
  );
  assert.ok(mainRunEntry, "expected remote script invocation");
  assert.strictEqual(mainRunEntry.cwd, "/workspace");
  assert.strictEqual(mainRunEntry.timeoutMs, 4321);
  assert.match(mainRunEntry.command, /'alpha' 'beta'$/);

  const cleanupEntry = logEntries.find(
    (entry) => entry.type === "run" && entry.command === `rm -f '${writeEntry.destinationPath}'`
  );
  assert.ok(cleanupEntry, "expected remote script cleanup");
}

async function testRunScriptSurfacesCommandFailure(tmpDir) {
  const sandboxRoot = resolve(tmpDir, "sandbox-failure");
  const logPath = resolve(tmpDir, "failure.log.jsonl");
  const sdkPath = createFakeSdkModule(tmpDir, "named");

  const result = await runHelper(
    ["run-script", "--sandbox-id", "sandbox_fail", "--", "bash", "-s"],
    {
      stdin: "exit 17\n",
      env: {
        ...process.env,
        SUPERTURTLE_TELEPORT_E2B_SDK_PATH: sdkPath,
        FAKE_E2B_SANDBOX_ROOT: sandboxRoot,
        FAKE_E2B_LOG_PATH: logPath,
        FAKE_E2B_FAIL_MAIN_COMMAND: "1",
      },
    }
  );

  assert.strictEqual(result.code, 1, `expected helper failure, got stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /failed stderr/);

  const logEntries = readLog(logPath);
  const writeEntry = logEntries.find((entry) => entry.type === "write" && /^\/tmp\/superturtle-teleport-/.test(entry.destinationPath));
  assert.ok(writeEntry, "expected temporary remote script write before failure");
  assert.ok(
    logEntries.some((entry) => entry.type === "run" && entry.command === `rm -f '${writeEntry.destinationPath}'`),
    "expected cleanup even after command failure"
  );
}

async function main() {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-teleport-e2b-"));
  try {
    await testUploadFileUsesSandboxSdk(resolve(tmpDir, "upload"));
    await testSyncArchiveUploadsAndExtractsRepoArchive(resolve(tmpDir, "sync"));
    await testExtractArchiveMergesIntoExistingDestination(resolve(tmpDir, "extract"));
    await testRunScriptUsesDefaultExportAndCleansUpTempScript(resolve(tmpDir, "run"));
    await testRunScriptSurfacesCommandFailure(resolve(tmpDir, "failure"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
