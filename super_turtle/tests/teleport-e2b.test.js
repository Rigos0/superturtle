#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { dirname, resolve } = require("path");
const { spawn } = require("child_process");

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
    `import fs from "fs";
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
