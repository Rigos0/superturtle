import { afterEach, describe, expect, it } from "bun:test";
import { codexSession } from "../codex-session";
import { session } from "../session";
import { getCurrentDriver, getDriver } from "./registry";

const originalActiveDriver = session.activeDriver;
const originalSessionStop = session.stop;
const originalSessionKill = session.kill;
const originalSessionClearStopRequested = session.clearStopRequested;
const originalCodexStop = codexSession.stop;
const originalCodexKill = codexSession.kill;

afterEach(() => {
  session.activeDriver = originalActiveDriver;
  session.stop = originalSessionStop;
  session.kill = originalSessionKill;
  session.clearStopRequested = originalSessionClearStopRequested;
  codexSession.stop = originalCodexStop;
  codexSession.kill = originalCodexKill;
  (session as unknown as { isQueryRunning: boolean }).isQueryRunning = false;
  (codexSession as unknown as { isQueryRunning: boolean }).isQueryRunning = false;
  (codexSession as unknown as { _isProcessing: boolean })._isProcessing = false;
});

describe("driver registry", () => {
  it("returns expected singleton drivers by id", () => {
    const claude = getDriver("claude");
    const codex = getDriver("codex");

    expect(claude.id).toBe("claude");
    expect(codex.id).toBe("codex");
    expect(getDriver("claude")).toBe(claude);
    expect(getDriver("codex")).toBe(codex);
  });

  it("returns the active driver from session state", () => {
    session.activeDriver = "claude";
    expect(getCurrentDriver().id).toBe("claude");

    session.activeDriver = "codex";
    expect(getCurrentDriver().id).toBe("codex");
  });

  it("delegates claude stop/kill through the registry driver", async () => {
    let stopCalls = 0;
    let clearStopRequestedCalls = 0;
    let killCalls = 0;

    (session as unknown as { isQueryRunning: boolean }).isQueryRunning = true;
    session.stop = async () => {
      stopCalls += 1;
      return "stopped";
    };
    session.clearStopRequested = () => {
      clearStopRequestedCalls += 1;
    };
    session.kill = async () => {
      killCalls += 1;
    };

    const driver = getDriver("claude");
    expect(await driver.stop()).toBe("stopped");
    await driver.kill();

    expect(stopCalls).toBe(1);
    expect(clearStopRequestedCalls).toBe(1);
    expect(killCalls).toBe(1);
  });

  it("delegates codex stop/kill through the registry driver", async () => {
    let stopCalls = 0;
    let killCalls = 0;

    (codexSession as unknown as { isQueryRunning: boolean }).isQueryRunning = true;
    codexSession.stop = async () => {
      stopCalls += 1;
      return "stopped";
    };
    codexSession.kill = async () => {
      killCalls += 1;
    };

    const driver = getDriver("codex");
    expect(await driver.stop()).toBe("stopped");
    await driver.kill();

    expect(stopCalls).toBe(1);
    expect(killCalls).toBe(1);
  });
});
