import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const fixtureRoot = mkdtempSync(join(tmpdir(), "cron-test-"));
const fixtureSrcDir = join(fixtureRoot, "src");
const fixtureCronPath = join(fixtureSrcDir, "cron.ts");
const fixtureLoggerPath = join(fixtureSrcDir, "logger.ts");
const fixtureJobsFile = join(fixtureRoot, "cron-jobs.json");
const realDateNow = Date.now;

mkdirSync(fixtureSrcDir, { recursive: true });
writeFileSync(
  fixtureCronPath,
  readFileSync(new URL("./cron.ts", import.meta.url), "utf-8")
    .replace(`from "./logger";`, `from "./logger.ts";`)
    .replace(`from "./config";`, `from "./config.ts";`)
);
writeFileSync(
  fixtureLoggerPath,
  `export const cronLog = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };\n`
);
const fixtureConfigPath = join(fixtureSrcDir, "config.ts");
writeFileSync(
  fixtureConfigPath,
  `export const SUPERTURTLE_DATA_DIR = ${JSON.stringify(fixtureRoot)};\n`
);

const cronModuleUrl = `${pathToFileURL(fixtureCronPath).href}?ts=${Date.now()}`;
const { addJob, advanceRecurringJob, getDueJobs, loadJobs, reloadJobs, removeJob } = await import(
  cronModuleUrl
);

beforeEach(() => {
  Date.now = realDateNow;
  writeFileSync(fixtureJobsFile, "[]");
  reloadJobs();
});

afterAll(() => {
  Date.now = realDateNow;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("loadJobs()", () => {
  it("normalizes jobs and fills defaults for optional fields", () => {
    writeFileSync(
      fixtureJobsFile,
      JSON.stringify([
        {
          id: "job-1",
          prompt: "hello",
          type: "one-shot",
          fire_at: 1000,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ])
    );

    const jobs = loadJobs();
    expect(jobs).toEqual([
      {
        id: "job-1",
        prompt: "hello",
        chat_id: undefined,
        type: "one-shot",
        interval_ms: null,
        silent: undefined,
        job_kind: undefined,
        worker_name: undefined,
        supervision_mode: undefined,
        fire_at: 1000,
        created_at: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("preserves structured supervision metadata when present", () => {
    writeFileSync(
      fixtureJobsFile,
      JSON.stringify([
        {
          id: "job-structured",
          prompt: "check worker-a",
          type: "recurring",
          interval_ms: 600000,
          silent: true,
          job_kind: "subturtle_supervision",
          worker_name: "worker-a",
          supervision_mode: "silent",
          fire_at: 1000,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ])
    );

    const jobs = loadJobs();
    expect(jobs).toEqual([
      {
        id: "job-structured",
        prompt: "check worker-a",
        chat_id: undefined,
        type: "recurring",
        interval_ms: 600000,
        silent: true,
        job_kind: "subturtle_supervision",
        worker_name: "worker-a",
        supervision_mode: "silent",
        fire_at: 1000,
        created_at: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("drops unsupported supervision metadata during normalization", () => {
    writeFileSync(
      fixtureJobsFile,
      JSON.stringify([
        {
          id: "job-unsupported-mode",
          prompt: "check worker-a",
          type: "recurring",
          interval_ms: 600000,
          silent: true,
          job_kind: "subturtle_supervision",
          worker_name: "worker-a",
          supervision_mode: "legacy",
          fire_at: 1000,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ])
    );

    const jobs = loadJobs();
    expect(jobs).toEqual([
      {
        id: "job-unsupported-mode",
        prompt: "check worker-a",
        chat_id: undefined,
        type: "recurring",
        interval_ms: 600000,
        silent: true,
        job_kind: "subturtle_supervision",
        worker_name: "worker-a",
        supervision_mode: undefined,
        fire_at: 1000,
        created_at: "2026-02-01T00:00:00.000Z",
      },
    ]);
  });

  it("rejects jobs missing required fields by skipping them", () => {
    writeFileSync(
      fixtureJobsFile,
      JSON.stringify([
        {
          id: "job-valid",
          prompt: "ok",
          type: "one-shot",
          fire_at: 1200,
          created_at: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "job-invalid",
          type: "one-shot",
          fire_at: 1200,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ])
    );

    const jobs = loadJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toBe("job-valid");
  });
});

describe("addJob() and removeJob()", () => {
  it("adds a job to disk and loadJobs() returns it", () => {
    Date.now = () => 10_000;

    const added = addJob("run tests", 123, "one-shot", 5000);

    const fromDisk = loadJobs();
    expect(fromDisk).toHaveLength(1);
    expect(fromDisk[0]).toMatchObject({
      id: added.id,
      prompt: "run tests",
      chat_id: 123,
      type: "one-shot",
      interval_ms: null,
      job_kind: undefined,
      worker_name: undefined,
      supervision_mode: undefined,
      fire_at: 15_000,
    });
  });

  it("stores optional structured metadata", () => {
    Date.now = () => 30_000;

    const added = addJob(
      "check worker-a",
      321,
      "recurring",
      undefined,
      60_000,
      true,
      {
        job_kind: "subturtle_supervision",
        worker_name: "worker-a",
        supervision_mode: "silent",
      }
    );

    const fromDisk = loadJobs();
    expect(fromDisk[0]).toMatchObject({
      id: added.id,
      prompt: "check worker-a",
      chat_id: 321,
      type: "recurring",
      interval_ms: 60_000,
      silent: true,
      job_kind: "subturtle_supervision",
      worker_name: "worker-a",
      supervision_mode: "silent",
      fire_at: 90_000,
    });
  });

  it("removes existing jobs and handles missing IDs gracefully", () => {
    Date.now = () => 20_000;

    const added = addJob("cleanup", 999, "one-shot", 1000);
    expect(removeJob(added.id)).toBe(true);
    expect(removeJob("missing-id")).toBe(false);
    expect(loadJobs()).toHaveLength(0);
  });
});

describe("getDueJobs()", () => {
  it("returns only jobs with fire_at <= now, including multiple due jobs", () => {
    writeFileSync(
      fixtureJobsFile,
      JSON.stringify([
        {
          id: "due-1",
          prompt: "first",
          type: "one-shot",
          interval_ms: null,
          fire_at: 1000,
          created_at: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "future",
          prompt: "later",
          type: "one-shot",
          interval_ms: null,
          fire_at: 2000,
          created_at: "2026-02-01T00:00:00.000Z",
        },
        {
          id: "due-2",
          prompt: "second",
          type: "one-shot",
          interval_ms: null,
          fire_at: 1500,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ])
    );

    Date.now = () => 1500;

    const dueJobs = getDueJobs();
    expect(dueJobs.map((job: { id: string }) => job.id).sort()).toEqual(["due-1", "due-2"]);
  });
});

describe("advanceRecurringJob()", () => {
  it("bumps recurring fire_at by interval_ms", () => {
    writeFileSync(
      fixtureJobsFile,
      JSON.stringify([
        {
          id: "recurring",
          prompt: "ping",
          chat_id: 7,
          type: "recurring",
          interval_ms: 300,
          fire_at: 1000,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ])
    );

    Date.now = () => 1100;

    expect(advanceRecurringJob("recurring")).toBe(true);
    expect(loadJobs()[0]?.fire_at).toBe(1400);
  });

  it("does not advance one-shot jobs", () => {
    writeFileSync(
      fixtureJobsFile,
      JSON.stringify([
        {
          id: "oneshot",
          prompt: "once",
          type: "one-shot",
          interval_ms: null,
          fire_at: 1000,
          created_at: "2026-02-01T00:00:00.000Z",
        },
      ])
    );

    Date.now = () => 1300;

    expect(advanceRecurringJob("oneshot")).toBe(false);
    expect(loadJobs()[0]?.fire_at).toBe(1000);
  });
});
