/**
 * Super Turtle Dashboard — dead-simple status page.
 * Run: bun run super_turtle/dashboard/server.ts
 */

import { $ } from "bun";
import { readFileSync } from "fs";
import { resolve } from "path";

const PORT = Number(process.env.DASHBOARD_PORT) || 7777;
const REPO_ROOT = resolve(import.meta.dir, "../..");
const CTL = resolve(REPO_ROOT, "super_turtle/subturtle/ctl");
const CRON_FILE = resolve(REPO_ROOT, ".superturtle/cron-jobs.json");
const CLAUDE_MD = resolve(REPO_ROOT, "CLAUDE.md");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function shell(cmd: string[]): Promise<string> {
  try {
    const result = Bun.spawnSync({ cmd, cwd: REPO_ROOT });
    return result.stdout.toString().trim();
  } catch {
    return "(error)";
  }
}

function readJSON(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function formatCronJob(job: Record<string, unknown>): string {
  const id = String(job.id ?? "?");
  const type = String(job.type ?? "?");
  const silent = job.silent ? "silent" : "loud";
  const prompt = String(job.prompt ?? "").slice(0, 80);
  const fireAt = job.fire_at ? new Date(Number(job.fire_at)).toLocaleTimeString() : "?";
  const interval = job.interval_ms ? `every ${Math.round(Number(job.interval_ms) / 60000)}m` : "one-shot";
  return `<tr><td>${esc(id)}</td><td>${esc(type)}</td><td>${esc(interval)}</td><td>${esc(silent)}</td><td>${esc(fireAt)}</td><td title="${esc(String(job.prompt ?? ""))}">${esc(prompt)}…</td></tr>`;
}

function extractCurrentTask(md: string): string {
  const match = md.match(/## Current [Tt]ask\s*\n([\s\S]*?)(?=\n## |\n$)/);
  return match ? match[1].trim() : "(none)";
}

async function buildPage(): Promise<string> {
  const [listOutput, gitLog] = await Promise.all([
    shell([CTL, "list"]),
    shell(["git", "log", "--oneline", "-15"]),
  ]);

  const cronData = readJSON(CRON_FILE);
  const cronJobs = Array.isArray(cronData) ? cronData : [];
  const claudeMd = (() => { try { return readFileSync(CLAUDE_MD, "utf-8"); } catch { return ""; } })();
  const currentTask = extractCurrentTask(claudeMd);

  const now = new Date().toLocaleString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Super Turtle Dashboard</title>
<meta http-equiv="refresh" content="15">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: monospace; font-size: 14px; background: #111; color: #ccc; padding: 20px; }
  h1 { color: #4a9; font-size: 18px; margin-bottom: 4px; }
  .ts { color: #666; font-size: 12px; margin-bottom: 20px; }
  h2 { color: #888; font-size: 14px; margin: 16px 0 6px; border-bottom: 1px solid #333; padding-bottom: 4px; }
  pre { background: #1a1a1a; padding: 10px; overflow-x: auto; line-height: 1.5; border: 1px solid #222; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #222; }
  th { color: #888; font-weight: normal; }
  .running { color: #4a9; }
  .stopped { color: #666; }
  .empty { color: #555; font-style: italic; }
  .task { color: #aaa; background: #1a1a1a; padding: 8px; border: 1px solid #222; }
</style>
</head>
<body>

<h1>🐢 Super Turtle Dashboard</h1>
<div class="ts">Last refresh: ${esc(now)} · auto-refreshes every 15s</div>

<h2>Current Task</h2>
<div class="task">${esc(currentTask)}</div>

<h2>SubTurtles</h2>
${listOutput ? `<pre>${esc(listOutput)}</pre>` : '<div class="empty">No SubTurtles</div>'}

<h2>Cron Jobs (${cronJobs.length})</h2>
${cronJobs.length > 0 ? `
<table>
<tr><th>ID</th><th>Type</th><th>Interval</th><th>Mode</th><th>Next Fire</th><th>Prompt</th></tr>
${cronJobs.map((j: Record<string, unknown>) => formatCronJob(j)).join("\n")}
</table>` : '<div class="empty">No cron jobs</div>'}

<h2>Recent Commits</h2>
<pre>${esc(gitLog)}</pre>

</body>
</html>`;
}

Bun.serve({
  port: PORT,
  async fetch() {
    const html = await buildPage();
    return new Response(html, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
});

console.log(`🐢 Dashboard running at http://localhost:${PORT}`);
