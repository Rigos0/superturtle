import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  acknowledgeMetaAgentInboxItems,
  buildMetaAgentInboxPrompt,
  listPendingMetaAgentInboxItems,
} from "./conductor-inbox";
import {
  cleanupStaleRecurringSubturtleCron,
  parseCompletedBacklogItems,
  processPendingConductorWakeups,
  processSilentSubturtleSupervision,
  recoverProcessingWakeups,
  recoverPendingWorkerWakeups,
} from "./conductor-supervisor";

const tempDirs: string[] = [];

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseCompletedBacklogItems", () => {
  it("extracts checked backlog items and strips current markers", () => {
    const content = `
# Current task

Ship the feature

# Backlog
- [x] Implement API
- [x] Wire UI <- current
- [ ] Follow-up cleanup
`;

    expect(parseCompletedBacklogItems(content)).toEqual([
      "Implement API",
      "Wire UI",
    ]);
  });
});

describe("recoverPendingWorkerWakeups", () => {
  it("recreates a missing completion wakeup from completion_pending worker state", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const archiveWorkspace = join(baseDir, ".subturtles", ".archive", "worker-recover-complete");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(archiveWorkspace, { recursive: true });

    writeFileSync(
      join(archiveWorkspace, "CLAUDE.md"),
      `# Current task

Recover missing completion wakeup

# Backlog
- [x] Finish recovery path
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-recover-complete.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-recover-complete",
      run_id: "run-recover-complete",
      lifecycle_state: "completion_pending",
      workspace: archiveWorkspace,
      cron_job_id: "cron-recover-complete",
      current_task: "Recover missing completion wakeup",
      completion_requested_at: "2026-03-08T00:00:00Z",
      metadata: {
        supervisor: {
          last_supervision_chat_id: 123,
        },
      },
    });

    const recovered = recoverPendingWorkerWakeups({
      stateDir,
      nowIso: () => "2026-03-08T01:00:00Z",
    });

    expect(recovered.recoveredWakeups).toBe(1);
    expect(recovered.reconciled).toBe(1);

    const wakeupFiles = readdirSync(join(stateDir, "wakeups"));
    expect(wakeupFiles).toHaveLength(1);
    const wakeup = JSON.parse(
      readFileSync(join(stateDir, "wakeups", wakeupFiles[0]!), "utf-8")
    );
    expect(wakeup.payload.kind).toBe("completion_requested");
    expect(wakeup.metadata.chat_id).toBe(123);
    expect(wakeup.metadata.recovered).toBe(true);

    const jobs = [{ id: "cron-recover-complete" }];
    const sentMessages: string[] = [];
    const delivered = await processPendingConductorWakeups({
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
      nowIso: () => "2026-03-08T01:00:01Z",
    });

    expect(delivered.sent).toBe(1);
    expect(sentMessages[0]).toContain("🎉 Finished: worker-recover-complete");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.recovered"');
    expect(events).toContain('"event_type":"worker.completed"');
  });

  it("recreates a missing fatal-error wakeup from failure_pending worker state", () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".subturtles", "worker-recover-failure");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeJson(join(stateDir, "workers", "worker-recover-failure.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-recover-failure",
      run_id: "run-recover-failure",
      lifecycle_state: "failure_pending",
      workspace,
      cron_job_id: "cron-recover-failure",
      current_task: "Recover missing fatal error wakeup",
      stop_reason: "fatal_error",
      metadata: {},
    });
    writeFileSync(
      join(stateDir, "events.jsonl"),
      `${JSON.stringify({
        kind: "worker_event",
        schema_version: 1,
        id: "evt-fatal-recover",
        timestamp: "2026-03-08T00:00:00Z",
        worker_name: "worker-recover-failure",
        run_id: "run-recover-failure",
        event_type: "worker.fatal_error",
        emitted_by: "subturtle",
        lifecycle_state: "failure_pending",
        idempotency_key: null,
        payload: { kind: "fatal_error", message: "recovered boom" },
      })}\n`,
      "utf-8"
    );

    const recovered = recoverPendingWorkerWakeups({
      stateDir,
      nowIso: () => "2026-03-08T01:05:00Z",
    });

    expect(recovered.recoveredWakeups).toBe(1);

    const wakeupFiles = readdirSync(join(stateDir, "wakeups"));
    expect(wakeupFiles).toHaveLength(1);
    const wakeup = JSON.parse(
      readFileSync(join(stateDir, "wakeups", wakeupFiles[0]!), "utf-8")
    );
    expect(wakeup.payload.kind).toBe("fatal_error");
    expect(wakeup.payload.message).toBe("recovered boom");
    expect(wakeup.category).toBe("critical");
  });

  it("ignores stale wakeups from a previous run when recovering the current run", () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".subturtles", "worker-reused");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeJson(join(stateDir, "workers", "worker-reused.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-reused",
      run_id: "run-new",
      lifecycle_state: "completion_pending",
      workspace,
      cron_job_id: "cron-new",
      current_task: "Recover the current reused run",
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
      summary: "old run finished",
      created_at: "2026-03-08T00:00:00Z",
      updated_at: "2026-03-08T00:00:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "completion_requested" },
      metadata: {},
    });

    const recovered = recoverPendingWorkerWakeups({
      stateDir,
      nowIso: () => "2026-03-08T01:06:00Z",
    });

    expect(recovered.recoveredWakeups).toBe(1);

    const wakeupFiles = readdirSync(join(stateDir, "wakeups")).sort();
    expect(wakeupFiles).toHaveLength(2);
    const wakeups = wakeupFiles.map((name) =>
      JSON.parse(readFileSync(join(stateDir, "wakeups", name), "utf-8"))
    );
    expect(
      wakeups.some(
        (wakeup) =>
          wakeup.id !== "wake-old-run" &&
          wakeup.run_id === "run-new" &&
          wakeup.payload.kind === "completion_requested"
      )
    ).toBe(true);
  });
});

describe("recoverProcessingWakeups", () => {
  it("requeues processing wakeups so startup recovery can replay them", () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });

    writeJson(join(stateDir, "workers", "worker-processing.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-processing",
      run_id: "run-processing",
      lifecycle_state: "completion_pending",
      workspace: join(baseDir, ".subturtles", "worker-processing"),
      cron_job_id: "cron-processing",
      current_task: "Recover in-flight wakeup",
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
      summary: "worker finished",
      created_at: "2026-03-08T00:00:00Z",
      updated_at: "2026-03-08T00:00:01Z",
      delivery: {
        attempts: 1,
        last_attempt_at: "2026-03-08T00:00:01Z",
      },
      payload: { kind: "completion_requested" },
      metadata: {},
    });

    const recovered = recoverProcessingWakeups({
      stateDir,
      nowIso: () => "2026-03-08T01:15:00Z",
    });

    expect(recovered.requeuedWakeups).toBe(1);
    expect(recovered.reconciled).toBe(1);

    const wakeup = JSON.parse(
      readFileSync(join(stateDir, "wakeups", "wake-processing.json"), "utf-8")
    );
    expect(wakeup.delivery_state).toBe("pending");
    expect(wakeup.delivery.attempts).toBe(1);
    expect(wakeup.metadata.recovery_kind).toBe("requeued_processing_wakeup");

    const worker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-processing.json"), "utf-8")
    );
    expect(worker.metadata.supervisor.last_requeued_wakeup_id).toBe("wake-processing");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.recovered"');
    expect(events).toContain('"recovery_kind":"requeued_processing_wakeup"');
  });
});

describe("cleanupStaleRecurringSubturtleCron", () => {
  it("removes a stale recurring cron, persists the cleanup event, and warns the operator", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });

    writeJson(join(stateDir, "workers", "worker-stale-cron.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-stale-cron",
      run_id: "run-stale-cron",
      lifecycle_state: "running",
      workspace: join(baseDir, ".subturtles", "worker-stale-cron"),
      cron_job_id: "cron-stale-cron",
      current_task: "Verify stale cron cleanup",
      metadata: {},
    });

    const jobs = [{ id: "cron-stale-cron" }];
    const sentMessages: string[] = [];
    const result = await cleanupStaleRecurringSubturtleCron({
      stateDir,
      workerName: "worker-stale-cron",
      jobId: "cron-stale-cron",
      chatId: 123,
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
      nowIso: () => "2026-03-08T02:00:00Z",
    });

    expect(result.removed).toBe(true);
    expect(result.notified).toBe(true);
    expect(result.reconciled).toBe(1);
    expect(jobs).toHaveLength(0);
    expect(sentMessages[0]).toContain("⚠️ SubTurtle worker-stale-cron is not running");

    const updatedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-stale-cron.json"), "utf-8")
    );
    expect(updatedWorker.metadata.supervisor.cron_removed_reason).toBe("stale_recurring_cron_cleanup");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.cron_removed"');
    expect(events).not.toContain('"event_type":"worker.cleanup_verified"');
  });
});

describe("processPendingConductorWakeups", () => {
  it("reconciles completion wakeups directly from canonical state", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const archiveWorkspace = join(baseDir, ".subturtles", ".archive", "worker-done");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(archiveWorkspace, { recursive: true });

    writeFileSync(
      join(archiveWorkspace, "CLAUDE.md"),
      `# Current task

Ship the shipped thing

# Backlog
- [x] Implement API
- [x] Ship UI
- [ ] Follow-up cleanup
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-done.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-done",
      run_id: "run-done",
      lifecycle_state: "archived",
      workspace: archiveWorkspace,
      cron_job_id: "cron-done",
      current_task: "Ship the shipped thing",
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-done.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-done",
      worker_name: "worker-done",
      run_id: "run-done",
      category: "notable",
      delivery_state: "pending",
      summary: "worker done",
      created_at: "2026-03-08T00:00:00Z",
      updated_at: "2026-03-08T00:00:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "completion_requested" },
      metadata: {},
    });

    const jobs = [{ id: "cron-done" }];
    const sentMessages: Array<{ chatId: number; text: string }> = [];

    const result = await processPendingConductorWakeups({
      stateDir,
      defaultChatId: 123,
      listJobs: () => [...jobs],
      removeJob: (id) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index === -1) return false;
        jobs.splice(index, 1);
        return true;
      },
      sendMessage: async (chatId, text) => {
        sentMessages.push({ chatId, text });
      },
      isWorkerRunning: () => false,
      nowIso: () => "2026-03-08T01:00:00Z",
    });

    expect(result.sent).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]?.text).toContain("🎉 Finished: worker-done");
    expect(sentMessages[0]?.text).toContain("✓ Implement API");
    expect(sentMessages[0]?.text).toContain("✓ Ship UI");
    expect(jobs).toHaveLength(0);

    const updatedWakeup = JSON.parse(
      readFileSync(join(stateDir, "wakeups", "wake-done.json"), "utf-8")
    );
    expect(updatedWakeup.delivery_state).toBe("sent");

    const updatedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-done.json"), "utf-8")
    );
    expect(updatedWorker.lifecycle_state).toBe("archived");
    expect(updatedWorker.metadata.supervisor.resolved_terminal_state).toBe("completed");

    const inboxItem = JSON.parse(
      readFileSync(join(stateDir, "inbox", "inbox_wake-done.json"), "utf-8")
    );
    expect(inboxItem.delivery_state).toBe("pending");
    expect(inboxItem.chat_id).toBe(123);
    expect(inboxItem.title).toContain("worker-done completed");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.cron_removed"');
    expect(events).toContain('"event_type":"worker.cleanup_verified"');
    expect(events).toContain('"event_type":"worker.completed"');
    expect(events).toContain('"event_type":"worker.inbox_enqueued"');
    expect(events).toContain('"event_type":"worker.notification_sent"');
  });

  it("reconciles fatal worker wakeups into a failed state", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".subturtles", "worker-failed");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `# Current task

Recover from a bad crash <- current
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-failed.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-failed",
      run_id: "run-failed",
      lifecycle_state: "failure_pending",
      workspace,
      cron_job_id: "cron-failed",
      current_task: "Recover from a bad crash",
      stop_reason: "fatal_error",
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-failed.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-failed",
      worker_name: "worker-failed",
      run_id: "run-failed",
      category: "critical",
      delivery_state: "pending",
      summary: "worker failed",
      created_at: "2026-03-08T00:00:00Z",
      updated_at: "2026-03-08T00:00:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "fatal_error", message: "boom" },
      metadata: {},
    });

    const jobs = [{ id: "cron-failed" }];
    const sentMessages: string[] = [];

    const result = await processPendingConductorWakeups({
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
      nowIso: () => "2026-03-08T02:00:00Z",
    });

    expect(result.sent).toBe(1);
    expect(sentMessages[0]).toContain("❌ SubTurtle worker-failed failed.");
    expect(sentMessages[0]).toContain("Error: boom");

    const updatedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-failed.json"), "utf-8")
    );
    expect(updatedWorker.lifecycle_state).toBe("failed");
    expect(updatedWorker.metadata.supervisor.resolved_terminal_state).toBe("failed");

    const updatedWakeup = JSON.parse(
      readFileSync(join(stateDir, "wakeups", "wake-failed.json"), "utf-8")
    );
    expect(updatedWakeup.delivery_state).toBe("sent");

    const inboxItem = JSON.parse(
      readFileSync(join(stateDir, "inbox", "inbox_wake-failed.json"), "utf-8")
    );
    expect(inboxItem.title).toContain("worker-failed failed");
    expect(inboxItem.text).toContain("Error: boom");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.failed"');
    expect(events).toContain('"event_type":"worker.inbox_enqueued"');
    expect(events).toContain('"event_type":"worker.notification_sent"');
  });

  it("does not mutate a new run when delivering a stale wakeup from an older run with the same worker name", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const currentWorkspace = join(baseDir, ".subturtles", "worker-reused");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(currentWorkspace, { recursive: true });

    writeFileSync(
      join(currentWorkspace, "CLAUDE.md"),
      `# Current task

New run task

# Backlog
- [ ] Keep working
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-reused.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-reused",
      run_id: "run-new",
      lifecycle_state: "running",
      workspace: currentWorkspace,
      cron_job_id: "cron-new",
      current_task: "New run task",
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-old.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-old",
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

    const jobs = [{ id: "cron-new" }];
    const sentMessages: string[] = [];

    const result = await processPendingConductorWakeups({
      stateDir,
      defaultChatId: 123,
      listJobs: () => [...jobs],
      removeJob: () => false,
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
      },
      isWorkerRunning: () => true,
      nowIso: () => "2026-03-08T02:10:00Z",
    });

    expect(result.sent).toBe(1);
    expect(sentMessages[0]).toContain("🎉 Finished: worker-reused");
    expect(sentMessages[0]).not.toContain("New run task");

    const updatedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-reused.json"), "utf-8")
    );
    expect(updatedWorker.run_id).toBe("run-new");
    expect(updatedWorker.lifecycle_state).toBe("running");
    expect(updatedWorker.metadata).toEqual({});

    const inboxItem = JSON.parse(
      readFileSync(join(stateDir, "inbox", "inbox_wake-old.json"), "utf-8")
    );
    expect(inboxItem.run_id).toBe("run-old");
    expect(inboxItem.metadata.run_mismatch).toBe(true);

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.inbox_enqueued"');
    expect(events).toContain('"event_type":"worker.notification_sent"');
    expect(events).toContain('"run_id":"run-old"');
    expect(events).not.toContain('"event_type":"worker.completed"');
  });

  it("preserves multi-worker inbox delivery across recovery until an interactive turn acknowledges it", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const archivedWorkspace = join(baseDir, ".subturtles", ".archive", "worker-finished");
    const failedWorkspace = join(baseDir, ".subturtles", "worker-crashed");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(archivedWorkspace, { recursive: true });
    mkdirSync(failedWorkspace, { recursive: true });

    writeFileSync(
      join(archivedWorkspace, "CLAUDE.md"),
      `# Current task

Ship worker one

# Backlog
- [x] Finish worker one
`,
      "utf-8"
    );
    writeFileSync(
      join(failedWorkspace, "CLAUDE.md"),
      `# Current task

Recover worker two
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-finished.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-finished",
      run_id: "run-finished",
      lifecycle_state: "archived",
      workspace: archivedWorkspace,
      cron_job_id: "cron-finished",
      current_task: "Ship worker one",
      metadata: {},
    });
    writeJson(join(stateDir, "workers", "worker-crashed.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-crashed",
      run_id: "run-crashed",
      lifecycle_state: "failure_pending",
      workspace: failedWorkspace,
      cron_job_id: "cron-crashed",
      current_task: "Recover worker two",
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-finished.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-finished",
      worker_name: "worker-finished",
      run_id: "run-finished",
      category: "notable",
      delivery_state: "pending",
      summary: "worker finished",
      created_at: "2026-03-08T00:00:00Z",
      updated_at: "2026-03-08T00:00:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "completion_requested" },
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-crashed.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-crashed",
      worker_name: "worker-crashed",
      run_id: "run-crashed",
      category: "critical",
      delivery_state: "pending",
      summary: "worker crashed",
      created_at: "2026-03-08T00:05:00Z",
      updated_at: "2026-03-08T00:05:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "fatal_error", message: "boom again" },
      metadata: {},
    });

    const jobs = [{ id: "cron-finished" }, { id: "cron-crashed" }];
    const sentMessages: string[] = [];

    const result = await processPendingConductorWakeups({
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
        ];
        let index = 0;
        return () => timestamps[Math.min(index++, timestamps.length - 1)]!;
      })(),
    });

    expect(result.sent).toBe(2);
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toContain("🎉 Finished: worker-finished");
    expect(sentMessages[1]).toContain("❌ SubTurtle worker-crashed failed.");
    expect(jobs).toHaveLength(0);

    const pendingInbox = listPendingMetaAgentInboxItems({ stateDir, chatId: 123 });
    expect(pendingInbox.map((item) => item.id)).toEqual([
      "inbox_wake-finished",
      "inbox_wake-crashed",
    ]);
    expect(pendingInbox.map((item) => item.worker_name)).toEqual([
      "worker-finished",
      "worker-crashed",
    ]);

    const prompt = buildMetaAgentInboxPrompt(pendingInbox);
    expect(prompt).toContain("[notable] SubTurtle worker-finished completed");
    expect(prompt).toContain("[critical] SubTurtle worker-crashed failed");

    const acknowledged = acknowledgeMetaAgentInboxItems({
      stateDir,
      itemIds: pendingInbox.map((item) => item.id),
      driver: "claude",
      turnId: "turn-recovery-1",
      sessionId: "session-recovery-1",
      acknowledgedAt: "2026-03-08T01:10:00Z",
    });

    expect(acknowledged).toHaveLength(2);
    expect(listPendingMetaAgentInboxItems({ stateDir, chatId: 123 })).toEqual([]);

    const acknowledgedCrashed = JSON.parse(
      readFileSync(join(stateDir, "inbox", "inbox_wake-crashed.json"), "utf-8")
    );
    expect(acknowledgedCrashed.delivery_state).toBe("acknowledged");
    expect(acknowledgedCrashed.delivery.acknowledged_by_turn_id).toBe("turn-recovery-1");
  });
});

describe("processSilentSubturtleSupervision", () => {
  it("emits deterministic milestone wakeups without removing recurring cron", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".subturtles", "worker-milestone");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `# Current task

Ship milestone worker

# Backlog
- [x] Seed workspace
- [ ] Ship milestone
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-milestone.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-milestone",
      run_id: "run-milestone",
      lifecycle_state: "running",
      workspace,
      cron_job_id: "cron-milestone",
      current_task: "Ship milestone worker",
      checkpoint: {
        iteration: 1,
        head_sha: "abc123",
        recorded_at: "2026-03-08T00:00:00Z",
      },
      metadata: {},
    });

    const jobs = [{ id: "cron-milestone" }];
    const sentMessages: string[] = [];

    const baseline = await processSilentSubturtleSupervision({
      stateDir,
      workerName: "worker-milestone",
      chatId: 123,
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
      isWorkerRunning: () => true,
      nowIso: () => "2026-03-08T01:00:00Z",
    });

    expect(baseline.createdWakeups).toBe(0);
    expect(sentMessages).toHaveLength(0);
    expect(jobs).toHaveLength(1);

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `# Current task

Ship milestone worker

# Backlog
- [x] Seed workspace
- [x] Ship milestone
`,
      "utf-8"
    );
    writeJson(join(stateDir, "workers", "worker-milestone.json"), {
      ...JSON.parse(readFileSync(join(stateDir, "workers", "worker-milestone.json"), "utf-8")),
      checkpoint: {
        iteration: 2,
        head_sha: "def456",
        recorded_at: "2026-03-08T02:00:00Z",
      },
    });

    const result = await processSilentSubturtleSupervision({
      stateDir,
      workerName: "worker-milestone",
      chatId: 123,
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
      isWorkerRunning: () => true,
      nowIso: () => "2026-03-08T02:05:00Z",
    });

    expect(result.createdWakeups).toBe(1);
    expect(result.sent).toBe(1);
    expect(sentMessages.at(-1)).toContain("🚀 SubTurtle worker-milestone reached a milestone.");
    expect(sentMessages.at(-1)).toContain("✓ Ship milestone");
    expect(jobs).toHaveLength(1);

    const updatedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-milestone.json"), "utf-8")
    );
    expect(updatedWorker.metadata.supervisor.last_notified_backlog_done).toBe(2);

    const inboxFiles = readdirSync(join(stateDir, "inbox"));
    expect(inboxFiles).toHaveLength(1);
    const inboxItem = JSON.parse(
      readFileSync(join(stateDir, "inbox", inboxFiles[0]!), "utf-8")
    );
    expect(inboxItem.category).toBe("milestone_reached");
    expect(inboxItem.title).toContain("worker-milestone milestone");
    expect(inboxItem.text).toContain("Milestone items: Ship milestone");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.milestone_reached"');
    expect(events).toContain('"event_type":"worker.inbox_enqueued"');
    expect(events).toContain('"event_type":"worker.notification_sent"');
    expect(events).not.toContain('"event_type":"worker.cron_removed"');
    expect(events).not.toContain('"event_type":"worker.cleanup_verified"');
  });

  it("emits deterministic stuck wakeups after repeated no-progress checks", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".subturtles", "worker-stuck");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `# Current task

Diagnose no-progress worker

# Backlog
- [ ] Figure out why nothing changes
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-stuck.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-stuck",
      run_id: "run-stuck",
      lifecycle_state: "running",
      workspace,
      cron_job_id: "cron-stuck",
      current_task: "Diagnose no-progress worker",
      checkpoint: {
        iteration: 4,
        head_sha: "abc123",
        recorded_at: "2026-03-08T00:00:00Z",
      },
      metadata: {},
    });

    const jobs = [{ id: "cron-stuck" }];
    const sentMessages: string[] = [];
    const commonOptions = {
      stateDir,
      workerName: "worker-stuck",
      chatId: 123,
      defaultChatId: 123,
      listJobs: () => [...jobs],
      removeJob: (id: string) => {
        const index = jobs.findIndex((job) => job.id === id);
        if (index === -1) return false;
        jobs.splice(index, 1);
        return true;
      },
      sendMessage: async (_chatId: number, text: string) => {
        sentMessages.push(text);
      },
      isWorkerRunning: () => true,
    };

    const first = await processSilentSubturtleSupervision({
      ...commonOptions,
      nowIso: () => "2026-03-08T01:00:00Z",
    });
    const second = await processSilentSubturtleSupervision({
      ...commonOptions,
      nowIso: () => "2026-03-08T02:00:00Z",
    });
    const third = await processSilentSubturtleSupervision({
      ...commonOptions,
      nowIso: () => "2026-03-08T03:00:00Z",
    });

    expect(first.createdWakeups).toBe(0);
    expect(second.createdWakeups).toBe(0);
    expect(third.createdWakeups).toBe(1);
    expect(third.sent).toBe(1);
    expect(sentMessages.at(-1)).toContain("⚠️ SubTurtle worker-stuck looks stuck.");
    expect(jobs).toHaveLength(1);

    const updatedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-stuck.json"), "utf-8")
    );
    expect(updatedWorker.metadata.supervisor.last_stuck_signature).toBeDefined();

    const inboxFiles = readdirSync(join(stateDir, "inbox"));
    expect(inboxFiles).toHaveLength(1);
    const inboxItem = JSON.parse(
      readFileSync(join(stateDir, "inbox", inboxFiles[0]!), "utf-8")
    );
    expect(inboxItem.category).toBe("worker_stuck");
    expect(inboxItem.title).toContain("worker-stuck stuck");
    expect(inboxItem.text).toContain("No meaningful progress across 2 silent checks.");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.stuck_detected"');
    expect(events).toContain('"event_type":"worker.inbox_enqueued"');
    expect(events).toContain('"event_type":"worker.notification_sent"');
    expect(events).not.toContain('"event_type":"worker.cron_removed"');
    expect(events).not.toContain('"event_type":"worker.cleanup_verified"');
  });
});
