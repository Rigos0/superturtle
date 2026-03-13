#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

function usage() {
  console.error(
    "Usage:\n" +
      "  node super_turtle/bin/teleport-e2b.js upload-file --sandbox-id <id> --source <path> --destination <path>\n" +
      "  node super_turtle/bin/teleport-e2b.js sync-archive --sandbox-id <id> --source <path> --remote-root <path> [--archive-path <path>]\n" +
      "  node super_turtle/bin/teleport-e2b.js extract-archive --sandbox-id <id> --source <path> --destination-root <path> [--archive-path <path>]\n" +
      "  node super_turtle/bin/teleport-e2b.js run-script --sandbox-id <id> [--cwd <path>] [--timeout-ms <ms>] -- <command> [args...]\n"
  );
}

function fail(message, code = 1) {
  if (message) {
    console.error(message);
  }
  process.exit(code);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function readRequiredOption(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.length === 0) {
    fail(`Missing required option: --${name.replaceAll("_", "-")}`);
  }
  return value;
}

function parseOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const optionName = token.slice(2).replaceAll("-", "_");
    const optionValue = argv[index + 1];
    if (typeof optionValue !== "string" || optionValue.startsWith("--")) {
      fail(`Missing value for option: ${token}`);
    }
    options[optionName] = optionValue;
    index += 1;
  }
  return { options, positional };
}

function normalizeChunk(chunk) {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk == null) {
    return "";
  }
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString("utf-8");
  }
  if (typeof chunk === "object") {
    if (typeof chunk.text === "string") {
      return chunk.text;
    }
    if (typeof chunk.data === "string") {
      return chunk.data;
    }
  }
  return String(chunk);
}

async function loadSandboxClass() {
  const explicitSdkPath = process.env.SUPERTURTLE_TELEPORT_E2B_SDK_PATH;
  const sdkSpecifier =
    typeof explicitSdkPath === "string" && explicitSdkPath.trim().length > 0
      ? pathToFileURL(path.resolve(explicitSdkPath.trim())).href
      : "e2b";

  try {
    const module = await import(sdkSpecifier);
    if (module && typeof module.Sandbox === "function") {
      return module.Sandbox;
    }
    if (module && typeof module.default === "function") {
      return module.default;
    }
    if (module && module.default && typeof module.default.Sandbox === "function") {
      return module.default.Sandbox;
    }
  } catch (error) {
    fail(
      `Failed to load the E2B SDK: ${error instanceof Error ? error.message : String(error)}. ` +
        `Run 'cd super_turtle && bun install' to install the 'e2b' package${sdkSpecifier === "e2b" ? "" : ", or fix SUPERTURTLE_TELEPORT_E2B_SDK_PATH"}.`
    );
  }
  fail("Failed to load the E2B SDK: missing Sandbox export from the configured module.");
}

async function connectSandbox(sandboxId) {
  const Sandbox = await loadSandboxClass();
  if (typeof Sandbox.connect !== "function") {
    fail("The installed 'e2b' package does not expose Sandbox.connect().");
  }
  return Sandbox.connect(sandboxId);
}

async function ensureRemoteParent(sandbox, destinationPath) {
  const parentDir = path.posix.dirname(destinationPath);
  if (!parentDir || parentDir === "." || parentDir === "/") {
    return;
  }
  await runCommandInSandbox(sandbox, `mkdir -p ${shellQuote(parentDir)}`, { cwd: "/" });
}

async function runCommandInSandbox(sandbox, command, options = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const result = await sandbox.commands.run(command, {
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    onStdout(chunk) {
      const text = normalizeChunk(chunk);
      stdoutChunks.push(text);
      if (text) process.stdout.write(text);
    },
    onStderr(chunk) {
      const text = normalizeChunk(chunk);
      stderrChunks.push(text);
      if (text) process.stderr.write(text);
    },
  });

  const exitCode =
    Number.isInteger(result?.exitCode) ? result.exitCode :
    Number.isInteger(result?.exit_code) ? result.exit_code :
    0;
  const stdout =
    typeof result?.stdout === "string" ? result.stdout : stdoutChunks.join("");
  const stderr =
    typeof result?.stderr === "string" ? result.stderr : stderrChunks.join("");

  if (exitCode !== 0) {
    const failureMessage = stderr || stdout || `Sandbox command exited with code ${exitCode}.`;
    const error = new Error(failureMessage.trim() || `Sandbox command exited with code ${exitCode}.`);
    error.exitCode = exitCode;
    throw error;
  }

  return { exitCode, stdout, stderr };
}

async function uploadFile(commandArgs) {
  const { options } = parseOptions(commandArgs);
  const sandboxId = readRequiredOption(options, "sandbox_id");
  const sourcePath = readRequiredOption(options, "source");
  const destinationPath = readRequiredOption(options, "destination");
  const sandbox = await connectSandbox(sandboxId);
  await ensureRemoteParent(sandbox, destinationPath);
  const payload = fs.readFileSync(sourcePath);
  await sandbox.files.write(destinationPath, payload);
}

async function syncArchive(commandArgs) {
  const { options } = parseOptions(commandArgs);
  const sandboxId = readRequiredOption(options, "sandbox_id");
  const sourcePath = readRequiredOption(options, "source");
  const remoteRoot = readRequiredOption(options, "remote_root");
  const archivePath =
    typeof options.archive_path === "string" && options.archive_path.length > 0
      ? options.archive_path
      : `/tmp/superturtle-teleport-sync-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tar.gz`;
  const sandbox = await connectSandbox(sandboxId);
  await ensureRemoteParent(sandbox, archivePath);
  const payload = fs.readFileSync(sourcePath);
  await sandbox.files.write(archivePath, payload);

  const remoteParent = path.posix.dirname(remoteRoot);
  try {
    await runCommandInSandbox(sandbox, `mkdir -p ${shellQuote(remoteParent)}`, { cwd: "/" });
    await runCommandInSandbox(sandbox, `rm -rf ${shellQuote(remoteRoot)}`, { cwd: "/" });
    await runCommandInSandbox(sandbox, `mkdir -p ${shellQuote(remoteRoot)}`, { cwd: "/" });
    await runCommandInSandbox(
      sandbox,
      `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(remoteRoot)}`,
      { cwd: "/" }
    );
  } finally {
    try {
      await runCommandInSandbox(sandbox, `rm -f ${shellQuote(archivePath)}`, { cwd: "/" });
    } catch {}
  }
}

async function extractArchive(commandArgs) {
  const { options } = parseOptions(commandArgs);
  const sandboxId = readRequiredOption(options, "sandbox_id");
  const sourcePath = readRequiredOption(options, "source");
  const destinationRoot = readRequiredOption(options, "destination_root");
  const archivePath =
    typeof options.archive_path === "string" && options.archive_path.length > 0
      ? options.archive_path
      : `/tmp/superturtle-teleport-extract-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.tar.gz`;
  const sandbox = await connectSandbox(sandboxId);
  await ensureRemoteParent(sandbox, archivePath);
  const payload = fs.readFileSync(sourcePath);
  await sandbox.files.write(archivePath, payload);

  try {
    await runCommandInSandbox(sandbox, `mkdir -p ${shellQuote(destinationRoot)}`, { cwd: "/" });
    await runCommandInSandbox(
      sandbox,
      `tar -xzf ${shellQuote(archivePath)} -C ${shellQuote(destinationRoot)}`,
      { cwd: "/" }
    );
  } finally {
    try {
      await runCommandInSandbox(sandbox, `rm -f ${shellQuote(archivePath)}`, { cwd: "/" });
    } catch {}
  }
}

async function runScript(commandArgs) {
  const { options, positional } = parseOptions(commandArgs);
  const sandboxId = readRequiredOption(options, "sandbox_id");
  const cwd = options.cwd || "/";
  const timeoutRaw = options.timeout_ms;
  const timeoutMs =
    typeof timeoutRaw === "string" && /^\d+$/.test(timeoutRaw) ? Number(timeoutRaw) : undefined;
  if (positional.length === 0) {
    fail("run-script requires a command after '--'.");
  }

  const scriptBody = fs.readFileSync(0, "utf-8");
  const sandbox = await connectSandbox(sandboxId);
  const remoteScriptPath = `/tmp/superturtle-teleport-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.sh`;
  await sandbox.files.write(remoteScriptPath, scriptBody);
  try {
    const invocation = [...positional];
    if (invocation[0] === "bash" && invocation[1] === "-s") {
      const separatorIndex = invocation.indexOf("--");
      const passthroughArgs = separatorIndex >= 0 ? invocation.slice(separatorIndex + 1) : invocation.slice(2);
      invocation.splice(0, invocation.length, "bash", remoteScriptPath, ...passthroughArgs);
    } else {
      invocation.splice(1, 0, remoteScriptPath);
    }
    const command = invocation.map(shellQuote).join(" ");
    await runCommandInSandbox(sandbox, command, { cwd, timeoutMs });
  } finally {
    try {
      await runCommandInSandbox(sandbox, `rm -f ${shellQuote(remoteScriptPath)}`, { cwd: "/" });
    } catch {}
  }
}

async function main() {
  const [subcommand, ...commandArgs] = process.argv.slice(2);
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    usage();
    process.exit(subcommand ? 0 : 1);
  }

  try {
    switch (subcommand) {
      case "upload-file":
        await uploadFile(commandArgs);
        return;
      case "sync-archive":
        await syncArchive(commandArgs);
        return;
      case "extract-archive":
        await extractArchive(commandArgs);
        return;
      case "run-script":
        await runScript(commandArgs);
        return;
      default:
        usage();
        fail(`Unknown subcommand: ${subcommand}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

main();
