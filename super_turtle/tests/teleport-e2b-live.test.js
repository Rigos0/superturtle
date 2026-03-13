#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { resolve } = require("path");
const { spawn } = require("child_process");
const { Sandbox } = require("e2b");

const REPO_ROOT = resolve(__dirname, "..", "..");
const HELPER_PATH = resolve(REPO_ROOT, "super_turtle", "bin", "teleport-e2b.js");
const RUN_LIVE_TESTS = process.env.SUPERTURTLE_RUN_LIVE_E2B_TESTS === "1";
const TELEPORT_TEMPLATE = process.env.SUPERTURTLE_TELEPORT_E2B_TEMPLATE?.trim() || null;
const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
const HELPER_TIMEOUT_MS = 60 * 1000;
const REMOTE_DIR = "/tmp/superturtle-live-smoke";
const REMOTE_FILE = `${REMOTE_DIR}/handoff.txt`;
const TEMP_SCRIPT_PREFIX = "superturtle-teleport-";

function skip(message) {
  console.log(`[skip] ${message}`);
  process.exit(0);
}

function runHelper(args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", [HELPER_PATH, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    const timeout = setTimeout(() => {
      if (finished) {
        return;
      }
      finished = true;
      child.kill("SIGKILL");
      rejectRun(new Error(`helper timed out after ${HELPER_TIMEOUT_MS}ms: ${args.join(" ")}`));
    }, HELPER_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolveRun({ code, stdout, stderr });
    });

    child.stdin.end(options.stdin || "");
  });
}

async function createSandbox() {
  if (TELEPORT_TEMPLATE) {
    return Sandbox.create(TELEPORT_TEMPLATE, { timeoutMs: SANDBOX_TIMEOUT_MS });
  }
  return Sandbox.create({ timeoutMs: SANDBOX_TIMEOUT_MS });
}

async function main() {
  if (!RUN_LIVE_TESTS) {
    skip("set SUPERTURTLE_RUN_LIVE_E2B_TESTS=1 to run the live E2B smoke test");
  }
  if (!process.env.E2B_API_KEY) {
    skip("E2B_API_KEY is not set");
  }

  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-teleport-e2b-live-"));
  const sourcePath = resolve(tmpDir, "handoff.txt");
  const payload = `semantic handoff ${Date.now()}\n`;
  fs.writeFileSync(sourcePath, payload);

  let sandbox = null;
  try {
    sandbox = await createSandbox();
    const sandboxId = sandbox.sandboxId || sandbox.id;
    assert.ok(sandboxId, "expected a live sandbox id");

    const uploadResult = await runHelper([
      "upload-file",
      "--sandbox-id",
      sandboxId,
      "--source",
      sourcePath,
      "--destination",
      REMOTE_FILE,
    ]);
    assert.strictEqual(uploadResult.code, 0, uploadResult.stderr);

    const uploadedPayload = await sandbox.files.read(REMOTE_FILE);
    assert.strictEqual(uploadedPayload, payload);

    const scriptBody = [
      "set -euo pipefail",
      "pwd",
      "printf 'args=%s,%s\\n' \"$1\" \"$2\"",
      `cat ${REMOTE_FILE}`,
      "",
    ].join("\n");
    const runResult = await runHelper(
      [
        "run-script",
        "--sandbox-id",
        sandboxId,
        "--cwd",
        REMOTE_DIR,
        "--timeout-ms",
        "20000",
        "--",
        "bash",
        "-s",
        "--",
        "alpha",
        "beta",
      ],
      { stdin: scriptBody }
    );

    assert.strictEqual(runResult.code, 0, runResult.stderr);
    assert.match(runResult.stdout, new RegExp(`^${REMOTE_DIR}$`, "m"));
    assert.match(runResult.stdout, /^args=alpha,beta$/m);
    assert.match(runResult.stdout, new RegExp(payload.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m"));

    const tmpEntries = await sandbox.files.list("/tmp");
    assert.ok(
      tmpEntries.every((entry) => entry.name !== undefined && !String(entry.name).startsWith(TEMP_SCRIPT_PREFIX)),
      "expected helper temp scripts to be cleaned up from /tmp"
    );
  } finally {
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
