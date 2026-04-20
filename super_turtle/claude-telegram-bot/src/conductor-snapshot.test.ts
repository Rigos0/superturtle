import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  buildPreparedSnapshotPrompt,
  loadConductorSnapshotContext,
} from "./conductor-snapshot";

const tempDirs: string[] = [];

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function appendJsonl(path: string, payloads: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    payloads.map((payload) => JSON.stringify(payload)).join("\n") + "\n",
    "utf-8"
  );
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadConductorSnapshotContext", () => {
  it("summarizes canonical worker state, recent events, and worker wakeups", () => {
    const baseDir = makeTempDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".superturtle/subturtles", "worker-a");
    mkdirSync(workspace, { recursive: true });

    writeJson(join(stateDir, "workers", "worker-a.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-a",
      run_id: "run-a",
      lifecycle_state: "running",
      workspace,
      current_task: "Ship the silent snapshot rewrite",
      checkpoint: {
        recorded_at: "2026-03-08T10:00:00Z",
        iteration: 4,
        loop_type: "yolo",
        head_sha: "1234567890abcdef1234567890abcdef12345678",
      },
      metadata: {
        supervisor: {
          resolved_terminal_state: "completed",
        },
      },
    });

    appendJsonl(join(stateDir, "events.jsonl"), [
      {
        kind: "worker_event",
        schema_version: 1,
        id: "evt-other",
        timestamp: "2026-03-08T09:55:00Z",
        worker_name: "worker-b",
        event_type: "worker.checkpoint",
        emitted_by: "subturtle",
        lifecycle_state: "running",
        payload: {},
      },
      {
        kind: "worker_event",
        schema_version: 1,
        id: "evt-start",
        timestamp: "2026-03-08T09:56:00Z",
        worker_name: "worker-a",
        event_type: "worker.started",
        emitted_by: "subturtle",
        lifecycle_state: "running",
        payload: {},
      },
      {
        kind: "worker_event",
        schema_version: 1,
        id: "evt-checkpoint",
        timestamp: "2026-03-08T10:00:00Z",
        worker_name: "worker-a",
        event_type: "worker.checkpoint",
        emitted_by: "subturtle",
        lifecycle_state: "running",
        payload: {
          kind: "iteration_complete",
          iteration: 4,
        },
      },
    ]);

    writeJson(join(stateDir, "wakeups", "wake-a.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-a",
      worker_name: "worker-a",
      run_id: "run-a",
      category: "notable",
      delivery_state: "pending",
      summary: "Milestone check-in due",
      created_at: "2026-03-08T10:01:00Z",
      updated_at: "2026-03-08T10:01:00Z",
      payload: {
        kind: "milestone_due",
      },
      delivery: {
        attempts: 0,
      },
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-b.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-b",
      worker_name: "worker-b",
      run_id: "run-b",
      category: "silent",
      delivery_state: "pending",
      summary: "Ignore me",
      created_at: "2026-03-08T10:01:00Z",
      updated_at: "2026-03-08T10:01:00Z",
      payload: {},
      delivery: {
        attempts: 0,
      },
      metadata: {},
    });

    const context = loadConductorSnapshotContext({
      stateDir,
      workerName: "worker-a",
    });

    expect(context.prepErrors).toEqual([]);
    expect(context.workspacePath).toBe(workspace);
    expect(context.conductorSummary).toContain("Lifecycle state: running");
    expect(context.conductorSummary).toContain("Current task: Ship the silent snapshot rewrite");
    expect(context.conductorSummary).toContain("Last checkpoint: iteration 4 | yolo | 1234567890ab");
    expect(context.conductorSummary).toContain("Pending wakeups: wake-a: notable/pending | milestone_due | Milestone check-in due");
    expect(context.workerStateJson).toContain('"worker_name": "worker-a"');
    expect(context.recentEventsJson).toContain('"event_type": "worker.checkpoint"');
    expect(context.recentEventsJson).not.toContain("worker-b");
    expect(context.wakeupsJson).toContain('"worker_name": "worker-a"');
    expect(context.wakeupsJson).not.toContain("worker-b");
  });

  it("records a prep error when canonical worker state is missing", () => {
    const baseDir = makeTempDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    mkdirSync(stateDir, { recursive: true });

    const context = loadConductorSnapshotContext({
      stateDir,
      workerName: "missing-worker",
    });

    expect(context.conductorSummary).toContain("Lifecycle state: (missing)");
    expect(context.workerStateJson).toBe("(missing canonical worker state)");
    expect(context.prepErrors[0]).toContain("canonical worker state missing");
  });

  it("includes worker result summary when result file exists", () => {
    const baseDir = makeTempDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(join(stateDir, "results"), { recursive: true });

    writeJson(join(stateDir, "workers", "worker-with-result.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-with-result",
      run_id: "run-wr",
      lifecycle_state: "completed",
      workspace: "/tmp/worker-with-result",
      current_task: "Build the auth system",
      metadata: {},
    });

    writeJson(join(stateDir, "results", "worker-with-result.json"), {
      schema_version: 1,
      worker_name: "worker-with-result",
      completed_at: "2026-04-20T14:00:00Z",
      status: "completed",
      summary: "Implemented JWT middleware with RS256. 12 tests passing.",
      artifacts: ["src/auth/jwt.ts"],
      key_decisions: ["RS256 over HS256"],
      blockers: [],
      questions_for_orchestrator: ["Should refresh TTL be configurable?"],
    });

    const context = loadConductorSnapshotContext({
      stateDir,
      workerName: "worker-with-result",
    });

    expect(context.workerResultJson).toContain("Implemented JWT middleware with RS256");
    expect(context.workerResultJson).toContain("RS256 over HS256");
    expect(context.conductorSummary).toContain("Result: Implemented JWT middleware with RS256");
  });
});

describe("buildPreparedSnapshotPrompt", () => {
  it("prioritizes canonical conductor state over supporting context", () => {
    const prompt = buildPreparedSnapshotPrompt({
      jobId: "job-1",
      subturtleName: "worker-a",
      chatId: 123,
      sourcePrompt: "[SILENT CHECK-IN] Check SubTurtle worker-a: report notable changes only.",
      preparedAtMs: Date.parse("2026-03-08T12:00:00Z"),
      snapshotSeq: 2,
      conductorSummary: "Lifecycle state: running",
      workerStateJson: '{"worker_name":"worker-a"}',
      recentEventsJson: '[{"event_type":"worker.checkpoint"}]',
      wakeupsJson: '[{"delivery_state":"pending"}]',
      workerResultJson: "(no result file)",
      statusOutput: "worker-a running as 999",
      stateExcerpt: "# Current task\n\nShip it",
      gitLog: "abc123 Ship it",
      tunnelUrl: "https://example.trycloudflare.com",
      prepErrors: ["workspace missing: /tmp/worker-a"],
    });

    expect(prompt).toContain("Canonical conductor data (source of truth):");
    expect(prompt).toContain("<conductor_summary>");
    expect(prompt).toContain("<worker_state_json>");
    expect(prompt).toContain("<recent_worker_events_json>");
    expect(prompt).toContain("<worker_wakeups_json>");
    expect(prompt).toContain("Supporting context (secondary):");
    expect(prompt).toContain("Use canonical conductor records as the source of truth.");
    expect(prompt).toContain("If canonical state and supporting context disagree");
    expect(prompt).toContain("do not repeat the same lifecycle alert");
    expect(prompt).toContain("🎉 or ⚠️ or ❌ or 🚀 or 🔗 or 📍");
  });
});
