import { describe, expect, it } from "bun:test";
import { isStopIntent, sanitizeUserVisibleErrorMessage } from "./utils";

describe("isStopIntent", () => {
  it("matches direct stop commands", () => {
    expect(isStopIntent("stop")).toBe(true);
    expect(isStopIntent("Stop.")).toBe(true);
    expect(isStopIntent("please pause now")).toBe(true);
    expect(isStopIntent("halt this")).toBe(true);
    expect(isStopIntent("abort")).toBe(true);
    expect(isStopIntent("!")).toBe(true);
    expect(isStopIntent("!stop")).toBe(true);
    expect(isStopIntent("! stop")).toBe(true);
  });

  it("matches common voice and conversational variants", () => {
    expect(isStopIntent("stahp")).toBe(true);
    expect(isStopIntent("stop it please")).toBe(true);
    expect(isStopIntent("can you stop now")).toBe(true);
    expect(isStopIntent("would you please abort current run")).toBe(true);
    expect(isStopIntent("okay can you please halt all subturtles right away")).toBe(true);
    expect(isStopIntent("okay stop now please")).toBe(true);
    expect(isStopIntent("cancél everything now")).toBe(true);
  });

  it("does not match regular sentences or non-stop !commands", () => {
    expect(isStopIntent("how to stop docker container")).toBe(false);
    expect(isStopIntent("unstoppable force")).toBe(false);
    expect(isStopIntent("please continue")).toBe(false);
    expect(isStopIntent("!deploy")).toBe(false);
    expect(isStopIntent("! run tests")).toBe(false);
    expect(isStopIntent("can you deploy stop button")).toBe(false);
    expect(isStopIntent("stop by later")).toBe(false);
    expect(isStopIntent("cancel culture")).toBe(false);
  });
});

describe("sanitizeUserVisibleErrorMessage", () => {
  it("filters the recorded-session error tail", () => {
    expect(
      sanitizeUserVisibleErrorMessage(
        "Request failed. Error: this session was recorded on another machine and cannot be resumed right now."
      )
    ).toBe("Request failed");
  });

  it("falls back when the filtered text would be empty", () => {
    expect(
      sanitizeUserVisibleErrorMessage(
        "Error: this session was recorded elsewhere and is unavailable."
      )
    ).toBe("Something went wrong.");
  });
});
