#!/usr/bin/env node

/**
 * Super Turtle CLI — thin Node wrapper that delegates to Bun for the actual bot.
 *
 * Commands:
 *   superturtle init    — scaffold .superturtle/ config in current project
 *   superturtle start   — launch the bot (requires Bun + tmux)
 *   superturtle stop    — stop bot + all SubTurtles
 *   superturtle status  — show bot and SubTurtle status
 */

const { execSync, spawn, spawnSync } = require("child_process");
const { resolve, dirname } = require("path");
const fs = require("fs");
const readline = require("readline");

const PACKAGE_ROOT = resolve(__dirname, "..");
const BOT_DIR = resolve(PACKAGE_ROOT, "claude-telegram-bot");
const TEMPLATES_DIR = resolve(PACKAGE_ROOT, "templates");
const TMUX_SESSION = process.env.SUPERTURTLE_TMUX_SESSION || "superturtle";

function checkBun() {
  try {
    execSync("bun --version", { stdio: "pipe" });
    return true;
  } catch {
    console.error("Error: Bun is required but not installed.");
    console.error("Install it: https://bun.sh");
    process.exit(1);
  }
}

function checkTmux() {
  try {
    execSync("tmux -V", { stdio: "pipe" });
    return true;
  } catch {
    console.error("Error: tmux is required but not installed.");
    console.error("Install it: brew install tmux (macOS) or sudo apt install tmux (Linux)");
    process.exit(1);
  }
}

function checkClaude() {
  try {
    execSync("claude --version", { stdio: "pipe" });
    return true;
  } catch {
    console.error("Warning: claude CLI not found on PATH.");
    console.error("Install Claude Code: https://claude.ai/code");
    return false;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function init() {
  const cwd = process.cwd();
  const dataDir = resolve(cwd, ".superturtle");

  console.log("Super Turtle Setup");
  console.log("==================\n");

  // Check prerequisites
  checkBun();
  checkTmux();
  checkClaude();

  // Create .superturtle/ directory
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("Created .superturtle/");
  }

  // Create .gitignore inside .superturtle/
  const gitignorePath = resolve(dataDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "*\n");
  }

  // Prompt for config if .env doesn't exist
  const envPath = resolve(dataDir, ".env");
  if (!fs.existsSync(envPath)) {
    console.log("\nTelegram Bot Configuration:");
    console.log("  1. Open Telegram and message @BotFather");
    console.log("  2. Send /newbot and follow the prompts");
    console.log("  3. Copy the bot token\n");

    const token = await ask("Bot token: ");
    if (!token) {
      console.error("Bot token is required.");
      process.exit(1);
    }

    console.log("\n  To find your Telegram user ID, message @userinfobot\n");
    const userId = await ask("Your Telegram user ID: ");
    if (!userId) {
      console.error("User ID is required.");
      process.exit(1);
    }

    const openaiKey = await ask("OpenAI API key (for voice, optional — press Enter to skip): ");

    let envContent = `TELEGRAM_BOT_TOKEN=${token}\n`;
    envContent += `TELEGRAM_ALLOWED_USERS=${userId}\n`;
    envContent += `CLAUDE_WORKING_DIR=${cwd}\n`;
    if (openaiKey) {
      envContent += `OPENAI_API_KEY=${openaiKey}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    console.log("\nSaved .superturtle/.env");
  } else {
    console.log(".superturtle/.env already exists, skipping config.");
  }

  // Scaffold CLAUDE.md if not present
  const claudeMdPath = resolve(cwd, "CLAUDE.md");
  const templatePath = resolve(TEMPLATES_DIR, "CLAUDE.md.template");
  if (!fs.existsSync(claudeMdPath) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, claudeMdPath);
    console.log("Created CLAUDE.md from template");
  }

  // Add .superturtle/ and .subturtles/ to project .gitignore
  const projectGitignore = resolve(cwd, ".gitignore");
  if (fs.existsSync(projectGitignore)) {
    const content = fs.readFileSync(projectGitignore, "utf-8");
    const additions = [];
    if (!content.includes(".superturtle/")) additions.push(".superturtle/");
    if (!content.includes(".subturtles/")) additions.push(".subturtles/");
    if (additions.length > 0) {
      fs.appendFileSync(projectGitignore, "\n# Super Turtle\n" + additions.join("\n") + "\n");
      console.log("Updated .gitignore");
    }
  }

  // Install bot dependencies
  console.log("\nInstalling bot dependencies...");
  spawnSync("bun", ["install"], { cwd: BOT_DIR, stdio: "inherit" });

  console.log("\nSetup complete! Run: superturtle start");
}

function start() {
  checkBun();
  checkTmux();

  const cwd = process.cwd();
  const envPath = resolve(cwd, ".superturtle", ".env");

  if (!fs.existsSync(envPath)) {
    console.error("No .superturtle/.env found. Run 'superturtle init' first.");
    process.exit(1);
  }

  // Set environment
  const env = {
    ...process.env,
    SUPER_TURTLE_DIR: PACKAGE_ROOT,
    CLAUDE_WORKING_DIR: cwd,
  };

  // Source .env file
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }

  // Check if tmux session already exists
  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", TMUX_SESSION], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    console.log(`Bot is already running. Attaching to tmux session '${TMUX_SESSION}'...`);
    spawnSync("tmux", ["attach-session", "-t", TMUX_SESSION], { stdio: "inherit" });
    return;
  }

  // Start bot in a new tmux session
  const bunPath = execSync("which bun", { encoding: "utf-8" }).trim();
  const cmd = `cd "${BOT_DIR}" && ${bunPath} run src/index.ts`;

  console.log("Starting Super Turtle bot...");
  spawnSync("tmux", [
    "new-session", "-d", "-s", TMUX_SESSION,
    "-e", `SUPER_TURTLE_DIR=${PACKAGE_ROOT}`,
    "-e", `CLAUDE_WORKING_DIR=${cwd}`,
    ...Object.entries(env)
      .filter(([k]) => k.startsWith("TELEGRAM_") || k.startsWith("OPENAI_") || k.startsWith("CLAUDE_") || k.startsWith("CODEX_") || k === "ALLOWED_PATHS")
      .map(([k, v]) => ["-e", `${k}=${v}`])
      .flat(),
    cmd,
  ], { stdio: "pipe" });

  console.log(`Bot started in tmux session '${TMUX_SESSION}'.`);
  console.log(`Attach: tmux attach -t ${TMUX_SESSION}`);
  console.log("Now message your bot in Telegram!");
}

function stop() {
  // Kill tmux session
  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", TMUX_SESSION], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    spawnSync("tmux", ["kill-session", "-t", TMUX_SESSION], { stdio: "pipe" });
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
    if (proc.stdout?.toString().trim()) {
      console.log(proc.stdout.toString().trim());
    }
  }
}

function status() {
  // Check tmux session
  const tmuxCheck = spawnSync("tmux", ["has-session", "-t", TMUX_SESSION], { stdio: "pipe" });
  if (tmuxCheck.status === 0) {
    console.log("Bot: running");
  } else {
    console.log("Bot: stopped");
  }

  // Check SubTurtles
  const ctlPath = resolve(PACKAGE_ROOT, "subturtle", "ctl");
  if (fs.existsSync(ctlPath)) {
    const proc = spawnSync(ctlPath, ["list"], {
      cwd: process.cwd(),
      env: { ...process.env, SUPER_TURTLE_PROJECT_DIR: process.cwd() },
      stdio: "pipe",
    });
    const output = proc.stdout?.toString().trim();
    if (output) {
      console.log("\nSubTurtles:");
      console.log(output);
    }
  }
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
    console.log(`Super Turtle - Code from anywhere

Usage: superturtle <command>

Commands:
  init      Set up Super Turtle in the current project
  start     Launch the bot
  stop      Stop the bot and all SubTurtles
  status    Show bot and SubTurtle status

Options:
  -v, --version  Show version`);
    if (command && command !== "help" && command !== "--help" && command !== "-h") {
      process.exit(1);
    }
}
