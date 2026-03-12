const assert = require("assert");

const { pollLogin } = require("../bin/cloud.js");

const originalFetch = global.fetch;
const originalSetTimeout = global.setTimeout;

const scheduledSleeps = [];
let pollRequests = 0;

global.setTimeout = function patchedSetTimeout(callback, delay, ...args) {
  scheduledSleeps.push(delay);
  callback(...args);
  return 0;
};

global.fetch = async function patchedFetch(url) {
  pollRequests += 1;
  assert.match(String(url), /\/v1\/cli\/login\/poll$/);

  if (pollRequests === 1) {
    return new Response(JSON.stringify({ error: "authorization pending" }), {
      status: 428,
      headers: { "content-type": "application/json" },
    });
  }

  if (pollRequests === 2) {
    return new Response(JSON.stringify({ error: "slow_down" }), {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": "3",
      },
    });
  }

  return new Response(JSON.stringify({
    access_token: "access-abc",
    refresh_token: "refresh-def",
    expires_at: "2999-03-12T10:00:00Z",
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

(async () => {
  try {
    const result = await pollLogin(
      {
        device_code: "dev-code-123",
        interval_ms: 1000,
      },
      {
        timeoutMs: 30_000,
      },
      {
        SUPERTURTLE_CLOUD_URL: "https://api.superturtle.dev",
      }
    );

    assert.strictEqual(result.access_token, "access-abc");
    assert.strictEqual(pollRequests, 3, "expected polling to continue until completion");
    assert.deepStrictEqual(
      scheduledSleeps,
      [1000, 1000, 3000],
      "expected login polling to honor Retry-After throttling before the next poll"
    );
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
