#!/usr/bin/env node

/**
 * Super Turtle CLI — thin Node wrapper that delegates to Bun for the actual bot.
 *
 * Commands:
 *   superturtle init    — scaffold .superturtle/ config in current project
 *   superturtle start   — launch the bot (requires Bun + tmux)
 *   superturtle stop    — stop bot + all SubTurtles
 *   superturtle status  — show bot and SubTurtle status
 *   superturtle doctor  — full process + log observability snapshot
 *   superturtle logs    — tail loop/pino/audit logs
 */

const { execSync, spawnSync } = require("child_process");
const { resolve, dirname, basename } = require("path");
const fs = require("fs");
const readline = require("readline");

const PACKAGE_ROOT = resolve(__dirname, "..");
const BOT_DIR = resolve(PACKAGE_ROOT, "claude-telegram-bot");
const TEMPLATES_DIR = resolve(PACKAGE_ROOT, "templates");

function loadProjectEnv(cwd) {
  const envPath = resolve(cwd, ".superturtle", ".env");
  if (!fs.existsSync(envPath)) return null;
  const parsed = {};
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx);
    let value = trimmed.slice(eqIdx + 1).trim().replace(/\r$/, "");
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[key] = value;
  }
  return parsed;
}

function sanitizeName(value, fallback) {
  const cleaned = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return cleaned || fallback;
}

function deriveTmuxSessionName(cwd, env) {
  const token = env.TELEGRAM_BOT_TOKEN || "";
  const tokenPrefix = sanitizeName(token.split(":")[0], "default");
  const projectSlug = sanitizeName(basename(cwd), "project");
  const combined = `superturtle-${tokenPrefix}-${projectSlug}`;
  return combined.length > 80 ? combined.slice(0, 80) : combined;
}

function resolveTmuxSession(cwd, env) {
  return process.env.SUPERTURTLE_TMUX_SESSION || deriveTmuxSessionName(cwd, env);
}

function deriveTokenPrefix(env) {
  const token = env.TELEGRAM_BOT_TOKEN || "";
  return sanitizeName(token.split(":")[0], "default");
}

function getLogPaths(cwd, env) {
  const tokenPrefix = deriveTokenPrefix(env);
  return {
    tokenPrefix,
    loop: env.SUPERTURTLE_LOOP_LOG_PATH || `/tmp/claude-telegram-${tokenPrefix}-bot-ts.log`,
    pino: env.SUPERTURTLE_PINO_LOG_PATH || `/tmp/claude-telegram-${tokenPrefix}-bot.log.jsonl`,
    audit: env.AUDIT_LOG_PATH || `/tmp/claude-telegram-${tokenPrefix}-audit.log`,
    cronJobs: resolve(cwd, ".superturtle", "cron-jobs.json"),
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function describeFile(path) {
  try {
    const stats = fs.statSync(path);
    return {
      exists: true,
      size: stats.size,
      mtimeIso: stats.mtime.toISOString(),
    };
  } catch {
    return {
      exists: false,
      size: 0,
      mtimeIso: "",
    };
  }
}

function readCronSummary(cronJobsPath) {
  if (!fs.existsSync(cronJobsPath)) {
    return { exists: false, total: 0, overdue: 0, dueSoon: 0, parseError: null };
  }

  try {
    const raw = fs.readFileSync(cronJobsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const jobs = Array.isArray(parsed) ? parsed : [];
    const now = Date.now();
    const inFiveMinutes = now + 5 * 60 * 1000;
    let overdue = 0;
    let dueSoon = 0;

    for (const job of jobs) {
      const fireAt = Number(job?.fire_at);
      if (!Number.isFinite(fireAt)) continue;
      if (fireAt < now) overdue += 1;
      if (fireAt >= now && fireAt <= inFiveMinutes) dueSoon += 1;
    }

    return {
      exists: true,
      total: jobs.length,
      overdue,
      dueSoon,
      parseError: null,
    };
  } catch (error) {
    return {
      exists: true,
      total: 0,
      overdue: 0,
      dueSoon: 0,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function printLogSummary(label, path) {
  const info = describeFile(path);
  if (!info.exists) {
    console.log(`${label}: missing`);
    console.log(`  ${path}`);
    return;
  }
  console.log(`${label}: ${formatBytes(info.size)}, updated ${info.mtimeIso}`);
  console.log(`  ${path}`);
}

function printLoopLogErrorHints(loopPath) {
  if (!fs.existsSync(loopPath)) return;
  const tail = spawnSync("tail", ["-n", "120", loopPath], { stdio: "pipe" });
  if (tail.status !== 0) return;
  const lines = tail.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const hints = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/error|fail|crash|panic|exit code|sigterm|sigkill|exception/i.test(lines[i])) {
      hints.unshift(lines[i]);
      if (hints.length >= 5) break;
    }
  }
  if (hints.length === 0) return;
  console.log("\nRecent loop failure hints:");
  for (const hint of hints) {
    const preview = hint.length > 180 ? `${hint.slice(0, 177)}...` : hint;
    console.log(`  - ${preview}`);
  }
}

function printSubturtleList(ctlPath, cwd) {
  if (!fs.existsSync(ctlPath)) {
    console.log("SubTurtles: ctl missing");
    return;
  }
  const proc = spawnSync(ctlPath, ["list"], {
    cwd,
    env: { ...process.env, SUPER_TURTLE_PROJECT_DIR: cwd },
    stdio: "pipe",
  });
  if (proc.status !== 0) {
    const stderr = proc.stderr?.toString().trim();
    console.log(`SubTurtles: failed to read list${stderr ? ` (${stderr})` : ""}`);
    return;
  }
  const output = proc.stdout?.toString().trim();
  if (!output) {
    console.log("SubTurtles: none");
    return;
  }
  console.log("SubTurtles:");
  console.log(output);
}

function exitFromSpawn(result, context) {
  if (!result) {
    console.error(`Error: failed to run ${context}.`);
    process.exit(1);
  }
  if (result.error) {
    console.error(`Error: failed to run ${context}: ${result.error.message}`);
    process.exit(1);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = result.stderr?.toString()?.trim();
    if (stderr) console.error(stderr);
    console.error(`Error: ${context} exited with code ${result.status}.`);
    process.exit(result.status || 1);
  }
}

// --- Output helpers (ANSI, no dependencies) ---
const isTTY = process.stdout.isTTY;
const c = {
  green: (s) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  dim: (s) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  bold: (s) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  yellow: (s) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  red: (s) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
};
const ok = (msg) => console.log(`  ${c.green("\u2713")} ${msg}`);
const warn = (msg) => console.log(`  ${c.yellow("!")} ${msg}`);
const fail = (msg) => { console.error(`  ${c.red("\u2717")} ${msg}`); };
const info = (msg) => console.log(`  ${c.dim(msg)}`);
const blank = () => console.log();

function getVersion() {
  try {
    return JSON.parse(fs.readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8")).version;
  } catch { return "0.0.0"; }
}

function checkBun() {
  try {
    execSync("bun --version", { stdio: "pipe" });
    ok("bun");
    return true;
  } catch {
    fail("bun not found — https://bun.sh");
    process.exit(1);
  }
}

function checkTmux() {
  try {
    execSync("tmux -V", { stdio: "pipe" });
    ok("tmux");
    return true;
  } catch {
    fail("tmux not found — brew install tmux");
    process.exit(1);
  }
}

function checkClaude() {
  try {
    execSync("claude --version", { stdio: "pipe" });
    ok("claude");
    return true;
  } catch {
    warn("claude CLI not found — https://claude.ai/code");
    return false;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`  ${question}`, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function parseInitFlags() {
  const flags = { token: null, user: null, openaiKey: null };
  const args = process.argv.slice(3); // skip node, script, "init"
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--token":
        flags.token = args[++i] || null;
        break;
      case "--user":
        flags.user = args[++i] || null;
        break;
      case "--openai-key":
        flags.openaiKey = args[++i] || null;
        break;
    }
  }
  return flags;
}

function pickAvailablePath(basePath) {
  if (!fs.existsSync(basePath)) return basePath;
  let suffix = 2;
  while (fs.existsSync(`${basePath}-${suffix}`)) {
    suffix += 1;
  }
  return `${basePath}-${suffix}`;
}

function copyDirFiltered(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (
      entry.name === ".DS_Store" ||
      entry.name === "settings.local.json" ||
      entry.name === "agent-memory"
    ) {
      continue;
    }
    const sourcePath = resolve(sourceDir, entry.name);
    const targetPath = resolve(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirFiltered(sourcePath, targetPath);
      continue;
    }
    if (fs.existsSync(targetPath)) continue;
    fs.copyFileSync(sourcePath, targetPath);
  }
}

async function init() {
  const cwd = process.cwd();
  const dataDir = resolve(cwd, ".superturtle");
  const flags = parseInitFlags();

  blank();
  console.log(`  \u{1F422} ${c.bold("superturtle")} ${c.dim("v" + getVersion())}`);
  blank();

  // --- Prerequisites ---
  checkBun();
  checkTmux();
  checkClaude();
  blank();

  // --- .superturtle/ directory ---
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const gitignorePath = resolve(dataDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "*\n");
  }
  ok(".superturtle/");

  // --- .env config ---
  const envPath = resolve(dataDir, ".env");
  if (!fs.existsSync(envPath)) {
    let token = flags.token;
    let userId = flags.user;
    let openaiKey = flags.openaiKey;

    if (!token || !userId) {
      // Non-interactive mode: fail fast
      if (!process.stdin.isTTY) {
        blank();
        fail("Missing required flags for non-interactive mode:");
        if (!token) fail("  --token <TELEGRAM_BOT_TOKEN>");
        if (!userId) fail("  --user <TELEGRAM_USER_ID>");
        blank();
        info("Usage: superturtle init --token <token> --user <id> [--openai-key <key>]");
        blank();
        process.exit(1);
      }

      // Interactive mode
      blank();
      console.log(`  ${c.bold("Telegram Bot Configuration")}`);
      info("\u2500".repeat(30));
      blank();

      if (!token) {
        info("Get a token: message @BotFather on Telegram \u2192 /newbot");
        blank();
        token = await ask("Bot token: ");
        if (!token) { fail("Bot token is required."); process.exit(1); }
        blank();
      }

      if (!userId) {
        info("Find your ID: message @userinfobot on Telegram");
        blank();
        userId = await ask("User ID: ");
        if (!userId) { fail("User ID is required."); process.exit(1); }
        blank();
      }

      if (openaiKey === null) {
        openaiKey = await ask("OpenAI API key " + c.dim("(for voice, Enter to skip)") + ": ");
        blank();
      }
    }

    let envContent = `TELEGRAM_BOT_TOKEN=${token}\n`;
    envContent += `TELEGRAM_ALLOWED_USERS=${userId}\n`;
    envContent += `CLAUDE_WORKING_DIR=${cwd}\n`;
    if (openaiKey) {
      envContent += `OPENAI_API_KEY=${openaiKey}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    ok(".superturtle/.env");
  } else {
    ok(".superturtle/.env " + c.dim("(exists)"));
  }

  // --- CLAUDE.md ---
  const claudeMdPath = resolve(cwd, "CLAUDE.md");
  const templatePath = resolve(TEMPLATES_DIR, "CLAUDE.md.template");
  if (!fs.existsSync(claudeMdPath) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, claudeMdPath);
    ok("CLAUDE.md");
  } else if (fs.existsSync(claudeMdPath)) {
    ok("CLAUDE.md " + c.dim("(exists)"));
  }

  // --- AGENTS.md symlink ---
  const agentsPath = resolve(cwd, "AGENTS.md");
  if (!fs.existsSync(agentsPath)) {
    try {
      fs.symlinkSync("CLAUDE.md", agentsPath);
      ok("AGENTS.md \u2192 CLAUDE.md");
    } catch (error) {
      warn(`AGENTS.md symlink failed: ${error.message}`);
    }
  }

  // --- .claude templates ---
  const claudeTemplateDir = resolve(TEMPLATES_DIR, ".claude");
  if (fs.existsSync(claudeTemplateDir)) {
    let targetClaudeDir = resolve(cwd, ".claude");
    if (fs.existsSync(targetClaudeDir)) {
      targetClaudeDir = pickAvailablePath(resolve(cwd, ".superturtle-claude"));
    }
    copyDirFiltered(claudeTemplateDir, targetClaudeDir);
    ok(targetClaudeDir.replace(cwd + "/", ""));
  }

  // --- .gitignore ---
  const projectGitignore = resolve(cwd, ".gitignore");
  if (fs.existsSync(projectGitignore)) {
    const content = fs.readFileSync(projectGitignore, "utf-8");
    const additions = [];
    if (!content.includes(".superturtle/")) additions.push(".superturtle/");
    if (!content.includes(".subturtles/")) additions.push(".subturtles/");
    if (additions.length > 0) {
      fs.appendFileSync(projectGitignore, "\n# superturtle\n" + additions.join("\n") + "\n");
      ok(".gitignore");
    }
  }

  // --- Dependencies ---
  blank();
  info("Installing dependencies...");
  const install = spawnSync("bun", ["install"], { cwd: BOT_DIR, stdio: "pipe" });
  exitFromSpawn(install, "bun install");
  ok("dependencies installed");

  // --- Done ---
  blank();
  console.log(`  ${c.green("Ready!")} Run: ${c.bold("superturtle start")}`);
  blank();
}

function start() {
  checkBun();
  checkTmux();

  const cwd = process.cwd();
  const projectEnv = loadProjectEnv(cwd);

  if (!projectEnv) {
    console.error("No .superturtle/.env found. Run 'superturtle init' first.");
    process.exit(1);
  }

  // Set environment
  const env = {
    ...process.env,
    ...projectEnv,
    SUPER_TURTLE_DIR: PACKAGE_ROOT,
    CLAUDE_WORKING_DIR: cwd,
  };
  const tmuxSession = resolveTmuxSession(cwd, env);
  const logPaths = getLogPaths(cwd, env);

  // Check if tmux session already exists
  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    console.log(`Bot is already running. Attaching to tmux session '${tmuxSession}'...`);
    const attach = spawnSync("tmux", ["attach-session", "-t", tmuxSession], { stdio: "inherit" });
    exitFromSpawn(attach, "tmux attach-session");
    return;
  }

  // Start bot in a new tmux session
  const cmd =
    `cd "${BOT_DIR}"` +
    ` && export CLAUDE_WORKING_DIR="${cwd}"` +
    ` && export SUPER_TURTLE_DIR="${PACKAGE_ROOT}"` +
    ` && export SUPERTURTLE_RUN_LOOP=1` +
    ` && export SUPERTURTLE_LOOP_LOG_PATH="${logPaths.loop}"` +
    ` && export SUPERTURTLE_TMUX_SESSION="${tmuxSession}"` +
    ` && ./run-loop.sh 2>&1 | tee -a "${logPaths.loop}"`;

  console.log("Starting Super Turtle bot...");

  function shouldPassEnvKey(k) {
    return (
      k.startsWith("TELEGRAM_") ||
      k.startsWith("OPENAI_") ||
      k.startsWith("CLAUDE_") ||
      k.startsWith("CODEX_") ||
      k.startsWith("META_") ||
      k.startsWith("DASHBOARD_") ||
      k.startsWith("AUDIT_LOG_") ||
      k.startsWith("RATE_LIMIT_") ||
      k.startsWith("THINKING_") ||
      k.startsWith("TRANSCRIPTION_") ||
      k.startsWith("TURTLE_") ||
      k === "ALLOWED_PATHS" ||
      k === "LOG_LEVEL"
    );
  }

  const startProc = spawnSync("tmux", [
    "new-session", "-d", "-s", tmuxSession,
    "-e", `SUPER_TURTLE_DIR=${PACKAGE_ROOT}`,
    "-e", `CLAUDE_WORKING_DIR=${cwd}`,
    "-e", `SUPERTURTLE_TMUX_SESSION=${tmuxSession}`,
    ...Object.entries(env)
      .filter(([k]) => shouldPassEnvKey(k))
      .map(([k, v]) => ["-e", `${k}=${v}`])
      .flat(),
    cmd,
  ], { stdio: "pipe" });
  exitFromSpawn(startProc, "tmux new-session");

  // Give tmux a moment; if the command crashes immediately, surface that now.
  spawnSync("sleep", ["0.3"], { stdio: "pipe" });
  const aliveCheck = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" });
  if (aliveCheck.status !== 0) {
    console.error(`Bot session '${tmuxSession}' exited immediately.`);
    if (fs.existsSync(logPaths.loop)) {
      console.error(`Last log lines from ${logPaths.loop}:`);
      const tail = spawnSync("tail", ["-n", "40", logPaths.loop], { stdio: "pipe" });
      const out = tail.stdout?.toString().trim();
      if (out) {
        console.error(out);
      }
    } else {
      console.error(`No loop log found at ${logPaths.loop}`);
    }
    process.exit(1);
  }

  console.log(`Bot started in tmux session '${tmuxSession}'.`);
  console.log(`Attach: tmux attach -t ${tmuxSession}`);
  console.log(`Loop log: ${logPaths.loop}`);
  console.log("Now message your bot in Telegram!");
}

function stop() {
  const cwd = process.cwd();
  const projectEnv = loadProjectEnv(cwd) || {};
  const tmuxSession = resolveTmuxSession(cwd, { ...process.env, ...projectEnv });

  // Kill tmux session
  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    spawnSync("tmux", ["kill-session", "-t", tmuxSession], { stdio: "pipe" });
    console.log("Bot stopped.");
  } else {
    console.log("Bot is not running.");
  }

  // Stop SubTurtles
  const ctlPath = resolve(PACKAGE_ROOT, "subturtle", "ctl");
  if (fs.existsSync(ctlPath)) {
    const proc = spawnSync(ctlPath, ["stopall"], {
      cwd: process.cwd(),
      env: { ...process.env, SUPER_TURTLE_PROJECT_DIR: process.cwd() },
      stdio: "pipe",
    });
    exitFromSpawn(proc, "subturtle ctl stopall");
    if (proc.stdout?.toString().trim()) {
      console.log(proc.stdout.toString().trim());
    }
  }
}

function status() {
  const cwd = process.cwd();
  const projectEnv = loadProjectEnv(cwd) || {};
  const env = { ...process.env, ...projectEnv };
  const tmuxSession = resolveTmuxSession(cwd, env);
  const logPaths = getLogPaths(cwd, env);

  // Check tmux session
  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    console.log(`Bot: running (${tmuxSession})`);
  } else {
    console.log(`Bot: stopped (${tmuxSession})`);
  }

  // Check SubTurtles
  const ctlPath = resolve(PACKAGE_ROOT, "subturtle", "ctl");
  printSubturtleList(ctlPath, cwd);

  const cronSummary = readCronSummary(logPaths.cronJobs);
  console.log("\nCron:");
  if (!cronSummary.exists) {
    console.log(`  missing (${logPaths.cronJobs})`);
  } else if (cronSummary.parseError) {
    console.log(`  parse error: ${cronSummary.parseError}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  } else {
    console.log(`  total=${cronSummary.total} due_soon_5m=${cronSummary.dueSoon} overdue=${cronSummary.overdue}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  }

  console.log("\nLogs:");
  printLogSummary("  loop", logPaths.loop);
  printLogSummary("  pino", logPaths.pino);
  printLogSummary("  audit", logPaths.audit);
}

function doctor() {
  checkTmux();
  const cwd = process.cwd();
  const projectEnv = loadProjectEnv(cwd) || {};
  const env = { ...process.env, ...projectEnv };
  const tmuxSession = resolveTmuxSession(cwd, env);
  const logPaths = getLogPaths(cwd, env);
  const ctlPath = resolve(PACKAGE_ROOT, "subturtle", "ctl");

  console.log(`Project: ${cwd}`);
  console.log(`Token prefix: ${logPaths.tokenPrefix}`);
  console.log(`Session: ${tmuxSession}`);

  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", tmuxSession], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    console.log("Bot process: running");
    const details = spawnSync(
      "tmux",
      ["display-message", "-p", "-t", tmuxSession, "#{session_name} windows=#{session_windows} attached=#{session_attached}"],
      { stdio: "pipe" }
    );
    const infoLine = details.stdout?.toString().trim();
    if (infoLine) console.log(`  ${infoLine}`);
  } else {
    console.log("Bot process: stopped");
  }

  console.log("");
  printSubturtleList(ctlPath, cwd);

  const cronSummary = readCronSummary(logPaths.cronJobs);
  console.log("\nCron jobs:");
  if (!cronSummary.exists) {
    console.log(`  missing (${logPaths.cronJobs})`);
  } else if (cronSummary.parseError) {
    console.log(`  parse error: ${cronSummary.parseError}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  } else {
    console.log(`  total=${cronSummary.total} due_soon_5m=${cronSummary.dueSoon} overdue=${cronSummary.overdue}`);
    console.log(`  file: ${logPaths.cronJobs}`);
  }

  console.log("\nLogs:");
  printLogSummary("  loop", logPaths.loop);
  printLogSummary("  pino", logPaths.pino);
  printLogSummary("  audit", logPaths.audit);
  printLoopLogErrorHints(logPaths.loop);

  console.log("\nQuick commands:");
  console.log(`  superturtle logs loop`);
  console.log(`  superturtle logs pino --pretty`);
  console.log(`  superturtle logs audit`);
  console.log(`  tmux attach -t ${tmuxSession}`);
}

function parseLogsArgs(args) {
  const opts = {
    target: "loop",
    follow: true,
    lines: 100,
    pretty: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "loop" || arg === "pino" || arg === "audit") {
      opts.target = arg;
      continue;
    }
    if (arg === "--follow") {
      opts.follow = true;
      continue;
    }
    if (arg === "--no-follow") {
      opts.follow = false;
      continue;
    }
    if (arg === "--pretty") {
      opts.pretty = true;
      continue;
    }
    if (arg === "--lines" || arg === "-n") {
      const next = args[i + 1];
      if (!next || !/^\d+$/.test(next)) {
        throw new Error(`Invalid value for ${arg}. Expected a positive integer.`);
      }
      opts.lines = Math.max(1, Number.parseInt(next, 10));
      i += 1;
      continue;
    }
    throw new Error(`Unknown logs argument: ${arg}`);
  }

  return opts;
}

function logs() {
  const cwd = process.cwd();
  const projectEnv = loadProjectEnv(cwd) || {};
  const env = { ...process.env, ...projectEnv };
  const logPaths = getLogPaths(cwd, env);
  const args = process.argv.slice(3);
  let opts;
  try {
    opts = parseLogsArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("Usage: superturtle logs [loop|pino|audit] [--pretty] [--lines N] [--follow|--no-follow]");
    process.exit(1);
  }

  const path = logPaths[opts.target];
  if (!fs.existsSync(path) && opts.follow) {
    fs.mkdirSync(dirname(path), { recursive: true });
    fs.closeSync(fs.openSync(path, "a"));
  }
  if (!fs.existsSync(path)) {
    console.error(`Log file not found: ${path}`);
    process.exit(1);
  }

  if (opts.pretty && opts.target !== "pino") {
    console.error("--pretty is only supported for pino logs.");
    process.exit(1);
  }

  if (opts.pretty) {
    const followFlag = opts.follow ? "-F" : "";
    const cmd = `tail -n ${opts.lines} ${followFlag} "${path}" | npx --yes pino-pretty -c`;
    const proc = spawnSync("bash", ["-lc", cmd], {
      cwd: BOT_DIR,
      stdio: "inherit",
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR || "1",
        NO_COLOR: "",
      },
    });
    exitFromSpawn(proc, "pretty log tail");
    return;
  }

  const tailArgs = ["-n", String(opts.lines)];
  if (opts.follow) tailArgs.push("-F");
  tailArgs.push(path);
  const proc = spawnSync("tail", tailArgs, { stdio: "inherit" });
  exitFromSpawn(proc, "tail");
}

// Dispatch command
const command = process.argv[2];

switch (command) {
  case "init":
    init().catch((err) => { console.error(err); process.exit(1); });
    break;
  case "start":
    start();
    break;
  case "stop":
    stop();
    break;
  case "status":
    status();
    break;
  case "doctor":
    doctor();
    break;
  case "logs":
    logs();
    break;
  case "--version":
  case "-v":
    try {
      const pkg = JSON.parse(fs.readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf-8"));
      console.log(`superturtle v${pkg.version}`);
    } catch {
      console.log("superturtle (unknown version)");
    }
    break;
  default:
    console.log(`superturtle - Code from anywhere

Usage: superturtle <command>

Commands:
  init      Set up superturtle in the current project
  start     Launch the bot
  stop      Stop the bot and all SubTurtles
  status    Show bot and SubTurtle status
  doctor    Full process + log observability snapshot
  logs      Tail logs (loop|pino|audit)

Init flags (for non-interactive / agent use):
  --token <token>       Telegram bot token
  --user <id>           Telegram user ID
  --openai-key <key>    OpenAI API key (optional)

Options:
  -v, --version  Show version

Logs:
  superturtle logs loop
  superturtle logs pino --pretty
  superturtle logs audit --no-follow -n 200`);
    if (command && command !== "help" && command !== "--help" && command !== "-h") {
      process.exit(1);
    }
}
