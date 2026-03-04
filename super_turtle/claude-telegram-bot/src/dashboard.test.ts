import { describe, expect, it } from "bun:test";
import { DASHBOARD_AUTH_TOKEN } from "./config";

const { isAuthorized, safeSubstring, computeProgressPct, jsonResponse, notFoundResponse, readFileOr, parseMetaFile, validateSubturtleName } = await import("./dashboard");

const hasAuthToken = DASHBOARD_AUTH_TOKEN.length > 0;
const validToken = hasAuthToken ? DASHBOARD_AUTH_TOKEN : "any-token";

describe("isAuthorized()", () => {
  it("accepts token in query string", () => {
    const request = new Request(`http://localhost/dashboard?token=${encodeURIComponent(validToken)}`);
    expect(isAuthorized(request)).toBe(true);
  });

  it("accepts token in x-dashboard-token header", () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { "x-dashboard-token": validToken },
    });
    expect(isAuthorized(request)).toBe(true);
  });

  it("accepts token in Authorization header", () => {
    const request = new Request("http://localhost/dashboard", {
      headers: { Authorization: `Bearer ${validToken}` },
    });
    expect(isAuthorized(request)).toBe(true);
  });

  it("handles missing token based on auth mode", () => {
    const request = new Request("http://localhost/dashboard");
    expect(isAuthorized(request)).toBe(!hasAuthToken);
  });

  it("handles incorrect token based on auth mode", () => {
    const request = new Request("http://localhost/dashboard?token=wrong-token");
    expect(isAuthorized(request)).toBe(!hasAuthToken);
  });
});

describe("safeSubstring()", () => {
  it("leaves short strings unchanged", () => {
    expect(safeSubstring("short", 10)).toBe("short");
  });

  it("truncates long strings with an ellipsis", () => {
    expect(safeSubstring("abcdefghijklmnopqrstuvwxyz", 5)).toBe("abcde...");
  });

  it("handles empty strings and maxLen=0", () => {
    expect(safeSubstring("", 5)).toBe("");
    expect(safeSubstring("abcdef", 0)).toBe("...");
  });
});

describe("computeProgressPct()", () => {
  it("returns 0 when total is zero", () => {
    expect(computeProgressPct(5, 0)).toBe(0);
  });

  it("returns rounded progress percent", () => {
    expect(computeProgressPct(3, 8)).toBe(38);
  });

  it("clamps to [0, 100]", () => {
    expect(computeProgressPct(-2, 5)).toBe(0);
    expect(computeProgressPct(9, 5)).toBe(100);
  });
});

describe("jsonResponse()", () => {
  it("returns JSON with correct content-type and status 200 by default", async () => {
    const res = jsonResponse({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("accepts a custom status code", () => {
    const res = jsonResponse({ error: "bad" }, 400);
    expect(res.status).toBe(400);
  });
});

describe("notFoundResponse()", () => {
  it("returns 404 with default message", async () => {
    const res = notFoundResponse();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("accepts a custom message", async () => {
    const res = notFoundResponse("no such turtle");
    expect(await res.json()).toEqual({ error: "no such turtle" });
  });
});

describe("readFileOr()", () => {
  it("returns fallback for non-existent file", async () => {
    const result = await readFileOr("/tmp/__nonexistent_test_file__", "default");
    expect(result).toBe("default");
  });
});

describe("parseMetaFile()", () => {
  it("parses a standard subturtle.meta file", () => {
    const content = [
      "SPAWNED_AT=1772626337",
      "TIMEOUT_SECONDS=7200",
      "LOOP_TYPE=yolo",
      'SKILLS=["web"]',
      "WATCHDOG_PID=58912",
      "CRON_JOB_ID=1b61a7",
    ].join("\n");

    const meta = parseMetaFile(content);
    expect(meta.spawnedAt).toBe(1772626337);
    expect(meta.timeoutSeconds).toBe(7200);
    expect(meta.loopType).toBe("yolo");
    expect(meta.skills).toEqual(["web"]);
    expect(meta.watchdogPid).toBe(58912);
    expect(meta.cronJobId).toBe("1b61a7");
  });

  it("handles empty content", () => {
    const meta = parseMetaFile("");
    expect(meta.spawnedAt).toBeNull();
    expect(meta.loopType).toBeNull();
    expect(meta.skills).toEqual([]);
  });

  it("handles empty SKILLS array", () => {
    const meta = parseMetaFile("SKILLS=[]");
    expect(meta.skills).toEqual([]);
  });

  it("ignores comment lines and blank lines", () => {
    const content = "# comment\n\nLOOP_TYPE=slow\n";
    const meta = parseMetaFile(content);
    expect(meta.loopType).toBe("slow");
  });

  it("stores unknown keys in the result", () => {
    const meta = parseMetaFile("CUSTOM_KEY=hello");
    expect(meta.CUSTOM_KEY).toBe("hello");
  });
});

describe("validateSubturtleName()", () => {
  it("accepts valid names", () => {
    expect(validateSubturtleName("my-turtle")).toBe(true);
    expect(validateSubturtleName("dash-foundation")).toBe(true);
    expect(validateSubturtleName("test_123")).toBe(true);
  });

  it("rejects empty names", () => {
    expect(validateSubturtleName("")).toBe(false);
  });

  it("rejects names with path traversal", () => {
    expect(validateSubturtleName("../evil")).toBe(false);
    expect(validateSubturtleName("foo/../bar")).toBe(false);
  });

  it("rejects names with slashes", () => {
    expect(validateSubturtleName("foo/bar")).toBe(false);
    expect(validateSubturtleName("foo\\bar")).toBe(false);
  });

  it("rejects names starting with a dot", () => {
    expect(validateSubturtleName(".hidden")).toBe(false);
  });

  it("rejects excessively long names", () => {
    expect(validateSubturtleName("a".repeat(129))).toBe(false);
  });
});
