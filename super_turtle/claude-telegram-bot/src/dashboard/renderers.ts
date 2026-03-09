import { getSessionObservabilityProvider } from "../session-observability";
import type {
  JobDetailResponse,
  ProcessDetailResponse,
  SessionDetailResponse,
  SessionTurnView,
  SubturtleDetailResponse,
  SubturtleLogsResponse,
} from "../dashboard-types";
import {
  escapeHtml,
  formatTimestamp,
  renderBacklogChecklist,
  renderJsonPre,
} from "./helpers";

const DASHBOARD_STICKER_URL = "https://www.gstatic.com/android/keyboard/emojikitchen/20201001/u1f60e/u1f60e_u1f422.png";

const DETAIL_THEME_CSS = `
      :root {
        color-scheme: light;
        --bg: #f7f4ee;
        --panel: #fffdfa;
        --line: rgba(86, 108, 75, 0.2);
        --text: #161412;
        --muted: #6f675d;
        --code: #f2ede3;
        --accent-olive: #556c4b;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 22px;
        font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif;
        background: radial-gradient(circle at 8% 12%, #fefaf2 0%, var(--bg) 52%, #f1eadf 100%);
        color: var(--text);
        line-height: 1.45;
      }
      .page {
        max-width: 1360px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      h1, h2 { margin: 0; }
      h2 { margin-bottom: 8px; font-size: 18px; }
      p { margin: 0; }
      a { color: var(--accent-olive); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        box-shadow: 0 14px 40px -36px rgba(34, 30, 25, 0.5);
        padding: 14px;
      }
      ul {
        margin: 0;
        padding-left: 20px;
      }
      li + li { margin-top: 4px; }
      .empty-state {
        color: var(--muted);
      }
      .backlog-checklist {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .backlog-checklist li + li {
        margin-top: 0;
      }
      .backlog-item {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--line);
        background: rgba(255, 250, 242, 0.9);
      }
      .backlog-item.current {
        border-color: rgba(85, 108, 75, 0.45);
        background: linear-gradient(135deg, rgba(245, 237, 220, 0.96), rgba(255, 252, 245, 0.96));
        box-shadow: 0 10px 24px -22px rgba(85, 108, 75, 0.85);
      }
      .backlog-item.done {
        color: var(--muted);
      }
      .backlog-item.done .backlog-text {
        text-decoration: line-through;
      }
      .backlog-checkbox {
        color: var(--accent-olive);
        font-size: 15px;
        line-height: 1.35;
      }
      .backlog-text {
        flex: 1;
        min-width: 0;
      }
      .backlog-tag {
        align-self: center;
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(85, 108, 75, 0.12);
        color: var(--accent-olive);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      pre {
        margin: 0;
        padding: 12px;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: var(--code);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
`;

export function renderDashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" href="${DASHBOARD_STICKER_URL}" type="image/png" />
    <title>SuperTurtle Dashboard</title>
    <style>
      html, body { height: 100%; }
      :root {
        color-scheme: light;
        --bg: #f7f4ee;
        --panel: #fffdfa;
        --line: rgba(86, 108, 75, 0.2);
        --text: #161412;
        --muted: #6f675d;
        --chip: #f2ede3;
        --chip-line: rgba(86, 108, 75, 0.25);
        --accent-olive: #556c4b;
        --accent-terracotta: #b66d4b;
        --accent-sage: #8aa67c;
        --track-line: rgba(86, 108, 75, 0.16);
        --track-bg: #f3efe6;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 12px;
        font-family: "Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif;
        color: var(--text);
        background:
          radial-gradient(circle at 8% 12%, #fefaf2 0%, var(--bg) 52%, #f1eadf 100%);
        line-height: 1.45;
        overflow: hidden;
        zoom: 0.75;
      }
      .page {
        max-width: 1800px;
        margin: 0 auto;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .page-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .page-title {
        min-width: 0;
      }
      .dashboard-loading {
        position: fixed;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background:
          radial-gradient(circle at 12% 10%, rgba(255, 250, 242, 0.98) 0%, rgba(247, 244, 238, 0.98) 55%, rgba(241, 234, 223, 0.98) 100%);
        z-index: 20;
        transition: opacity 180ms ease, visibility 180ms ease;
      }
      .dashboard-loading.hidden {
        opacity: 0;
        visibility: hidden;
        pointer-events: none;
      }
      .loading-card {
        text-align: center;
      }
      .loading-sticker {
        width: 72px;
        height: 72px;
        display: block;
        margin: 0 auto 8px;
        filter: drop-shadow(0 10px 24px rgba(34, 30, 25, 0.18));
        animation: turtle-float 1.8s ease-in-out infinite;
      }
      .loading-brand {
        margin: 0;
        font-size: 22px;
        font-weight: 700;
        color: var(--accent-olive);
      }
      .loading-copy {
        margin: 6px 0 0;
        font-size: 13px;
        color: var(--muted);
      }
      @keyframes turtle-float {
        0%, 100% { transform: translateY(0px); }
        50% { transform: translateY(-5px); }
      }
      h1 {
        margin: 0;
      }
      h2 {
        margin: 0;
        font-size: 17px;
      }
      .panel-head {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-bottom: 8px;
      }
      .panel-note {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
      }
      a {
        color: var(--accent-olive);
        text-decoration: none;
      }
      a:hover { text-decoration: underline; }
      .update-indicator {
        flex: 0 0 auto;
        min-width: 240px;
        margin-top: 8px;
        margin-right: 12px;
        text-align: right;
      }
      .update-label {
        display: block;
        margin: 0 0 2px;
        color: var(--muted);
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }
      .update-value {
        display: block;
        color: var(--muted);
        font-size: 12px;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
      }
      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 12px;
        box-shadow: 0 14px 40px -36px rgba(34, 30, 25, 0.5);
        padding: 10px;
        display: flex;
        flex-direction: column;
        min-height: 0;
      }
      .dashboard-grid {
        display: grid;
        grid-template-columns: repeat(12, minmax(0, 1fr));
        grid-template-rows: auto minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr);
        gap: 10px;
        align-items: stretch;
        flex: 1;
        min-height: 0;
      }
      .panel-lanes {
        grid-column: span 12;
        grid-row: 1;
        min-height: 0;
        height: clamp(260px, 34vh, 420px);
      }
      .panel-sessions {
        grid-column: 1 / span 7;
        grid-row: 2;
      }
      .panel-processes {
        grid-column: 8 / span 5;
        grid-row: 2;
      }
      .panel-cron { grid-column: span 6; grid-row: 3; }
      .panel-jobs { grid-column: span 6; grid-row: 3; }
      .panel-queue {
        grid-column: span 12;
        grid-row: 4;
      }
      .table-wrap {
        width: 100%;
        overflow: auto;
        min-height: 0;
        flex: 1;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        padding: 8px 10px;
        text-align: left;
        vertical-align: top;
        overflow-wrap: anywhere;
      }
      .sessions-table th:nth-child(1),
      .sessions-table td:nth-child(1) {
        width: 44%;
      }
      .sessions-table th:nth-child(2),
      .sessions-table td:nth-child(2) {
        width: 9%;
      }
      .sessions-table th:nth-child(3),
      .sessions-table td:nth-child(3) {
        width: 15%;
      }
      .sessions-table th:nth-child(4),
      .sessions-table td:nth-child(4) {
        width: 9%;
      }
      .sessions-table th:nth-child(5),
      .sessions-table td:nth-child(5) {
        width: 23%;
      }
      .session-cell {
        white-space: nowrap;
        overflow: hidden;
      }
      .sessions-table td:nth-child(5) {
        white-space: nowrap;
      }
      .session-link {
        display: inline-block;
        max-width: 100%;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        letter-spacing: 0.03em;
        text-transform: uppercase;
      }
      tbody tr:hover td {
        background: #f8f2e8;
      }
      .status-chip {
        display: inline-block;
        padding: 1px 8px;
        border-radius: 999px;
        border: 1px solid transparent;
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
      }
      .status-running { background: #eaf4e4; color: #3e5137; border-color: #bad1ad; }
      .status-queued { background: #faebdf; color: #93593d; border-color: #e6c6b3; }
      .status-idle { background: #f3eee7; color: #5f564a; border-color: #dbd1c3; }
      .status-error { background: #fdecec; color: #a61b1b; border-color: #f2bcbc; }
      .status-stopped { background: #f5f1eb; color: #756b5e; border-color: #d8cec1; }
      .status-muted { background: #f2eee8; color: #71675b; border-color: #ddd3c5; }
      .lane-list {
        list-style: none;
        padding: 0;
        margin: 0;
        overflow: auto;
        min-height: 0;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .lane-card {
        border: 1px solid rgba(86, 108, 75, 0.2);
        border-radius: 10px;
        padding: 9px 10px;
        background: linear-gradient(180deg, #fffdfa 0%, #faf5eb 100%);
      }
      .lane-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      .lane-main {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }
      .lane-main a {
        color: var(--accent-olive);
      }
      .lane-main .lane-type {
        color: var(--muted);
        font-weight: 500;
      }
      .lane-meta {
        font-size: 12px;
        color: var(--muted);
        white-space: nowrap;
      }
      .lane-progress {
        position: relative;
        border: 1px solid var(--track-line);
        border-radius: 999px;
        min-height: 32px;
        padding: 4px 12px;
        background: var(--track-bg);
        overflow: hidden;
      }
      .lane-progress::before {
        content: "";
        position: absolute;
        left: 12px;
        right: 12px;
        top: 50%;
        height: 2px;
        transform: translateY(-50%);
        background: linear-gradient(90deg, rgba(85,108,75,0.25), rgba(138,166,124,0.35));
      }
      .lane-milestones {
        position: absolute;
        inset: 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        pointer-events: none;
      }
      .lane-milestone {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: #d0c7b9;
        border: 1px solid rgba(86, 108, 75, 0.18);
      }
      .lane-milestone.done {
        background: var(--accent-sage);
        border-color: rgba(86, 108, 75, 0.5);
      }
      .lane-milestone.current {
        background: var(--accent-terracotta);
        border-color: rgba(182, 109, 75, 0.6);
      }
      .lane-turtle {
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 28px;
        height: 28px;
        filter: drop-shadow(0 2px 1px rgba(22, 20, 18, 0.22));
        image-rendering: auto;
      }
      .lane-turtle-fallback {
        position: absolute;
        top: 50%;
        transform: translate(-50%, -50%);
        font-size: 20px;
        filter: drop-shadow(0 2px 1px rgba(22, 20, 18, 0.22));
      }
      .lane-finish {
        position: absolute;
        right: 8px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 14px;
        color: #544c40;
      }
      .lane-current {
        margin-top: 5px;
        font-size: 12px;
        color: #534b40;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .panel-actions {
        margin-top: 10px;
      }
      .panel-btn {
        display: inline-block;
        border: 1px solid var(--chip-line);
        background: var(--chip);
        color: #4d473f;
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 13px;
        cursor: pointer;
      }
      .panel-btn:hover {
        background: #ece4d7;
      }
      .panel-btn[hidden] {
        display: none;
      }
      @media (max-width: 1200px) {
        body {
          overflow: auto;
          zoom: 1;
        }
        .page {
          height: auto;
        }
        .page-header {
          flex-direction: column;
          align-items: stretch;
        }
        .update-indicator {
          min-width: 0;
          text-align: left;
        }
        .dashboard-grid {
          grid-template-rows: auto;
          flex: unset;
        }
        .panel-sessions,
        .panel-lanes,
        .panel-processes,
        .panel-queue,
        .panel-jobs,
        .panel-cron {
          grid-column: span 12;
          grid-row: auto;
        }
      }
    </style>
  </head>
  <body>
    <div id="loadingOverlay" class="dashboard-loading">
      <div class="loading-card">
        <img class="loading-sticker" src="${DASHBOARD_STICKER_URL}" alt="SuperTurtle loading" />
        <p class="loading-brand">SuperTurtle</p>
        <p id="loadingMessage" class="loading-copy">Loading dashboard...</p>
      </div>
    </div>
    <main class="page">
      <header class="page-header">
        <div class="page-title">
          <h1>SuperTurtle Dashboard</h1>
        </div>
        <div class="update-indicator">
          <span class="update-label">Last updated</span>
          <span id="updateBadge" class="update-value">Waiting for first sync</span>
        </div>
      </header>
      <div class="dashboard-grid">
      <section class="panel panel-sessions">
        <h2>Sessions</h2>
        <div class="table-wrap">
          <table class="sessions-table">
            <thead>
              <tr><th>Session</th><th>Driver</th><th>Status</th><th>Messages</th><th>Last seen</th></tr>
            </thead>
            <tbody id="sessionRows">
              <tr><td colspan="5">No sessions found.</td></tr>
            </tbody>
          </table>
        </div>
        <div class="panel-actions">
          <button id="sessionToggleBtn" class="panel-btn" type="button" hidden>Show more sessions</button>
        </div>
      </section>
      <section class="panel panel-lanes">
        <div class="panel-head">
          <h2>SubTurtle Race Lanes</h2>
        </div>
        <ul id="laneRows" class="lane-list">
          <li>No SubTurtle lanes yet.</li>
        </ul>
      </section>
      <section class="panel panel-processes">
        <div class="panel-head">
          <h2>Running Processes</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Kind</th><th>Status</th><th>Time</th><th>Detail</th></tr>
            </thead>
            <tbody id="processRows">
              <tr><td colspan="5">No processes found.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel panel-cron">
        <div class="panel-head">
          <h2>Scheduled Jobs</h2>
          <p class="panel-note">Pending one-shot and recurring jobs that will fire later.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Type</th><th>Next in</th><th>Prompt</th></tr>
            </thead>
            <tbody id="cronRows">
              <tr><td colspan="3">No jobs scheduled.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel panel-jobs">
        <div class="panel-head">
          <h2>Running Jobs</h2>
          <p class="panel-note">Actively executing jobs owned by current processes.</p>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Job</th><th>Owner</th><th>Owner type</th></tr>
            </thead>
            <tbody id="jobRows">
              <tr><td colspan="3">No active jobs.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      <section class="panel panel-queue">
        <div class="panel-head">
          <h2>Queued Messages</h2>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Chat</th><th>Count</th><th>Oldest</th><th>Preview</th></tr>
            </thead>
            <tbody id="queueRows">
              <tr><td colspan="4">No queued messages.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
      </div>
    </main>
    <script>
      const laneRows = document.getElementById("laneRows");
      const sessionRows = document.getElementById("sessionRows");
      const processRows = document.getElementById("processRows");
      const queueRows = document.getElementById("queueRows");
      const cronRows = document.getElementById("cronRows");
      const jobRows = document.getElementById("jobRows");
      const updateBadge = document.getElementById("updateBadge");
      const sessionToggleBtn = document.getElementById("sessionToggleBtn");
      const loadingOverlay = document.getElementById("loadingOverlay");
      const loadingMessage = document.getElementById("loadingMessage");
      const page = document.querySelector(".page");
      const dashboardToken = new URLSearchParams(window.location.search).get("token");
      const POLL_INTERVAL_MS = 5000;
      const RETRY_INTERVAL_MS = 2000;

      // Turtle sticker images per loop type (emoji kitchen combos hosted on gstatic)
      const LANE_STICKERS = {
        "yolo": "https://www.gstatic.com/android/keyboard/emojikitchen/20201001/u1f422/u1f422_u1f525.png",
        "yolo-codex": "https://www.gstatic.com/android/keyboard/emojikitchen/20201001/u1f916/u1f916_u1f422.png",
        "yolo-codex-spark": "https://www.gstatic.com/android/keyboard/emojikitchen/20250430/u1f329-ufe0f/u1f329-ufe0f_u1f422.png",
        "slow": "https://www.gstatic.com/android/keyboard/emojikitchen/20250130/u1f52c/u1f52c_u1f422.png",
      };
      function laneSticker(type) {
        return LANE_STICKERS[type] || LANE_STICKERS["yolo"];
      }
      let sessionsExpanded = false;
      let latestSessions = [];
      let refreshTimer = null;
      let refreshInFlight = false;
      let hasLoadedOnce = false;

      function humanMs(ms) {
        if (ms <= 0) return "0s";
        const total = Math.floor(ms / 1000);
        const sec = total % 60;
        const min = Math.floor(total / 60) % 60;
        const hr = Math.floor(total / 3600);
        if (hr > 0) return hr + "h " + min + "m";
        if (min > 0) return min + "m " + sec + "s";
        return sec + "s";
      }

      function statusClass(status) {
        if (status === "running") return "status-running";
        if (status === "queued") return "status-queued";
        if (status === "error") return "status-error";
        if (status === "stopped") return "status-stopped";
        return "status-idle";
      }

      function sessionStatusClass(status) {
        if (status === "active-running") return "status-running";
        if (status === "active-idle") return "status-idle";
        return "status-muted";
      }

      function laneTurtleLeftPct(done, total) {
        if (!total || total <= 0) return 2;
        const progress = Math.max(0, Math.min(1, done / total));
        return 2 + (progress * 94);
      }

      function escapeHtml(text) {
        return String(text)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      function formatDateTime(value) {
        if (!value) return "n/a";
        const parsed = new Date(value);
        if (Number.isNaN(parsed.getTime())) return String(value);
        const year = parsed.getFullYear();
        const month = String(parsed.getMonth() + 1);
        const day = String(parsed.getDate());
        const hour = String(parsed.getHours()).padStart(2, "0");
        const minute = String(parsed.getMinutes()).padStart(2, "0");
        const second = String(parsed.getSeconds()).padStart(2, "0");
        return day + "." + month + "." + year + " " + hour + ":" + minute + ":" + second;
      }

      function buildApiUrl(path) {
        if (!dashboardToken) return path;
        const url = new URL(path, window.location.origin);
        url.searchParams.set("token", dashboardToken);
        return url.pathname + url.search;
      }

      function setLoadingState(isLoading, message) {
        if (loadingMessage && message) {
          loadingMessage.textContent = message;
        }
        if (page) {
          page.setAttribute("aria-busy", isLoading ? "true" : "false");
        }
        if (!loadingOverlay) return;
        loadingOverlay.classList.toggle("hidden", !isLoading);
      }

      function scheduleNextRefresh(delayMs) {
        if (refreshTimer !== null) {
          window.clearTimeout(refreshTimer);
        }
        refreshTimer = window.setTimeout(() => {
          void loadData();
        }, delayMs);
      }

      function renderSessionRows(sessions) {
        const list = Array.isArray(sessions) ? sessions : [];
        const visible = sessionsExpanded ? list : list.slice(0, 4);
        if (!visible.length) {
          sessionRows.innerHTML = "<tr><td colspan='5'>No sessions found.</td></tr>";
        } else {
          const maxTitleChars = 44;
          const rows = visible.map((s) => {
            const shortId = s.sessionId.length > 8 ? s.sessionId.slice(0, 8) + "…" : s.sessionId;
            const title = s.title ? s.title : "(untitled)";
            const compactTitle = title.length > maxTitleChars
              ? title.slice(0, maxTitleChars - 1) + "…"
              : title;
            const lastSeen = formatDateTime(s.lastActivity || s.savedAt);
            const displayLabel = compactTitle + " (" + shortId + ")";
            return "<tr>" +
              "<td class='session-cell'><a class='session-link' href='/dashboard/sessions/" + encodeURIComponent(s.driver) + "/" + encodeURIComponent(s.sessionId) + "'>" +
              escapeHtml(displayLabel) +
              "</a></td>" +
              "<td>" + escapeHtml(s.driver) + "</td>" +
              "<td><span class='status-chip " + sessionStatusClass(s.status) + "'>" + escapeHtml(s.status) + "</span></td>" +
              "<td>" + String(s.messageCount) + "</td>" +
              "<td>" + escapeHtml(lastSeen) + "</td>" +
              "</tr>";
          });
          sessionRows.innerHTML = rows.join("");
        }

        if (!sessionToggleBtn) return;
        if (list.length <= 4) {
          sessionToggleBtn.hidden = true;
          return;
        }
        const hiddenCount = Math.max(0, list.length - 4);
        sessionToggleBtn.hidden = false;
        sessionToggleBtn.textContent = sessionsExpanded
          ? "Show fewer sessions"
          : "Show " + hiddenCount + " more sessions";
      }

      async function loadData() {
        if (refreshInFlight) return;
        refreshInFlight = true;

        if (!hasLoadedOnce) {
          setLoadingState(true, "Loading dashboard...");
        }

        try {
          const overviewRes = await fetch(buildApiUrl("/api/dashboard/overview"), { cache: "no-store" });
          if (!overviewRes.ok) throw new Error("Failed dashboard overview request");
          const overview = await overviewRes.json();
          const data = overview && typeof overview.dashboard === "object" && overview.dashboard
            ? overview.dashboard
            : {};
          const jobsData = overview && typeof overview.jobs === "object" && overview.jobs
            ? overview.jobs
            : {};
          const sessionsData = overview && typeof overview.sessions === "object" && overview.sessions
            ? overview.sessions
            : {};
          const sessions = Array.isArray(sessionsData.sessions) ? sessionsData.sessions : [];
          const processes = Array.isArray(data.processes) ? data.processes : [];
          const lanes = Array.isArray(data.lanes) ? data.lanes : [];
          const cronJobs = Array.isArray(data.cronJobs) ? data.cronJobs : [];
          const currentJobs = Array.isArray(jobsData.jobs) ? jobsData.jobs : [];
          const deferredQueue = data.deferredQueue && typeof data.deferredQueue === "object"
            ? data.deferredQueue
            : { totalMessages: 0, chats: [] };

          updateBadge.textContent = formatDateTime(overview.generatedAt || data.generatedAt);

          latestSessions = sessions;
          if (latestSessions.length <= 4) {
            sessionsExpanded = false;
          }
          renderSessionRows(latestSessions);

          if (!lanes.length) {
            laneRows.innerHTML = "<li>No SubTurtle lanes yet.</li>";
          } else {
            const rows = lanes.map((lane) => {
              const total = Number(lane.backlogTotal || 0);
              const done = Math.max(0, Math.min(total, Number(lane.backlogDone || 0)));
              const milestones = total > 0
                ? Array.from({ length: total }, (_, idx) => {
                    const isDone = idx < done;
                    const isCurrent = idx === done && done < total;
                    const cls = isCurrent ? "lane-milestone current" : (isDone ? "lane-milestone done" : "lane-milestone");
                    return "<span class='" + cls + "'></span>";
                  }).join("")
                : "";
              const turtleLeft = laneTurtleLeftPct(done, total);
              const currentLine = lane.backlogCurrent
                ? "Current: " + escapeHtml(lane.backlogCurrent)
                : (lane.task ? "Task: " + escapeHtml(lane.task) : "No current item");
              return "<li class='lane-card'>" +
                "<div class='lane-head'>" +
                "<div class='lane-main'><a href='/dashboard/subturtles/" + encodeURIComponent(lane.name) + "'>" + escapeHtml(lane.name) + "</a> <span class='lane-type'>· " + escapeHtml(lane.type) + "</span></div>" +
                "<div class='lane-meta'>" + done + "/" + total + " · " + escapeHtml(lane.status) + " · " + escapeHtml(lane.elapsed) + "</div>" +
                "</div>" +
                "<div class='lane-progress'>" +
                (total > 0 ? "<div class='lane-milestones'>" + milestones + "</div>" : "") +
                "<img class='lane-turtle' src='" + laneSticker(lane.type) + "' style='left:" + turtleLeft.toFixed(2) + "%' onerror=\\"this.outerHTML='<span class=lane-turtle-fallback style=left:" + turtleLeft.toFixed(2) + "%>🐢</span>'\\" />" +
                "<span class='lane-finish'>🏁</span>" +
                "</div>" +
                "<div class='lane-current'>" + currentLine + "</div>" +
                "</li>";
            });
            laneRows.innerHTML = rows.join("");
          }

          if (!processes.length) {
            processRows.innerHTML = "<tr><td colspan='5'>No processes found.</td></tr>";
          } else {
            const rows = processes.map((p) => {
              return "<tr>" +
                "<td><a href='/dashboard/processes/" + encodeURIComponent(p.id) + "'>" +
                escapeHtml(p.label) +
                "</a>" +
                (p.pid && p.pid !== "-" ? " (pid " + escapeHtml(p.pid) + ")" : "") +
                "</td>" +
                "<td>" + escapeHtml(p.kind) + "</td>" +
                "<td><span class='status-chip " + statusClass(p.status) + "'>" + escapeHtml(p.status) + "</span></td>" +
                "<td>" + escapeHtml(p.elapsed) + "</td>" +
                "<td>" + escapeHtml(p.detail || "") + "</td>" +
                "</tr>";
            });
            processRows.innerHTML = rows.join("");
          }

          const queueChats = Array.isArray(deferredQueue.chats) ? deferredQueue.chats : [];
          if (!queueChats.length) {
            queueRows.innerHTML = "<tr><td colspan='4'>No queued messages.</td></tr>";
          } else {
            const rows = queueChats.map((q) => {
              return "<tr>" +
                "<td>" + q.chatId + "</td>" +
                "<td>" + q.size + "</td>" +
                "<td>" + q.oldestAgeSec + "s</td>" +
                "<td>" + escapeHtml((q.preview || []).join(" | ")) + "</td>" +
                "</tr>";
            });
            queueRows.innerHTML = rows.join("");
          }

          if (!cronJobs.length) {
            cronRows.innerHTML = "<tr><td colspan='3'>No jobs scheduled.</td></tr>";
          } else {
            const rows = cronJobs.map((j) => {
              return "<tr>" +
                "<td>" + j.type + "</td>" +
                "<td>" + humanMs(j.fireInMs) + "</td>" +
                "<td>" + escapeHtml(j.promptPreview) + "</td>" +
                "</tr>";
            });
            cronRows.innerHTML = rows.join("");
          }

          if (!currentJobs.length) {
            jobRows.innerHTML = "<tr><td colspan='3'>No current jobs.</td></tr>";
          } else {
            const rows = currentJobs.map((job) => {
              const ownerLink = "/dashboard/processes/" + encodeURIComponent(job.ownerId);
              return "<tr>" +
                "<td><a href='/dashboard/jobs/" + encodeURIComponent(job.id) + "'>" +
                escapeHtml(job.id) +
                "</a></td>" +
                "<td><a href='" + ownerLink + "'>" +
                escapeHtml(job.ownerId) +
                "</a></td>" +
                "<td>" + escapeHtml(job.ownerType) + "</td>" +
                "</tr>";
            });
            jobRows.innerHTML = rows.join("");
          }
          hasLoadedOnce = true;
          setLoadingState(false);
          scheduleNextRefresh(POLL_INTERVAL_MS);
        } catch (error) {
          if (!hasLoadedOnce) {
            updateBadge.textContent = "Waiting for first sync";
          }
          if (!hasLoadedOnce) {
            setLoadingState(true, "Dashboard unavailable. Retrying...");
          }
          scheduleNextRefresh(RETRY_INTERVAL_MS);
        } finally {
          refreshInFlight = false;
        }
      }

      if (sessionToggleBtn) {
        sessionToggleBtn.addEventListener("click", () => {
          sessionsExpanded = !sessionsExpanded;
          renderSessionRows(latestSessions);
        });
      }

      void loadData();
    </script>
  </body>
</html>`;
}

export function renderSubturtleDetailHtml(
  detail: SubturtleDetailResponse,
  logs: SubturtleLogsResponse | null
): string {
  const statusEmoji: Record<string, string> = {
    running: "🟢",
    stopped: "⏹️",
    completed: "✅",
    failed: "❌",
    timed_out: "⏰",
    archived: "📦",
  };
  const lifecycleState = detail.conductor?.lifecycleState || detail.status;
  const statusIcon = statusEmoji[lifecycleState] || statusEmoji[detail.status] || "⚪";

  const countWords = (text: string): number => {
    const matches = text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return matches?.length || 0;
  };

  const injectedItems: Array<{ label: string; wordCount: number; content: string; open?: boolean }> = [];

  if (detail.claudeMd) {
    injectedItems.push({
      label: "SubTurtle CLAUDE.md",
      wordCount: countWords(detail.claudeMd),
      content: detail.claudeMd,
    });
  }

  if (detail.rootClaudeMd) {
    injectedItems.push({
      label: "Root Project CLAUDE.md",
      wordCount: countWords(detail.rootClaudeMd),
      content: detail.rootClaudeMd,
    });
  }

  const agentsMdDesc = detail.agentsMdInfo
    ? detail.agentsMdInfo.exists
      ? detail.agentsMdInfo.target
        ? `Symlink → ${detail.agentsMdInfo.target}`
        : "Regular file (not a symlink)"
      : "Not found"
    : "Unknown";

  if (detail.skills.length > 0) {
    injectedItems.push({
      label: `Skills (${detail.skills.length})`,
      wordCount: 0,
      content: detail.skills.map((s) => `• ${s}`).join("\n"),
      open: true,
    });
  }

  const injectedHtml = injectedItems.length > 0
    ? injectedItems.map((item) => {
        const wordLabel = item.wordCount > 0 ? ` (${item.wordCount} words)` : "";
        const openAttr = item.open ? " open" : "";
        return `<details${openAttr}>` +
          `<summary>${escapeHtml(item.label)}${escapeHtml(wordLabel)}</summary>` +
          `<pre>${escapeHtml(item.content)}</pre>` +
          `</details>`;
      }).join("")
    : `<p class="empty-state">No injected context captured.</p>`;

  const conductorHtml = detail.conductor
    ? (() => {
        const cp = detail.conductor.checkpoint;
        const cpLines: string[] = [];
        if (cp) {
          if (cp.iteration !== undefined && cp.iteration !== null) cpLines.push(`Iteration: ${cp.iteration}`);
          if (cp.loop_type) cpLines.push(`Loop: ${cp.loop_type}`);
          if (cp.head_sha) cpLines.push(`Git SHA: ${String(cp.head_sha).slice(0, 12)}`);
          if (cp.current_task) cpLines.push(`Task: ${String(cp.current_task).slice(0, 80)}`);
          if (cp.recorded_at) cpLines.push(`Recorded: ${formatTimestamp(String(cp.recorded_at))}`);
        }
        return `<div class="conductor-grid">` +
          `<div class="conductor-field"><span class="conductor-label">Lifecycle</span><span class="conductor-value">${statusIcon} ${escapeHtml(detail.conductor.lifecycleState)}</span></div>` +
          `<div class="conductor-field"><span class="conductor-label">Run ID</span><span class="conductor-value mono">${escapeHtml(detail.conductor.runId || "n/a")}</span></div>` +
          (detail.conductor.stopReason ? `<div class="conductor-field"><span class="conductor-label">Stop reason</span><span class="conductor-value">${escapeHtml(detail.conductor.stopReason)}</span></div>` : "") +
          `<div class="conductor-field"><span class="conductor-label">Created</span><span class="conductor-value">${escapeHtml(formatTimestamp(detail.conductor.createdAt))}</span></div>` +
          `<div class="conductor-field"><span class="conductor-label">Updated</span><span class="conductor-value">${escapeHtml(formatTimestamp(detail.conductor.updatedAt))}</span></div>` +
          (detail.conductor.terminalAt ? `<div class="conductor-field"><span class="conductor-label">Terminal at</span><span class="conductor-value">${escapeHtml(formatTimestamp(detail.conductor.terminalAt))}</span></div>` : "") +
          `</div>` +
          (cpLines.length > 0
            ? `<details open><summary>Last checkpoint</summary><ul class="checkpoint-list">${cpLines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul></details>`
            : `<p class="empty-state">No checkpoint recorded.</p>`);
      })()
    : `<p class="empty-state">No conductor state found for this worker.</p>`;

  const eventsHtml = detail.events.length > 0
    ? `<div class="timeline">${detail.events.map((evt) => {
        const evtEmoji: Record<string, string> = {
          "worker.started": "🚀",
          "worker.stop_requested": "🛑",
          "worker.stopped": "⏹️",
          "worker.archived": "📦",
          "worker.completed": "✅",
          "worker.failed": "❌",
          "worker.timed_out": "⏰",
          "worker.cron_removed": "🗑️",
          "worker.checkpoint": "📍",
          "worker.milestone_reached": "🏁",
          "worker.stalled_check": "⚠️",
        };
        const icon = evtEmoji[evt.eventType] || "•";
        return `<div class="timeline-event">` +
          `<span class="timeline-icon">${icon}</span>` +
          `<div class="timeline-body">` +
          `<span class="timeline-type">${escapeHtml(evt.eventType.replace("worker.", ""))}</span>` +
          `<span class="timeline-meta">${escapeHtml(formatTimestamp(evt.timestamp))} · ${escapeHtml(evt.emittedBy)}</span>` +
          `</div>` +
          `</div>`;
      }).join("")}</div>`
    : `<p class="empty-state">No events recorded.</p>`;

  const pct = detail.backlogSummary.progressPct;
  const progressHtml = detail.backlog.length > 0
    ? `<div class="progress-bar-container">` +
      `<div class="progress-bar" style="width:${pct}%"></div>` +
      `<span class="progress-label">${detail.backlogSummary.done}/${detail.backlogSummary.total} (${pct}%)</span>` +
      `</div>`
    : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(detail.name)} — SubTurtle detail</title>
    <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='0.9em' font-size='90'>🐢</text></svg>" />
    <style>
${DETAIL_THEME_CSS}
      /* ── Detail page extensions ──────────────────────────────── */
      .header-row {
        display: flex;
        align-items: center;
        gap: 14px;
        flex-wrap: wrap;
      }
      .header-row h1 { flex: none; margin: 0; }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.02em;
        border: 1px solid var(--line);
        background: rgba(255, 252, 245, 0.96);
      }
      .status-badge.running { border-color: rgba(85, 108, 75, 0.4); color: var(--accent-olive); }
      .status-badge.stopped { border-color: rgba(111, 103, 93, 0.3); color: var(--muted); }
      .status-badge.completed { border-color: rgba(85, 108, 75, 0.4); color: var(--accent-olive); }
      .status-badge.failed { border-color: rgba(180, 60, 50, 0.3); color: #a83830; }

      .meta-pills {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 4px;
      }
      .meta-pill {
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.03em;
        border: 1px solid var(--line);
        background: var(--code);
        color: var(--muted);
      }

      .two-col {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }
      @media (max-width: 800px) {
        .two-col { grid-template-columns: 1fr; }
      }

      .progress-bar-container {
        position: relative;
        height: 24px;
        border-radius: 12px;
        border: 1px solid var(--line);
        background: var(--code);
        overflow: hidden;
        margin-bottom: 10px;
      }
      .progress-bar {
        height: 100%;
        background: linear-gradient(135deg, rgba(85, 108, 75, 0.35), rgba(85, 108, 75, 0.2));
        transition: width 0.3s;
      }
      .progress-label {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        color: var(--text);
        letter-spacing: 0.03em;
      }

      .conductor-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .conductor-field {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .conductor-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted);
      }
      .conductor-value {
        font-size: 13px;
        color: var(--text);
      }
      .conductor-value.mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .checkpoint-list {
        margin: 6px 0 0 0;
        padding-left: 18px;
        font-size: 13px;
      }
      .checkpoint-list li + li { margin-top: 2px; }

      .timeline {
        display: flex;
        flex-direction: column;
        gap: 0;
        border-left: 2px solid var(--line);
        margin-left: 10px;
        padding-left: 0;
      }
      .timeline-event {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 0 6px 12px;
        position: relative;
      }
      .timeline-event::before {
        content: "";
        position: absolute;
        left: -5px;
        top: 10px;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--panel);
        border: 2px solid var(--line);
      }
      .timeline-icon {
        font-size: 14px;
        flex: none;
        width: 20px;
        text-align: center;
      }
      .timeline-body {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .timeline-type {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }
      .timeline-meta {
        font-size: 11px;
        color: var(--muted);
      }

      .injected-context details {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px 10px;
        background: #fff;
      }
      .injected-context details + details { margin-top: 8px; }
      .injected-context summary {
        cursor: pointer;
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }

      .agents-md-note {
        font-size: 12px;
        color: var(--muted);
        margin-bottom: 8px;
        padding: 6px 10px;
        border-radius: 8px;
        background: var(--code);
        border: 1px solid var(--line);
      }
      .agents-md-note code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11px;
      }
    </style>
  </head>
  <body>
    <main class="page">
      <p style="margin:0"><a href="/dashboard">← Dashboard</a></p>

      <div class="header-row">
        <h1>${escapeHtml(detail.name)}</h1>
        <span class="status-badge ${escapeHtml(lifecycleState)}">${statusIcon} ${escapeHtml(lifecycleState)}</span>
      </div>

      <div class="meta-pills">
        <span class="meta-pill">${escapeHtml(detail.type)}</span>
        ${detail.pid ? `<span class="meta-pill">PID ${escapeHtml(detail.pid)}</span>` : ""}
        ${detail.elapsed && detail.elapsed !== "0s" ? `<span class="meta-pill">${escapeHtml(detail.elapsed)} elapsed</span>` : ""}
        ${detail.timeRemaining ? `<span class="meta-pill">${escapeHtml(detail.timeRemaining)} remaining</span>` : ""}
        ${detail.tunnelUrl ? `<span class="meta-pill"><a href="${escapeHtml(detail.tunnelUrl)}" target="_blank">🔗 Preview</a></span>` : ""}
        ${detail.skills.length > 0 ? detail.skills.map((s) => `<span class="meta-pill">⚡ ${escapeHtml(s)}</span>`).join("") : ""}
      </div>

      ${detail.task ? `<section class="card"><p style="margin:0;font-size:14px"><strong>Task:</strong> ${escapeHtml(detail.task)}</p></section>` : ""}

      ${progressHtml ? `<section class="card"><h2>Progress</h2>${progressHtml}${renderBacklogChecklist(detail.backlog)}</section>` : `<section class="card"><h2>Backlog</h2>${renderBacklogChecklist(detail.backlog)}</section>`}

      <div class="two-col">
        <section class="card">
          <h2>Conductor state</h2>
          ${conductorHtml}
        </section>

        <section class="card">
          <h2>Event timeline</h2>
          ${eventsHtml}
        </section>
      </div>

      <section class="card injected-context">
        <h2>Injected context</h2>
        <div class="agents-md-note">
          <code>AGENTS.md</code>: ${escapeHtml(agentsMdDesc)}
        </div>
        ${injectedHtml}
      </section>

      <section class="card">
        <h2>subturtle.meta</h2>
        <details>
          <summary>Raw metadata (JSON)</summary>
          ${renderJsonPre(detail.meta)}
        </details>
      </section>

      <section class="card">
        <h2>Logs${logs ? ` <span style="font-size:12px;color:var(--muted);font-weight:400">(${logs.totalLines} total lines)</span>` : ""}</h2>
        <pre>${escapeHtml(logs?.lines.join("\n") || "No logs")}</pre>
      </section>
    </main>
  </body>
</html>`;
}

export function renderSessionDetailHtml(
  detail: SessionDetailResponse,
  turns: SessionTurnView[]
): string {
  type InjectedArtifactView = {
    id: string;
    label: string;
    order: number;
    exactText: string;
    preview: string;
  };

  type ConversationRow = {
    role: "system" | "user" | "assistant";
    timestamp: string;
    text: string;
    html?: string;
    turn?: SessionTurnView;
  };

  const buildPreview = (text: string): string => {
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return "(empty)";
    const preview = lines.slice(0, 2).join(" ");
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  };

  const countWords = (text: string): number => {
    const matches = text.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g);
    return matches?.length || 0;
  };
  const instructionDelivery = getSessionObservabilityProvider(detail.session.driver).getInstructionDelivery();
  const instructionTooltipHtml =
    "<div class=\"info-popover\"><p><strong>" +
    escapeHtml(instructionDelivery.title) +
    "</strong></p><ul class=\"info-list\">" +
    instructionDelivery.items.map((item) =>
      `<li><strong>${escapeHtml(item.label)}</strong>: ${escapeHtml(item.description)}</li>`
    ).join("") +
    "</ul></div>";

  const injectedHeadingHtml =
    "<div class=\"injected-heading\">" +
    "<p><strong>Injected context</strong></p>" +
    "<button class=\"info-btn\" type=\"button\" aria-label=\"How instructions are passed to this CLI\">" +
    "i" +
    instructionTooltipHtml +
    "</button>" +
    "</div>";

  const pushArtifact = (
    items: InjectedArtifactView[],
    id: string,
    label: string,
    order: number,
    exactText: string
  ): void => {
    items.push({
      id,
      label,
      order,
      exactText,
      preview: buildPreview(exactText),
    });
  };

  const hasTurns = turns.length > 0;
  const firstTurn = turns[0];
  const history = detail.history || null;
  const hasTurnLogHistory = history?.source === "turn-log";
  const injectedArtifactsById = new Map<string, InjectedArtifactView>();
  const pushNormalizedArtifact = (artifact: {
    id: string;
    label: string;
    order?: number;
    text?: string;
  }): void => {
    const fallbackOrder = artifact.id === "claude-md"
      ? 10
      : artifact.id === "meta-prompt" || artifact.id === "codex-bootstrap-prompt"
        ? 20
        : artifact.id === "date-prefix"
          ? 30
          : artifact.id === "cron-scheduled"
            ? 40
            : artifact.id === "background-snapshot"
              ? 50
              : 999;
    const order = typeof artifact.order === "number" && Number.isFinite(artifact.order)
      ? artifact.order
      : fallbackOrder;
    const normalized: InjectedArtifactView = {
      id: artifact.id,
      label: artifact.label,
      order,
      exactText: artifact.text || "",
      preview: buildPreview(artifact.text || ""),
    };
    const existing = injectedArtifactsById.get(normalized.id);
    if (!existing) {
      injectedArtifactsById.set(normalized.id, normalized);
      return;
    }

    const preferredText = normalized.exactText.trim().length > 0
      ? normalized.exactText
      : existing.exactText;
    injectedArtifactsById.set(normalized.id, {
      ...existing,
      label: existing.label || normalized.label,
      order: Math.min(existing.order, normalized.order),
      exactText: preferredText,
      preview: buildPreview(preferredText),
    });
  };

  for (const artifact of history?.injectedArtifacts || []) {
    pushNormalizedArtifact(artifact);
  }
  for (const artifact of firstTurn?.injectedArtifacts || []) {
    pushNormalizedArtifact(artifact);
  }

  const injectedArtifacts = [...injectedArtifactsById.values()];
  if ((firstTurn || hasTurnLogHistory) && injectedArtifacts.length === 0) {
    pushArtifact(
      injectedArtifacts,
      "legacy",
      "Legacy turn log",
      999,
      "No captured injected artifacts for this turn (legacy log entry)."
    );
  }
  injectedArtifacts.sort((a, b) => a.order - b.order);

  const injectedListHtml = injectedArtifacts.length > 0
    ? injectedHeadingHtml + "<ol class=\"injected-list\">" + injectedArtifacts.map((artifact) => {
      const wordCount = countWords(artifact.exactText);
      const wordLabel = wordCount === 1 ? "word" : "words";
      return "<li><details>" +
        "<summary>" +
        escapeHtml(`${artifact.label} (${wordCount} ${wordLabel})`) +
        "</summary>" +
        "<pre>" + escapeHtml(artifact.exactText) + "</pre>" +
        "</details></li>";
    }).join("") + "</ol>"
    : injectedHeadingHtml + "<p>No captured injections for this session.</p>";

  const conversationRows: ConversationRow[] = [
    {
      role: "system",
      timestamp: formatTimestamp(firstTurn?.startedAt || history?.messages[0]?.timestamp || detail.messages[0]?.timestamp || null),
      text: "",
      html: injectedListHtml,
    },
  ];

  if (hasTurns) {
    for (const turn of turns) {
      conversationRows.push({
        role: "user",
        timestamp: formatTimestamp(turn.startedAt),
        text: turn.originalMessage || "",
        turn,
      });
      const assistantText =
        turn.response && turn.response.trim().length > 0
          ? turn.response
          : turn.status === "completed"
            ? "(No assistant response captured.)"
            : `(No assistant response captured; status: ${turn.status})`;
      conversationRows.push({
        role: "assistant",
        timestamp: formatTimestamp(turn.completedAt || turn.startedAt),
        text: assistantText,
        turn,
      });
    }
  } else {
    for (const msg of history?.messages || detail.messages) {
      conversationRows.push({
        role: msg.role,
        timestamp: formatTimestamp(msg.timestamp),
        text: msg.text,
      });
    }
  }

  const conversationBody = conversationRows.length > 0
    ? conversationRows.map((row) => {
        const turn = row.turn;
        const runtimePromptFlag = detail.session.driver === "codex"
          ? "codex-bootstrap"
          : "meta-prompt";
        const runtimePromptContextLabel = detail.session.driver === "codex"
          ? "Codex bootstrap"
          : "META";
        const injectedFlags = turn
          ? [
              turn.injections.datePrefixApplied ? "date-prefix" : "",
              turn.injections.metaPromptApplied ? runtimePromptFlag : "",
              turn.injections.cronScheduledPromptApplied ? "cron-scheduled" : "",
              turn.injections.backgroundSnapshotPromptApplied ? "background-snapshot" : "",
            ].filter((value) => value.length > 0).join(", ") || "none"
          : "none";
        let debugDetails = "";
        if (turn && row.role === "assistant") {
          debugDetails = "<details><summary>Debug details</summary>" +
            "<pre>" + escapeHtml([
              `Source: ${turn.source}`,
              `Status: ${turn.status}`,
              `Model: ${turn.model}`,
              `Effort: ${turn.effort}`,
              `Elapsed: ${turn.elapsedMs}ms`,
              `Injected flags: ${injectedFlags}`,
              `Context flags: CLAUDE.md=${turn.context.claudeMdLoaded ? "loaded" : "missing"}, ${runtimePromptContextLabel}=${turn.context.metaSharedLoaded ? "loaded" : "missing"}`,
              `Effective prompt follows:`,
              turn.effectivePrompt || "(none)",
              `Error: ${turn.error || "none"}`,
            ].join("\n")) + "</pre>" +
            "<p>Usage</p>" +
            renderJsonPre(turn.usage) +
            "</details>";
        } else if (!hasTurns && hasTurnLogHistory && row.role === "assistant") {
          debugDetails = "<details><summary>Debug details</summary>" +
            "<pre>" + escapeHtml([
              "Source: turn-log history",
              "Status: unavailable",
              "Model: unavailable",
              "Effort: unavailable",
              "Elapsed: unavailable",
              "Turn-level debug details were not available in the loaded session history.",
            ].join("\n")) + "</pre>" +
            "</details>";
        }
        return "<tr>" +
          "<td><span class=\"role-pill\">" + escapeHtml(row.role) + "</span></td>" +
          "<td>" + escapeHtml(row.timestamp) + "</td>" +
          "<td>" + (row.html || ("<pre>" + escapeHtml(row.text || "") + "</pre>")) + debugDetails + "</td>" +
          "</tr>";
      }).join("")
    : "<tr><td colspan='3'>No messages available.</td></tr>";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Session ${escapeHtml(detail.session.sessionId)} detail</title>
    <style>
${DETAIL_THEME_CSS}
      h1, h2 {
        margin: 0 0 12px 0;
      }
      h2 { margin-top: 20px; }
      .card {
        padding: 14px;
      }
      .conversation {
        margin-top: 12px;
        overflow-x: auto;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
      }
      th, td {
        border-bottom: 1px solid var(--line);
        padding: 10px 12px;
        text-align: left;
        vertical-align: top;
      }
      th {
        color: var(--muted);
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .col-role { width: 90px; }
      .col-time { width: 230px; }
      .role-pill {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: #f2ede3;
        font-size: 12px;
      }
      details {
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 8px 10px;
        background: #fff;
      }
      details + details { margin-top: 8px; }
      summary {
        cursor: pointer;
        color: var(--text);
      }
      pre {
        margin: 8px 0 0 0;
        padding: 10px;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: var(--code);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        max-width: 100%;
      }
      .injected-heading {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 8px;
      }
      .injected-heading p {
        margin: 0;
      }
      .info-btn {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--panel);
        color: var(--muted);
        font: inherit;
        font-weight: 700;
        cursor: help;
      }
      .info-popover {
        position: absolute;
        top: calc(100% + 10px);
        right: 0;
        display: none;
        width: min(420px, 70vw);
        padding: 12px 14px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: #1e1b17;
        color: #f7f4ee;
        text-align: left;
        box-shadow: 0 20px 40px rgba(34, 30, 25, 0.25);
        z-index: 10;
      }
      .info-btn:hover .info-popover,
      .info-btn:focus-visible .info-popover {
        display: block;
      }
      .info-popover p {
        margin: 0 0 8px 0;
      }
      .info-list {
        margin: 0;
        padding-left: 18px;
      }
      .info-list li + li {
        margin-top: 6px;
      }
      .injected-list {
        margin: 8px 0 0 20px;
        padding: 0;
      }
      .injected-list li + li { margin-top: 8px; }
      .meta-sections {
        margin-top: 14px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
        gap: 12px;
      }
      .meta-sections details > ul {
        margin: 8px 0 0 0;
        padding-left: 18px;
      }
      .meta-sections details > p {
        margin: 10px 0 4px;
        color: var(--muted);
      }
    </style>
  </head>
  <body>
    <main class="page">
      <h1>Session detail</h1>
      <p><a href="/dashboard">← Back to dashboard</a></p>
      <h2>Conversation</h2>
      <section class="card conversation">
        <table>
          <thead>
            <tr><th class="col-role">Role</th><th class="col-time">Timestamp</th><th>Text</th></tr>
          </thead>
          <tbody>
            ${conversationBody}
          </tbody>
        </table>
      </section>
      <section class="meta-sections">
        <details>
          <summary>Session overview</summary>
          <ul>
            <li>Driver: ${escapeHtml(detail.session.driver)}</li>
            <li>Session ID: ${escapeHtml(detail.session.sessionId)}</li>
            <li>Title: ${escapeHtml(detail.session.title)}</li>
            <li>Status: ${escapeHtml(detail.session.status)}</li>
            <li>Saved at: ${escapeHtml(formatTimestamp(detail.session.savedAt))}</li>
            <li>Last activity: ${escapeHtml(formatTimestamp(detail.session.lastActivity))}</li>
            <li>Messages: ${detail.session.messageCount}</li>
          </ul>
        </details>
        <details>
          <summary>Runtime meta</summary>
          <ul>
            <li>Model: ${escapeHtml(detail.meta.model)}</li>
            <li>Effort: ${escapeHtml(detail.meta.effort)}</li>
            <li>Running: ${detail.meta.isRunning ? "yes" : "no"}</li>
            <li>Query started: ${escapeHtml(formatTimestamp(detail.meta.queryStarted))}</li>
            <li>Current tool: ${escapeHtml(detail.meta.currentTool || "n/a")}</li>
            <li>Last tool: ${escapeHtml(detail.meta.lastTool || "n/a")}</li>
            <li>Last error: ${escapeHtml(detail.meta.lastError || "n/a")}</li>
            <li>Last error time: ${escapeHtml(formatTimestamp(detail.meta.lastErrorTime))}</li>
          </ul>
          <p>Last usage</p>
          ${renderJsonPre(detail.meta.lastUsage)}
        </details>
      </section>
    </main>
  </body>
</html>`;
}

export function renderProcessDetailHtml(
  detail: ProcessDetailResponse,
  logs: SubturtleLogsResponse | null
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Process ${escapeHtml(detail.process.id)} detail</title>
    <style>
${DETAIL_THEME_CSS}
    </style>
  </head>
  <body>
    <main class="page">
      <h1>Process ${escapeHtml(detail.process.id)} detail</h1>
      <p><a href="/dashboard">← Back to dashboard</a></p>
      <section class="card">
        <h2>Core fields</h2>
        <ul>
          <li>Name: ${escapeHtml(detail.process.label)}</li>
          <li>Kind: ${escapeHtml(detail.process.kind)}</li>
          <li>Status: ${escapeHtml(detail.process.status)}</li>
          <li>PID: ${escapeHtml(detail.process.pid)}</li>
          <li>Elapsed: ${escapeHtml(detail.process.elapsed)}</li>
          <li>Detail: ${escapeHtml(detail.process.detail || "n/a")}</li>
        </ul>
      </section>
      <section class="card">
        <h2>Detail JSON</h2>
        ${renderJsonPre(detail)}
      </section>
      ${logs ? `<section class="card"><h2>Logs</h2><pre>${escapeHtml(logs.lines.join("\n") || "No logs")}</pre></section>` : ""}
    </main>
  </body>
</html>`;
}

export function renderJobDetailHtml(
  detail: JobDetailResponse,
  logs: SubturtleLogsResponse | null
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Job ${escapeHtml(detail.job.id)} detail</title>
    <style>
${DETAIL_THEME_CSS}
    </style>
  </head>
  <body>
    <main class="page">
      <h1>Job ${escapeHtml(detail.job.id)} detail</h1>
      <p><a href="/dashboard">← Back to dashboard</a></p>
      <section class="card">
        <h2>Core fields</h2>
        <ul>
          <li>Name: ${escapeHtml(detail.job.name)}</li>
          <li>Owner: <a href="/dashboard/processes/${encodeURIComponent(detail.job.ownerId)}">${escapeHtml(detail.job.ownerId)}</a></li>
          <li>Owner API link: <a href="${escapeHtml(detail.ownerLink)}">${escapeHtml(detail.ownerLink)}</a></li>
          <li>Owner type: ${escapeHtml(detail.job.ownerType)}</li>
          <li>Elapsed: ${escapeHtml(detail.extra.elapsed || "n/a")}</li>
        </ul>
      </section>
      <section class="card">
        <h2>Detail JSON</h2>
        ${renderJsonPre(detail)}
      </section>
      ${logs ? `<section class="card"><h2>Logs</h2><pre>${escapeHtml(logs.lines.join("\n") || "No logs")}</pre></section>` : ""}
    </main>
  </body>
</html>`;
}
