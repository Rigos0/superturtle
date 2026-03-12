const assert = require("assert");

const {
  fetchCloudStatus,
  fetchWhoAmI,
  pollLogin,
  refreshSession,
  resumeManagedInstance,
  startLogin,
} = require("../bin/cloud.js");

const originalFetch = global.fetch;

const recordedRequests = [];

global.fetch = async function patchedFetch(url, options = {}) {
  recordedRequests.push({
    url: String(url),
    options,
  });

  if (String(url).endsWith("/v1/cli/login/start")) {
    return new Response(JSON.stringify({
      device_code: "device-123",
      verification_uri: "https://api.superturtle.dev/verify",
      verification_uri_complete: "https://api.superturtle.dev/verify?code=USER-123",
      interval_ms: 10,
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (String(url).endsWith("/v1/cli/login/poll")) {
    return new Response(JSON.stringify({
      access_token: "access-abc",
      refresh_token: "refresh-def",
      expires_at: "2999-03-12T10:00:00Z",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (String(url).endsWith("/v1/cli/session/refresh")) {
    return new Response(JSON.stringify({
      access_token: "access-refreshed",
      refresh_token: "refresh-ghi",
      expires_at: "2999-03-12T10:00:00Z",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (String(url).endsWith("/v1/cli/session")) {
    return new Response(JSON.stringify({
      user: { id: "user_123", email: "user@example.com" },
      workspace: { slug: "acme" },
      entitlement: { plan: "managed", state: "active" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (String(url).endsWith("/v1/cli/cloud/status")) {
    return new Response(JSON.stringify({
      instance: { id: "inst_123", provider: "gcp", state: "running" },
      provisioning_job: { id: "job_123", kind: "provision", state: "succeeded", updated_at: "2026-03-12T10:00:00Z" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (String(url).endsWith("/v1/cli/cloud/instance/resume")) {
    return new Response(JSON.stringify({
      instance: { id: "inst_123", provider: "gcp", state: "provisioning", resume_requested_at: "2026-03-12T10:00:00Z" },
      provisioning_job: { id: "job_456", kind: "resume", state: "queued", attempt: 1, updated_at: "2026-03-12T10:00:01Z" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  throw new Error(`Unexpected URL: ${url}`);
};

function assertNoStoreHeaders(request, context) {
  assert.strictEqual(
    request.options?.headers?.["cache-control"],
    "no-store",
    `expected ${context} to send Cache-Control: no-store`
  );
  assert.strictEqual(
    request.options?.headers?.pragma,
    "no-cache",
    `expected ${context} to send Pragma: no-cache`
  );
}

function assertCredentiallessRequest(request, context) {
  assert.strictEqual(
    request.options?.cache,
    "no-store",
    `expected ${context} to force fetch cache bypass`
  );
  assert.strictEqual(
    request.options?.credentials,
    "omit",
    `expected ${context} to omit ambient fetch credentials`
  );
  assert.strictEqual(
    request.options?.referrerPolicy,
    "no-referrer",
    `expected ${context} to suppress referrer propagation`
  );
}

(async () => {
  try {
    const env = {
      SUPERTURTLE_CLOUD_URL: "https://api.superturtle.dev",
    };
    const oversizedToken = "x".repeat(4097);
    const invalidLoginRequestCount = recordedRequests.length;
    const invalidSessionRequestCount = recordedRequests.length;

    await assert.rejects(
      () =>
        pollLogin(
          {
            device_code: "device-123\u0000malicious",
            verification_uri: "https://api.superturtle.dev/verify",
            interval_ms: 10,
          },
          { timeoutMs: 5_000 },
          env
        ),
      /Hosted login flow contains an invalid device_code/i
    );
    await assert.rejects(
      () =>
        pollLogin(
          {
            device_code: oversizedToken,
            verification_uri: "https://api.superturtle.dev/verify",
            interval_ms: 10,
          },
          { timeoutMs: 5_000 },
          env
        ),
      /Hosted login flow contains an invalid device_code/i
    );
    assert.strictEqual(
      recordedRequests.length,
      invalidLoginRequestCount,
      "expected malformed in-memory hosted login device codes to fail closed before issuing poll requests"
    );

    await assert.rejects(
      () =>
        fetchWhoAmI(
          {
            access_token: "access-abc",
            control_plane: "https://api.superturtle.dev/tenant-a",
          },
          env
        ),
      /Hosted session contains an invalid control_plane/i
    );
    await assert.rejects(
      () =>
        refreshSession(
          {
            access_token: "access-abc",
            refresh_token: "refresh-def",
            control_plane: "http://example.com",
          },
          env
        ),
      /Hosted session contains an invalid control_plane/i
    );
    await assert.rejects(
      () =>
        refreshSession(
          {
            access_token: "access-abc",
            refresh_token: "refresh-def\u2603",
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /Hosted session contains an invalid refresh_token/i
    );
    await assert.rejects(
      () =>
        refreshSession(
          {
            access_token: "access-abc",
            refresh_token: oversizedToken,
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /Hosted session contains an invalid refresh_token/i
    );
    await assert.rejects(
      () =>
        fetchCloudStatus(
          {
            access_token: "access-abc\u0000malicious",
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /Hosted session contains an invalid access_token/i
    );
    await assert.rejects(
      () =>
        fetchWhoAmI(
          {
            access_token: oversizedToken,
            control_plane: "https://api.superturtle.dev",
          },
          env
        ),
      /Hosted session contains an invalid access_token/i
    );
    assert.strictEqual(
      recordedRequests.length,
      invalidSessionRequestCount,
      "expected invalid in-memory hosted session auth fields to fail closed before issuing fetch requests"
    );

    const started = await startLogin({}, env);
    await pollLogin(started, { timeoutMs: 5_000 }, env);
    await refreshSession(
      {
        access_token: "access-abc",
        refresh_token: "refresh-def",
        control_plane: "https://api.superturtle.dev",
      },
      env
    );
    await fetchWhoAmI(
      {
        access_token: "access-abc",
        control_plane: "https://api.superturtle.dev",
      },
      env
    );
    await fetchCloudStatus(
      {
        access_token: "access-abc",
        control_plane: "https://api.superturtle.dev",
      },
      env
    );
    await resumeManagedInstance(
      {
        access_token: "access-abc",
        control_plane: "https://api.superturtle.dev",
      },
      env
    );

    const byPath = new Map(recordedRequests.map((request) => [new URL(request.url).pathname, request]));

    assertNoStoreHeaders(byPath.get("/v1/cli/login/start"), "hosted login start");
    assertNoStoreHeaders(byPath.get("/v1/cli/login/poll"), "hosted login poll");
    assertNoStoreHeaders(byPath.get("/v1/cli/session/refresh"), "hosted session refresh");
    assertNoStoreHeaders(byPath.get("/v1/cli/session"), "hosted session lookup");
    assertNoStoreHeaders(byPath.get("/v1/cli/cloud/status"), "hosted cloud status lookup");
    assertNoStoreHeaders(byPath.get("/v1/cli/cloud/instance/resume"), "hosted instance resume");

    assertCredentiallessRequest(byPath.get("/v1/cli/login/start"), "hosted login start");
    assertCredentiallessRequest(byPath.get("/v1/cli/login/poll"), "hosted login poll");
    assertCredentiallessRequest(byPath.get("/v1/cli/session/refresh"), "hosted session refresh");
    assertCredentiallessRequest(byPath.get("/v1/cli/session"), "hosted session lookup");
    assertCredentiallessRequest(byPath.get("/v1/cli/cloud/status"), "hosted cloud status lookup");
    assertCredentiallessRequest(byPath.get("/v1/cli/cloud/instance/resume"), "hosted instance resume");
  } finally {
    global.fetch = originalFetch;
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
