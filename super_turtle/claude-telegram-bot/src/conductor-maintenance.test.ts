import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { runConductorMaintenance } from "./conductor-maintenance";

const tempDirs: string[] = [];

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-maintenance-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("runConductorMaintenance", () => {
  it("recovers pending terminal work, cleans stale cron once, and stays idempotent on repeat runs", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const archivedWorkspace = join(baseDir, ".subturtles", ".archive", "worker-recover");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(archivedWorkspace, { recursive: true });

    writeFileSync(
      join(archivedWorkspace, "CLAUDE.md"),
      `# Current task

Recover completed worker

# Backlog
- [x] Ship recovered path
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-recover.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-recover",
      run_id: "run-recover",
      lifecycle_state: "completion_pending",
      workspace: archivedWorkspace,
      cron_job_id: "cron-recover",
      current_task: "Recover completed worker",
      completion_requested_at: "2026-03-08T00:00:00Z",
      metadata: {},
    });
    writeJson(join(stateDir, "workers", "worker-orphan.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-orphan",
      run_id: "run-orphan",
      lifecycle_state: "running",
      workspace: join(baseDir, ".subturtles", "worker-orphan"),
      cron_job_id: "cron-orphan",
      current_task: "Clean stale cron",
      metadata: {},
    });

    const jobs = [
      {
        id: "cron-recover",
        type: "recurring" as const,
        job_kind: "subturtle_supervision" as const,
        worker_name: "worker-recover",

      },
      {
        id: "cron-orphan",
        type: "recurring" as const,
        job_kind: "subturtle_supervision" as const,
        worker_name: "worker-orphan",

      },
    ];
    const sentMessages: string[] = [];

    const first = await runConductorMaintenance({
      stateDir,
      defaultChatId: 123,
      listJobs: () => [...jobs],
      removeJob: (id) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index === -1) return false;
        jobs.splice(index, 1);
        return true;
      },
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      isWorkerRunning: () => false,
      nowIso: (() => {
        const timestamps = [
          "2026-03-08T01:00:00Z",
          "2026-03-08T01:00:01Z",
          "2026-03-08T01:00:02Z",
        ];
        let index = 0;
        return () => timestamps[Math.min(index++, timestamps.length - 1)]!;
      })(),
    });

    expect(first.recoveredWakeups).toBe(1);
    expect(first.staleCronRemoved).toBe(1);
    expect(first.staleCronNotified).toBe(1);
    expect(first.sent).toBe(1);
    expect(jobs).toHaveLength(0);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages.some((text) => text.includes("🎉 Finished: worker-recover"))).toBe(true);
    expect(sentMessages.some((text) => text.includes("⚠️ SubTurtle worker-orphan is not running"))).toBe(true);

    const second = await runConductorMaintenance({
      stateDir,
      defaultChatId: 123,
      listJobs: () => [...jobs],
      removeJob: () => false,
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      isWorkerRunning: () => false,
      nowIso: () => "2026-03-08T01:10:00Z",
    });

    expect(second.recoveredWakeups).toBe(0);
    expect(second.staleCronRemoved).toBe(0);
    expect(second.staleCronNotified).toBe(0);
    expect(second.sent).toBe(0);
    expect(second.reconciled).toBe(0);
    expect(sentMessages).toHaveLength(2);

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.recovered"');
    expect(events).toContain('"event_type":"worker.completed"');
    expect(events).toContain('"event_type":"worker.cron_removed"');
  });

  it("requeues in-flight processing wakeups during startup recovery and replays them once", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const archivedWorkspace = join(baseDir, ".subturtles", ".archive", "worker-processing");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(archivedWorkspace, { recursive: true });

    writeFileSync(
      join(archivedWorkspace, "CLAUDE.md"),
      `# Current task

Replay in-flight completion

# Backlog
- [x] Finish the replayable path
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-processing.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-processing",
      run_id: "run-processing",
      lifecycle_state: "completion_pending",
      workspace: archivedWorkspace,
      cron_job_id: "cron-processing",
      current_task: "Replay in-flight completion",
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-processing.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-processing",
      worker_name: "worker-processing",
      run_id: "run-processing",
      category: "notable",
      delivery_state: "processing",
      summary: "worker processing",
      created_at: "2026-03-08T00:00:00Z",
      updated_at: "2026-03-08T00:00:01Z",
      delivery: {
        attempts: 1,
        last_attempt_at: "2026-03-08T00:00:01Z",
      },
      payload: { kind: "completion_requested" },
      metadata: {},
    });

    const jobs = [
      {
        id: "cron-processing",
        type: "recurring" as const,
        job_kind: "subturtle_supervision" as const,
        worker_name: "worker-processing",

      },
    ];
    const sentMessages: string[] = [];

    const first = await runConductorMaintenance({
      stateDir,
      defaultChatId: 123,
      recoverInFlightWakeups: true,
      listJobs: () => [...jobs],
      removeJob: (id) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index === -1) return false;
        jobs.splice(index, 1);
        return true;
      },
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      isWorkerRunning: () => false,
      nowIso: (() => {
        const timestamps = [
          "2026-03-08T01:20:00Z",
          "2026-03-08T01:20:01Z",
          "2026-03-08T01:20:02Z",
        ];
        let index = 0;
        return () => timestamps[Math.min(index++, timestamps.length - 1)]!;
      })(),
    });

    expect(first.requeuedWakeups).toBe(1);
    expect(first.recoveredWakeups).toBe(0);
    expect(first.sent).toBe(1);
    expect(sentMessages).toEqual([
      expect.stringContaining("🎉 Finished: worker-processing"),
    ]);

    const wakeup = JSON.parse(
      readFileSync(join(stateDir, "wakeups", "wake-processing.json"), "utf-8")
    );
    expect(wakeup.delivery_state).toBe("sent");
    expect(wakeup.delivery.attempts).toBe(2);

    const second = await runConductorMaintenance({
      stateDir,
      defaultChatId: 123,
      recoverInFlightWakeups: true,
      listJobs: () => [...jobs],
      removeJob: () => false,
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      isWorkerRunning: () => false,
      nowIso: () => "2026-03-08T01:30:00Z",
    });

    expect(second.requeuedWakeups).toBe(0);
    expect(second.sent).toBe(0);
    expect(sentMessages).toHaveLength(1);

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.recovered"');
    expect(events).toContain('"recovery_kind":"requeued_processing_wakeup"');
    expect(events).toContain('"event_type":"worker.completed"');
  });

  it("does not let an old-run wakeup block stale cron cleanup for a new run with the same worker name", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });

    writeJson(join(stateDir, "workers", "worker-reused.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-reused",
      run_id: "run-new",
      lifecycle_state: "running",
      workspace: join(baseDir, ".subturtles", "worker-reused"),
      cron_job_id: "cron-new",
      current_task: "Current reused run",
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-old-run.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-old-run",
      worker_name: "worker-reused",
      run_id: "run-old",
      category: "notable",
      delivery_state: "pending",
      summary: "old run completed",
      created_at: "2026-03-08T00:00:00Z",
      updated_at: "2026-03-08T00:00:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "completion_requested" },
      metadata: {},
    });

    const jobs = [
      {
        id: "cron-new",
        type: "recurring" as const,
        job_kind: "subturtle_supervision" as const,
        worker_name: "worker-reused",

      },
    ];
    const sentMessages: string[] = [];

    const result = await runConductorMaintenance({
      stateDir,
      defaultChatId: 123,
      listJobs: () => [...jobs],
      removeJob: (id) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index === -1) return false;
        jobs.splice(index, 1);
        return true;
      },
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      isWorkerRunning: () => false,
      nowIso: () => "2026-03-08T01:40:00Z",
    });

    expect(result.staleCronRemoved).toBe(1);
    expect(result.staleCronNotified).toBe(1);
    expect(jobs).toHaveLength(0);
    expect(sentMessages[0]).toContain("⚠️ SubTurtle worker-reused is not running");
  });
});
