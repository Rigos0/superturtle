const assert = require("assert");

const { fetchWhoAmI, startLogin } = require("../bin/cloud.js");

const originalFetch = global.fetch;

function createHeaders(values) {
  const normalized = new Map(
    Object.entries(values).map(([key, value]) => [String(key).toLowerCase(), value])
  );
  return {
    get(name) {
      return normalized.has(String(name).toLowerCase()) ? normalized.get(String(name).toLowerCase()) : null;
    },
  };
}

function createResponse({ status, headers, ok = status >= 200 && status < 300, cancel }) {
  return {
    status,
    ok,
    statusText: "",
    headers: createHeaders(headers),
    body: {
      async cancel() {
        cancel.count += 1;
      },
    },
    async text() {
      throw new Error("response.text() should not be called for this test case");
    },
  };
}

(async () => {
  try {
    const env = {
      SUPERTURTLE_CLOUD_URL: "https://api.superturtle.dev",
      SUPERTURTLE_CLOUD_RESPONSE_MAX_BYTES: "32",
    };

    const redirectCancel = { count: 0 };
    global.fetch = async () =>
      createResponse({
        status: 302,
        headers: {
          location: "https://api.superturtle.dev/redirected",
          "content-type": "application/json",
        },
        cancel: redirectCancel,
      });
    await assert.rejects(() => startLogin({}, env), /redirects are not allowed/i);
    assert.strictEqual(
      redirectCancel.count,
      1,
      "expected redirected control-plane responses to cancel the unread response body before failing closed"
    );

    const invalidTypeCancel = { count: 0 };
    global.fetch = async () =>
      createResponse({
        status: 200,
        headers: {
          "content-type": "text/html",
        },
        cancel: invalidTypeCancel,
      });
    await assert.rejects(
      () =>
        fetchWhoAmI(
          {
            access_token: "access-abc",
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /unsupported content-type/i
    );
    assert.strictEqual(
      invalidTypeCancel.count,
      1,
      "expected non-JSON control-plane responses to cancel the unread response body before failing closed"
    );

    const oversizedCancel = { count: 0 };
    global.fetch = async () =>
      createResponse({
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "64",
        },
        cancel: oversizedCancel,
      });
    await assert.rejects(
      () =>
        fetchWhoAmI(
          {
            access_token: "access-abc",
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /exceeded configured size limit of 32 bytes/i
    );
    assert.strictEqual(
      oversizedCancel.count,
      1,
      "expected oversized control-plane responses to cancel the unread response body before failing closed"
    );

    const invalidLengthCancel = { count: 0 };
    global.fetch = async () =>
      createResponse({
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": "64, 32",
        },
        cancel: invalidLengthCancel,
      });
    await assert.rejects(
      () =>
        fetchWhoAmI(
          {
            access_token: "access-abc",
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /invalid content-length/i
    );
    assert.strictEqual(
      invalidLengthCancel.count,
      1,
      "expected malformed content-length headers to cancel the unread response body before failing closed"
    );
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
