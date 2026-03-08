import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  acknowledgeMetaAgentInboxItems,
  buildMetaAgentInboxPrompt,
  listPendingMetaAgentInboxItems,
} from "./conductor-inbox";
import {
  processPendingConductorWakeups,
  processSilentSubturtleSupervision,
} from "./conductor-supervisor";

const tempDirs: string[] = [];

function makeStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-core-flow-"));
  tempDirs.push(dir);
  return dir;
}

function writeJson(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("conductor core flow scenarios", () => {
  it("covers the single-worker happy path from silent baseline through completion and inbox ack", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".subturtles", "worker-happy");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `# Current task

Ship worker happy

# Backlog
- [x] Bootstrap repo
- [ ] Ship feature
- [ ] Verify cleanup
`,
      "utf-8"
    );
    writeJson(join(stateDir, "workers", "worker-happy.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-happy",
      run_id: "run-happy",
      lifecycle_state: "running",
      workspace,
      cron_job_id: "cron-happy",
      current_task: "Ship worker happy",
      checkpoint: {
        iteration: 1,
        head_sha: "abc123",
        recorded_at: "2026-03-08T10:00:00Z",
      },
      metadata: {},
    });

    const jobs = [{ id: "cron-happy" }];
    const sentMessages: string[] = [];
    const commonOptions = {
      stateDir,
      workerName: "worker-happy",
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
    };

    const baseline = await processSilentSubturtleSupervision({
      ...commonOptions,
      isWorkerRunning: () => true,
      nowIso: () => "2026-03-08T10:05:00Z",
    });

    expect(baseline.createdWakeups).toBe(0);
    expect(sentMessages).toHaveLength(0);
    expect(jobs).toHaveLength(1);

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `# Current task

Ship worker happy

# Backlog
- [x] Bootstrap repo
- [x] Ship feature
- [ ] Verify cleanup
`,
      "utf-8"
    );
    writeFileSync(join(workspace, ".tunnel-url"), "https://preview.example.test/happy\n", "utf-8");
    const workerAfterBaseline = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-happy.json"), "utf-8")
    );
    writeJson(join(stateDir, "workers", "worker-happy.json"), {
      ...workerAfterBaseline,
      checkpoint: {
        iteration: 2,
        head_sha: "def456",
        recorded_at: "2026-03-08T10:10:00Z",
      },
    });

    const milestone = await processSilentSubturtleSupervision({
      ...commonOptions,
      isWorkerRunning: () => true,
      nowIso: () => "2026-03-08T10:10:00Z",
    });

    expect(milestone.createdWakeups).toBe(1);
    expect(milestone.sent).toBe(1);
    expect(sentMessages[0]).toContain("🚀 SubTurtle worker-happy reached a milestone.");
    expect(sentMessages[0]).toContain("✓ Ship feature");
    expect(sentMessages[0]).toContain("🔗 Preview: https://preview.example.test/happy");
    expect(jobs).toEqual([{ id: "cron-happy" }]);

    const workerAfterMilestone = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-happy.json"), "utf-8")
    );
    writeJson(join(stateDir, "workers", "worker-happy.json"), {
      ...workerAfterMilestone,
      lifecycle_state: "completion_pending",
      completion_requested_at: "2026-03-08T10:15:00Z",
      updated_at: "2026-03-08T10:15:00Z",
      updated_by: "subturtle",
    });
    writeJson(join(stateDir, "wakeups", "wake-happy-complete.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-happy-complete",
      worker_name: "worker-happy",
      run_id: "run-happy",
      category: "notable",
      delivery_state: "pending",
      summary: "worker completed",
      created_at: "2026-03-08T10:15:00Z",
      updated_at: "2026-03-08T10:15:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "completion_requested" },
      metadata: { chat_id: 123 },
    });

    const completion = await processPendingConductorWakeups({
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
      nowIso: () => "2026-03-08T10:16:00Z",
    });

    expect(completion.sent).toBe(1);
    expect(sentMessages[1]).toContain("🎉 Finished: worker-happy");
    expect(sentMessages[1]).toContain("✓ Bootstrap repo");
    expect(sentMessages[1]).toContain("✓ Ship feature");
    expect(jobs).toHaveLength(0);

    const completedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-happy.json"), "utf-8")
    );
    expect(completedWorker.lifecycle_state).toBe("completed");
    expect(completedWorker.stop_reason).toBe("completed");
    expect(completedWorker.metadata.supervisor.resolved_terminal_state).toBe("completed");
    expect(completedWorker.metadata.supervisor.cron_removed_at).toBe("2026-03-08T10:16:00Z");
    expect(completedWorker.metadata.supervisor.cleanup_verified_at).toBe("2026-03-08T10:16:00Z");

    const pendingInbox = listPendingMetaAgentInboxItems({ stateDir, chatId: 123 });
    expect(pendingInbox.map((item) => item.category)).toEqual([
      "milestone_reached",
      "completion_requested",
    ]);

    const prompt = buildMetaAgentInboxPrompt(pendingInbox);
    expect(prompt).toContain("[notable] SubTurtle worker-happy milestone");
    expect(prompt).toContain("[notable] SubTurtle worker-happy completed");

    const acknowledged = acknowledgeMetaAgentInboxItems({
      stateDir,
      itemIds: pendingInbox.map((item) => item.id),
      driver: "claude",
      turnId: "turn-happy-1",
      sessionId: "session-happy-1",
      acknowledgedAt: "2026-03-08T10:20:00Z",
    });

    expect(acknowledged).toHaveLength(2);
    expect(listPendingMetaAgentInboxItems({ stateDir, chatId: 123 })).toEqual([]);

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.supervision_checked"');
    expect(events).toContain('"event_type":"worker.milestone_reached"');
    expect(events).toContain('"event_type":"worker.completed"');
    expect(events).toContain('"event_type":"worker.cron_removed"');
    expect(events).toContain('"event_type":"worker.cleanup_verified"');
    expect(events).toContain('"event_type":"worker.inbox_enqueued"');
    expect(events).toContain('"event_type":"worker.notification_sent"');
  });

  it("keeps parallel workers isolated when milestone, completion, and failure events land together", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const milestoneWorkspace = join(baseDir, ".subturtles", "worker-parallel-a");
    const completionWorkspace = join(baseDir, ".subturtles", "worker-parallel-b");
    const failureWorkspace = join(baseDir, ".subturtles", "worker-parallel-c");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(milestoneWorkspace, { recursive: true });
    mkdirSync(completionWorkspace, { recursive: true });
    mkdirSync(failureWorkspace, { recursive: true });

    writeFileSync(
      join(milestoneWorkspace, "CLAUDE.md"),
      `# Current task

Advance worker A

# Backlog
- [x] Bootstrap A
- [ ] Ship A
`,
      "utf-8"
    );
    writeFileSync(
      join(completionWorkspace, "CLAUDE.md"),
      `# Current task

Finish worker B

# Backlog
- [x] Finish worker B
`,
      "utf-8"
    );
    writeFileSync(
      join(failureWorkspace, "CLAUDE.md"),
      `# Current task

Recover worker C
`,
      "utf-8"
    );

    writeJson(join(stateDir, "workers", "worker-parallel-a.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-parallel-a",
      run_id: "run-parallel-a",
      lifecycle_state: "running",
      workspace: milestoneWorkspace,
      cron_job_id: "cron-parallel-a",
      current_task: "Advance worker A",
      checkpoint: {
        iteration: 1,
        head_sha: "aaa111",
        recorded_at: "2026-03-08T11:00:00Z",
      },
      metadata: {},
    });
    writeJson(join(stateDir, "workers", "worker-parallel-b.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-parallel-b",
      run_id: "run-parallel-b",
      lifecycle_state: "completion_pending",
      workspace: completionWorkspace,
      cron_job_id: "cron-parallel-b",
      current_task: "Finish worker B",
      metadata: {},
    });
    writeJson(join(stateDir, "workers", "worker-parallel-c.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-parallel-c",
      run_id: "run-parallel-c",
      lifecycle_state: "failure_pending",
      workspace: failureWorkspace,
      cron_job_id: "cron-parallel-c",
      current_task: "Recover worker C",
      stop_reason: "fatal_error",
      metadata: {},
    });

    const jobs = [
      { id: "cron-parallel-a" },
      { id: "cron-parallel-b" },
      { id: "cron-parallel-c" },
    ];
    const sentMessages: string[] = [];

    const baseline = await processSilentSubturtleSupervision({
      stateDir,
      workerName: "worker-parallel-a",
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
      isWorkerRunning: (workerName) => workerName === "worker-parallel-a",
      nowIso: () => "2026-03-08T11:05:00Z",
    });

    expect(baseline.createdWakeups).toBe(0);

    writeFileSync(
      join(milestoneWorkspace, "CLAUDE.md"),
      `# Current task

Advance worker A

# Backlog
- [x] Bootstrap A
- [x] Ship A
`,
      "utf-8"
    );
    const runningWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-parallel-a.json"), "utf-8")
    );
    writeJson(join(stateDir, "workers", "worker-parallel-a.json"), {
      ...runningWorker,
      checkpoint: {
        iteration: 2,
        head_sha: "bbb222",
        recorded_at: "2026-03-08T11:10:00Z",
      },
    });

    const milestone = await processSilentSubturtleSupervision({
      stateDir,
      workerName: "worker-parallel-a",
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
      isWorkerRunning: (workerName) => workerName === "worker-parallel-a",
      nowIso: () => "2026-03-08T11:10:00Z",
    });

    expect(milestone.createdWakeups).toBe(1);
    expect(sentMessages[0]).toContain("🚀 SubTurtle worker-parallel-a reached a milestone.");

    writeJson(join(stateDir, "wakeups", "wake-parallel-b.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-parallel-b",
      worker_name: "worker-parallel-b",
      run_id: "run-parallel-b",
      category: "notable",
      delivery_state: "pending",
      summary: "worker B completed",
      created_at: "2026-03-08T11:15:00Z",
      updated_at: "2026-03-08T11:15:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "completion_requested" },
      metadata: { chat_id: 123 },
    });
    writeJson(join(stateDir, "wakeups", "wake-parallel-c.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-parallel-c",
      worker_name: "worker-parallel-c",
      run_id: "run-parallel-c",
      category: "critical",
      delivery_state: "pending",
      summary: "worker C failed",
      created_at: "2026-03-08T11:16:00Z",
      updated_at: "2026-03-08T11:16:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "fatal_error", message: "parallel boom" },
      metadata: { chat_id: 123 },
    });

    const terminalDelivery = await processPendingConductorWakeups({
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
      isWorkerRunning: (workerName) => workerName === "worker-parallel-a",
      nowIso: (() => {
        const timestamps = [
          "2026-03-08T11:20:00Z",
          "2026-03-08T11:20:01Z",
        ];
        let index = 0;
        return () => timestamps[Math.min(index++, timestamps.length - 1)]!;
      })(),
    });

    expect(terminalDelivery.sent).toBe(2);
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[1]).toContain("🎉 Finished: worker-parallel-b");
    expect(sentMessages[2]).toContain("❌ SubTurtle worker-parallel-c failed.");
    expect(jobs).toEqual([{ id: "cron-parallel-a" }]);

    const runningState = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-parallel-a.json"), "utf-8")
    );
    const completedState = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-parallel-b.json"), "utf-8")
    );
    const failedState = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-parallel-c.json"), "utf-8")
    );

    expect(runningState.lifecycle_state).toBe("running");
    expect(runningState.metadata.supervisor.cron_removed_at).toBeUndefined();
    expect(completedState.metadata.supervisor.resolved_terminal_state).toBe("completed");
    expect(failedState.metadata.supervisor.resolved_terminal_state).toBe("failed");

    const pendingInbox = listPendingMetaAgentInboxItems({ stateDir, chatId: 123 });
    expect(pendingInbox.map((item) => item.worker_name)).toEqual([
      "worker-parallel-a",
      "worker-parallel-b",
      "worker-parallel-c",
    ]);
    expect(pendingInbox.map((item) => item.category)).toEqual([
      "milestone_reached",
      "completion_requested",
      "fatal_error",
    ]);
  });

  it("reconciles timeout wakeups as a first-class terminal flow", async () => {
    const baseDir = makeStateDir();
    const stateDir = join(baseDir, ".superturtle", "state");
    const workspace = join(baseDir, ".subturtles", "worker-timeout");
    mkdirSync(join(stateDir, "workers"), { recursive: true });
    mkdirSync(join(stateDir, "wakeups"), { recursive: true });
    mkdirSync(workspace, { recursive: true });

    writeFileSync(
      join(workspace, "CLAUDE.md"),
      `# Current task

Finish timeout worker
`,
      "utf-8"
    );
    writeJson(join(stateDir, "workers", "worker-timeout.json"), {
      kind: "worker_state",
      schema_version: 1,
      worker_name: "worker-timeout",
      run_id: "run-timeout",
      lifecycle_state: "timed_out",
      workspace,
      cron_job_id: "cron-timeout",
      current_task: "Finish timeout worker",
      metadata: {},
    });
    writeJson(join(stateDir, "wakeups", "wake-timeout.json"), {
      kind: "wakeup",
      schema_version: 1,
      id: "wake-timeout",
      worker_name: "worker-timeout",
      run_id: "run-timeout",
      category: "critical",
      delivery_state: "pending",
      summary: "worker timed out",
      created_at: "2026-03-08T12:00:00Z",
      updated_at: "2026-03-08T12:00:00Z",
      delivery: { attempts: 0 },
      payload: { kind: "timeout" },
      metadata: { chat_id: 123 },
    });

    const jobs = [{ id: "cron-timeout" }];
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
      nowIso: () => "2026-03-08T12:01:00Z",
    });

    expect(result.sent).toBe(1);
    expect(sentMessages[0]).toContain("❌ SubTurtle worker-timeout timed out.");
    expect(jobs).toHaveLength(0);

    const updatedWorker = JSON.parse(
      readFileSync(join(stateDir, "workers", "worker-timeout.json"), "utf-8")
    );
    expect(updatedWorker.lifecycle_state).toBe("timed_out");
    expect(updatedWorker.stop_reason).toBe("timeout");
    expect(updatedWorker.metadata.supervisor.resolved_terminal_state).toBe("timed_out");
    expect(updatedWorker.metadata.supervisor.cleanup_verified_at).toBe("2026-03-08T12:01:00Z");

    const inboxItem = JSON.parse(
      readFileSync(join(stateDir, "inbox", "inbox_wake-timeout.json"), "utf-8")
    );
    expect(inboxItem.title).toContain("worker-timeout timed out");
    expect(inboxItem.category).toBe("timeout");

    const events = readFileSync(join(stateDir, "events.jsonl"), "utf-8");
    expect(events).toContain('"event_type":"worker.timed_out"');
    expect(events).toContain('"event_type":"worker.cron_removed"');
    expect(events).toContain('"event_type":"worker.cleanup_verified"');
    expect(events).toContain('"event_type":"worker.notification_sent"');
  });
});
