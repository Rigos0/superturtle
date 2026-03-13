#!/usr/bin/env node

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { resolve } = require("path");
const { spawn } = require("child_process");
const { getControlPlaneBaseUrl, validateLoginStartResponse } = require("../bin/cloud.js");

const CLI_PATH = resolve(__dirname, "..", "bin", "superturtle.js");
const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-cloud-cli-"));
const sessionPath = resolve(tmpDir, "cloud-session.json");

let pollCount = 0;
let refreshCount = 0;
let loginStartMode = "normal";
let loginPollMode = "normal";
let refreshMode = "normal";
let sessionMode = "normal";
let statusMode = "normal";
let resumeMode = "normal";
let checkoutMode = "normal";
let portalMode = "normal";
let loginPollDelayMs = 0;
let sessionDelayMs = 0;
let statusDelayMs = 0;

assert.deepStrictEqual(
  validateLoginStartResponse(
    {
      device_code: "dev-code-loopback",
      verification_uri: "http://127.0.0.1:4318/verify",
      verification_uri_complete: "http://127.0.0.1:4318/verify?code=USER-123",
      interval_ms: 10,
    },
    "Hosted login start",
    "http://127.0.0.1:4318"
  ),
  {
    device_code: "dev-code-loopback",
    verification_uri: "http://127.0.0.1:4318/verify",
    verification_uri_complete: "http://127.0.0.1:4318/verify?code=USER-123",
    interval_ms: 10,
    user_code: null,
  },
  "expected loopback HTTP verification URLs to remain valid for local hosted login test harnesses"
);

assert.strictEqual(
  getControlPlaneBaseUrl({
    SUPERTURTLE_CLOUD_URL: "http://[::1]:4318",
  }),
  "http://[::1]:4318",
  "expected IPv6 loopback HTTP control plane URLs to remain valid for local hosted login test harnesses"
);

assert.strictEqual(
  getControlPlaneBaseUrl({}),
  "https://superturtle-web.vercel.app",
  "expected hosted CLI commands to default to the live Vercel control plane"
);

assert.deepStrictEqual(
  validateLoginStartResponse(
    {
      device_code: "dev-code-loopback-ipv6",
      verification_uri: "http://[::1]:4318/verify",
      verification_uri_complete: "http://[::1]:4318/verify?code=USER-123",
      interval_ms: 10,
    },
    "Hosted login start",
    "http://[::1]:4318"
  ),
  {
    device_code: "dev-code-loopback-ipv6",
    verification_uri: "http://[::1]:4318/verify",
    verification_uri_complete: "http://[::1]:4318/verify?code=USER-123",
    interval_ms: 10,
    user_code: null,
  },
  "expected IPv6 loopback HTTP verification URLs to remain valid for local hosted login test harnesses"
);

assert.throws(
  () =>
    validateLoginStartResponse(
      {
        device_code: "dev-code-fragment",
        verification_uri: "https://api.superturtle.dev/verify#fragment",
        interval_ms: 10,
      },
      "Hosted login start",
      "https://api.superturtle.dev"
    ),
  /Hosted login start returned an invalid verification_uri/i,
  "expected hosted login verification links with URL fragments to fail closed"
);

assert.throws(
  () =>
    validateLoginStartResponse(
      {
        device_code: "dev-code-fragment-complete",
        verification_uri_complete: "https://api.superturtle.dev/verify?code=USER-123#fragment",
        interval_ms: 10,
      },
      "Hosted login start",
      "https://api.superturtle.dev"
    ),
  /Hosted login start returned an invalid verification_uri_complete/i,
  "expected hosted login verification_uri_complete links with URL fragments to fail closed"
);

assert.throws(
  () =>
    validateLoginStartResponse(
      {
        device_code: "dev-code-user-code-control",
        user_code: "USER-\u001b[31m123",
        verification_uri: "https://api.superturtle.dev/verify",
        interval_ms: 10,
      },
      "Hosted login start",
      "https://api.superturtle.dev"
    ),
  /Hosted login start returned an invalid user_code/i,
  "expected hosted login user codes with terminal control bytes to fail closed"
);

assert.throws(
  () =>
    validateLoginStartResponse(
      {
        device_code: "dev-code-user-code-trim",
        user_code: " USER-123 ",
        verification_uri: "https://api.superturtle.dev/verify",
        interval_ms: 10,
      },
      "Hosted login start",
      "https://api.superturtle.dev"
    ),
  /Hosted login start returned an invalid user_code/i,
  "expected hosted login user codes with leading or trailing whitespace to fail closed"
);

function runCli(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", rejectRun);
    child.on("close", (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : null;
    if (req.method === "POST" && req.url === "/v1/cli/login/start") {
      const requestOrigin = `http://${req.headers.host}`;
      if (loginStartMode === "redirect") {
        res.writeHead(302, {
          location: `${requestOrigin}/redirected/login/start`,
        });
        res.end();
        return;
      }
      if (loginStartMode === "missing-device-code") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          user_code: "USER-123",
          verification_uri: `${requestOrigin}/verify`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "missing-verification-uri") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "invalid-interval") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          verification_uri: `${requestOrigin}/verify`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
          interval_ms: 0,
        }));
        return;
      }
      if (loginStartMode === "invalid-verification-uri") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          verification_uri: "javascript:alert('owned')",
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "fragment-verification-uri") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          verification_uri: `${requestOrigin}/verify#fragment`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "fragment-verification-uri-complete") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          verification_uri: `${requestOrigin}/verify`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123#fragment`,
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "invalid-verification-origin") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          verification_uri: "https://example.com/verify",
          verification_uri_complete: "https://example.com/verify?code=USER-123",
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "invalid-user-code-control") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-\u001b[31m123",
          verification_uri: `${requestOrigin}/verify`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "invalid-user-code-trim") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: " USER-123 ",
          verification_uri: `${requestOrigin}/verify`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
          interval_ms: 10,
        }));
        return;
      }
      if (loginStartMode === "oversized-response") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          verification_uri: `${requestOrigin}/verify`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
          interval_ms: 10,
          padding: "x".repeat(4096),
        }));
        return;
      }
      if (loginStartMode === "invalid-content-type") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(JSON.stringify({
          device_code: "dev-code-123",
          user_code: "USER-123",
          verification_uri: `${requestOrigin}/verify`,
          verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
          interval_ms: 10,
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        device_code: "dev-code-123",
        user_code: "USER-123",
        verification_uri: `${requestOrigin}/verify`,
        verification_uri_complete: `${requestOrigin}/verify?code=USER-123`,
        interval_ms: 10,
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/cli/login/poll") {
      assert.strictEqual(body.device_code, "dev-code-123");
      pollCount += 1;
      if (loginPollDelayMs > 0) {
        await delay(loginPollDelayMs);
      }
      if (pollCount === 1) {
        res.writeHead(428, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "authorization pending" }));
        return;
      }
      if (loginPollMode === "slow-down" && pollCount === 2) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "slow_down", interval_ms: 25 }));
        return;
      }
      if (loginPollMode === "redirect" && pollCount === 2) {
        res.writeHead(302, {
          location: `http://${req.headers.host}/redirected/login/poll`,
        });
        res.end();
        return;
      }
      if (loginPollMode === "missing-access-token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          refresh_token: "refresh-def",
          expires_at: "2000-03-12T10:00:00Z",
        }));
        return;
      }
      if (loginPollMode === "invalid-content-type") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(JSON.stringify({
          access_token: "expired-access",
          refresh_token: "refresh-def",
          expires_at: "2000-03-12T10:00:00Z",
        }));
        return;
      }
      if (loginPollMode === "invalid-user-email") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: "expired-access",
          refresh_token: "refresh-def",
          expires_at: "2000-03-12T10:00:00Z",
          user: { id: "user_123", email: 42 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        user: { id: "user_123", email: "user@example.com" },
        workspace: { slug: "acme" },
        entitlement: { plan: "managed", state: "active" },
        instance: { id: "inst_123" },
        provisioning_job: {
          state: "queued",
          updated_at: "2026-03-12T09:58:00Z",
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/cli/session/refresh") {
      assert.strictEqual(body.refresh_token, "refresh-def");
      if (refreshMode === "redirect") {
        res.writeHead(302, {
          location: `http://${req.headers.host}/redirected/session/refresh`,
        });
        res.end();
        return;
      }
      if (refreshMode === "http-401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "refresh token revoked" }));
        return;
      }
      if (refreshMode === "invalid-content-type") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(JSON.stringify({
          access_token: "access-abc",
          refresh_token: "refresh-ghi",
          expires_at: "2999-03-12T10:00:00Z",
        }));
        return;
      }
      if (refreshMode === "http-403-invalid-content-type") {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      if (refreshMode === "http-403-oversized-response") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden", padding: "x".repeat(4096) }));
        return;
      }
      if (refreshMode === "missing-access-token") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          refresh_token: "refresh-ghi",
          expires_at: "2999-03-12T10:00:00Z",
        }));
        return;
      }
      if (refreshMode === "invalid-provisioning-updated-at") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          access_token: "access-abc",
          refresh_token: "refresh-ghi",
          expires_at: "2999-03-12T10:00:00Z",
          provisioning_job: {
            state: "running",
            updated_at: "not-a-timestamp",
          },
        }));
        return;
      }
      refreshCount += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/cli/session") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
      if (sessionMode === "redirect") {
        res.writeHead(302, {
          location: `http://${req.headers.host}/redirected/session`,
        });
        res.end();
        return;
      }
      if (sessionDelayMs > 0) {
        await delay(sessionDelayMs);
      }
      if (sessionMode === "network-fail") {
        req.socket.destroy();
        return;
      }
      if (sessionMode === "http-503") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "service unavailable" }));
        return;
      }
      if (sessionMode === "http-401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (sessionMode === "http-403") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (sessionMode === "invalid-user-email") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          user: { id: "user_123", email: 42 },
          workspace: { slug: "acme" },
          entitlement: { plan: "managed", state: "active" },
        }));
        return;
      }
      if (sessionMode === "invalid-content-type") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(JSON.stringify({
          user: { id: "user_123", email: "user@example.com" },
          workspace: { slug: "acme" },
          entitlement: { plan: "managed", state: "active" },
        }));
        return;
      }
      if (sessionMode === "http-403-invalid-content-type") {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      if (sessionMode === "http-403-oversized-response") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden", padding: "x".repeat(4096) }));
        return;
      }
      if (sessionMode === "oversized-response") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          user: { id: "user_123", email: "user@example.com" },
          workspace: { slug: "acme" },
          entitlement: { plan: "managed", state: "active" },
          padding: "x".repeat(4096),
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        user: { id: "user_123", email: "user@example.com" },
        workspace: { slug: "acme" },
        entitlement: { plan: "managed", state: "active" },
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/cli/cloud/status") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
      if (statusMode === "redirect") {
        res.writeHead(302, {
          location: `http://${req.headers.host}/redirected/cloud/status`,
        });
        res.end();
        return;
      }
      if (statusDelayMs > 0) {
        await delay(statusDelayMs);
      }
      if (statusMode === "network-fail") {
        req.socket.destroy();
        return;
      }
      if (statusMode === "http-503") {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "service unavailable" }));
        return;
      }
      if (statusMode === "http-403") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (statusMode === "invalid-content-type") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end(JSON.stringify({
          instance: {
            id: "inst_123",
            provider: "gcp",
            state: "provisioning",
            region: "us-central1",
            hostname: "managed-123.internal",
          },
          provisioning_job: {
            id: "job_123",
            kind: "provision",
            state: "running",
            attempt: 1,
            updated_at: "2026-03-12T09:59:00Z",
          },
        }));
        return;
      }
      if (statusMode === "http-403-invalid-content-type") {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("forbidden");
        return;
      }
      if (statusMode === "invalid-provisioning-updated-at") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          instance: {
            id: "inst_123",
            provider: "gcp",
            state: "provisioning",
            region: "us-central1",
            hostname: "managed-123.internal",
          },
          provisioning_job: {
            id: "job_123",
            kind: "provision",
            state: "running",
            attempt: 1,
            updated_at: "not-a-timestamp",
          },
        }));
        return;
      }
      if (statusMode === "e2b") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          instance: {
            id: "inst_123",
            provider: "e2b",
            state: "running",
            region: "us-east-1",
            sandbox_id: "sandbox_123",
            template_id: "template_teleport_v1",
          },
          provisioning_job: {
            id: "job_123",
            kind: "resume",
            state: "succeeded",
            attempt: 1,
            updated_at: "2026-03-12T10:05:00Z",
          },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        instance: {
          id: "inst_123",
          provider: "gcp",
          state: "provisioning",
          region: "us-central1",
          hostname: "managed-123.internal",
        },
        provisioning_job: {
          id: "job_123",
          kind: "provision",
          state: "running",
          attempt: 1,
          updated_at: "2026-03-12T09:59:00Z",
        },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/cli/cloud/instance/resume") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
      if (resumeMode === "http-403") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
        return;
      }
      if (resumeMode === "invalid-provisioning-kind") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          instance: {
            id: "inst_123",
            provider: "gcp",
            state: "provisioning",
          },
          provisioning_job: {
            id: "job_resume_123",
            kind: "wake",
            state: "queued",
            attempt: 1,
            updated_at: "2026-03-12T10:01:00Z",
          },
        }));
        return;
      }
      if (resumeMode === "e2b") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          instance: {
            id: "inst_123",
            provider: "e2b",
            state: "provisioning",
            region: "us-east-1",
            sandbox_id: "sandbox_123",
            template_id: "template_teleport_v1",
            resume_requested_at: "2026-03-12T10:06:00Z",
          },
          provisioning_job: {
            id: "job_resume_123",
            kind: "resume",
            state: "queued",
            attempt: 1,
            updated_at: "2026-03-12T10:06:00Z",
          },
          audit_log: [
            {
              id: "audit_123",
              actor_type: "user",
              actor_id: "user_123",
              action: "instance.resume_requested",
              target_type: "managed_instance",
              target_id: "inst_123",
              created_at: "2026-03-12T10:06:00Z",
            },
          ],
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        instance: {
          id: "inst_123",
          provider: "gcp",
          state: "provisioning",
          region: "us-central1",
          hostname: "managed-123.internal",
          resume_requested_at: "2026-03-12T10:01:00Z",
        },
        provisioning_job: {
          id: "job_resume_123",
          kind: "resume",
          state: "queued",
          attempt: 1,
          updated_at: "2026-03-12T10:01:00Z",
        },
        audit_log: [
          {
            id: "audit_123",
            actor_type: "user",
            actor_id: "user_123",
            action: "instance.resume_requested",
            target_type: "managed_instance",
            target_id: "inst_123",
            created_at: "2026-03-12T10:01:00Z",
          },
        ],
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/billing/stripe/checkout-session") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
      assert.strictEqual(body.plan, "managed");
      if (checkoutMode === "invalid-url") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          checkout_session_id: "cs_invalid_123",
          checkout_url: "javascript:alert('owned')",
          customer_id: "cus_checkout_123",
          plan: "managed",
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        checkout_session_id: "cs_checkout_123",
        checkout_url: "https://checkout.stripe.test/session/cs_checkout_123",
        customer_id: "cus_checkout_123",
        subscription_id: "sub_checkout_123",
        plan: "managed",
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/billing/stripe/customer-portal-session") {
      assert.strictEqual(req.headers.authorization, "Bearer access-abc");
      if (portalMode === "invalid-url") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          customer_id: "cus_checkout_123",
          portal_session_id: "bps_invalid_123",
          portal_url: "javascript:alert('owned')",
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        customer_id: "cus_checkout_123",
        portal_session_id: "bps_portal_123",
        portal_url: "https://billing.stripe.test/session/bps_portal_123",
      }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const env = {
    ...process.env,
    SUPERTURTLE_CLOUD_URL: baseUrl,
    SUPERTURTLE_CLOUD_SESSION_PATH: sessionPath,
  };
  const postLoginEnv = {
    ...env,
    SUPERTURTLE_CLOUD_URL: "http://127.0.0.1:1",
  };

  try {
    loginStartMode = "missing-device-code";
    const invalidLoginStartMissingDeviceCode = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartMissingDeviceCode.code, 1);
    assert.match(
      invalidLoginStartMissingDeviceCode.stderr,
      /Hosted login start did not include a valid device_code/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected malformed login start without device_code to avoid writing a session file"
    );

    loginStartMode = "missing-verification-uri";
    const invalidLoginStartMissingVerificationUri = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartMissingVerificationUri.code, 1);
    assert.match(
      invalidLoginStartMissingVerificationUri.stderr,
      /Hosted login start did not include a valid verification_uri or verification_uri_complete/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected malformed login start without verification URL to avoid writing a session file"
    );

    loginStartMode = "invalid-interval";
    const invalidLoginStartInterval = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartInterval.code, 1);
    assert.match(
      invalidLoginStartInterval.stderr,
      /Hosted login start returned an invalid interval_ms/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected malformed login start with invalid interval to avoid writing a session file"
    );

    loginStartMode = "invalid-verification-uri";
    const invalidLoginStartVerificationUri = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartVerificationUri.code, 1);
    assert.match(
      invalidLoginStartVerificationUri.stderr,
      /Hosted login start returned an invalid verification_uri/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected malformed login start with invalid verification URI to avoid writing a session file"
    );

    loginStartMode = "fragment-verification-uri";
    const fragmentLoginStartVerificationUri = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(fragmentLoginStartVerificationUri.code, 1);
    assert.match(
      fragmentLoginStartVerificationUri.stderr,
      /Hosted login start returned an invalid verification_uri/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected login verification_uri fragments to be rejected before writing a session file"
    );

    loginStartMode = "fragment-verification-uri-complete";
    const fragmentLoginStartVerificationUriComplete = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(fragmentLoginStartVerificationUriComplete.code, 1);
    assert.match(
      fragmentLoginStartVerificationUriComplete.stderr,
      /Hosted login start returned an invalid verification_uri_complete/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected login verification_uri_complete fragments to be rejected before writing a session file"
    );

    loginStartMode = "invalid-verification-origin";
    const invalidLoginStartVerificationOrigin = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartVerificationOrigin.code, 1);
    assert.match(
      invalidLoginStartVerificationOrigin.stderr,
      /Hosted login start returned a verification_uri that does not match the configured control plane origin/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected mismatched login verification origin to avoid writing a session file"
    );

    loginStartMode = "invalid-user-code-control";
    const invalidLoginStartUserCodeControl = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartUserCodeControl.code, 1);
    assert.match(
      invalidLoginStartUserCodeControl.stderr,
      /Hosted login start returned an invalid user_code/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected login user_code control bytes to be rejected before writing a session file"
    );

    loginStartMode = "invalid-user-code-trim";
    const invalidLoginStartUserCodeTrim = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartUserCodeTrim.code, 1);
    assert.match(
      invalidLoginStartUserCodeTrim.stderr,
      /Hosted login start returned an invalid user_code/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected login user_code surrounding whitespace to be rejected before writing a session file"
    );

    loginStartMode = "oversized-response";
    const oversizedLoginStart = await runCli(
      ["login", "--no-browser"],
      {
        ...env,
        SUPERTURTLE_CLOUD_RESPONSE_MAX_BYTES: "512",
      }
    );
    assert.strictEqual(oversizedLoginStart.code, 1);
    assert.match(oversizedLoginStart.stderr, /exceeded configured size limit of 512 bytes/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected oversized login-start responses to avoid writing a session file"
    );
    loginStartMode = "invalid-content-type";
    const invalidLoginStartContentType = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginStartContentType.code, 1);
    assert.match(invalidLoginStartContentType.stderr, /unsupported content-type/i);
    assert.match(invalidLoginStartContentType.stderr, /application\/json/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected non-JSON login-start responses to avoid writing a session file"
    );
    loginStartMode = "redirect";
    const redirectedLoginStart = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(redirectedLoginStart.code, 1);
    assert.match(redirectedLoginStart.stderr, /redirected/i);
    assert.match(redirectedLoginStart.stderr, /redirects are not allowed/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected redirected login-start responses to avoid writing a session file"
    );
    loginStartMode = "normal";

    loginStartMode = "normal";
    loginPollMode = "missing-access-token";
    pollCount = 0;
    const invalidLogin = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLogin.code, 1);
    assert.match(invalidLogin.stderr, /Hosted login completion did not include a valid access_token/i);
    assert.ok(!fs.existsSync(sessionPath), "expected malformed login completion to avoid writing a session file");
    loginPollMode = "normal";
    pollCount = 0;

    loginPollMode = "invalid-user-email";
    pollCount = 0;
    const invalidLoginSnapshot = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginSnapshot.code, 1);
    assert.match(invalidLoginSnapshot.stderr, /Hosted login completion returned an invalid user.email/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected malformed login completion snapshot fields to avoid writing a session file"
    );
    loginPollMode = "normal";
    pollCount = 0;

    loginPollMode = "invalid-content-type";
    pollCount = 0;
    const invalidLoginPollContentType = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(invalidLoginPollContentType.code, 1);
    assert.match(invalidLoginPollContentType.stderr, /unsupported content-type/i);
    assert.match(invalidLoginPollContentType.stderr, /application\/json/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected non-JSON login-poll responses to avoid writing a session file"
    );
    loginPollMode = "normal";
    pollCount = 0;

    loginPollMode = "redirect";
    pollCount = 0;
    const redirectedLoginPoll = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(redirectedLoginPoll.code, 1);
    assert.match(redirectedLoginPoll.stderr, /redirected/i);
    assert.match(redirectedLoginPoll.stderr, /redirects are not allowed/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected redirected login-poll responses to avoid writing a session file"
    );
    loginPollMode = "normal";
    pollCount = 0;

    loginPollMode = "slow-down";
    pollCount = 0;
    const slowDownLogin = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(slowDownLogin.code, 0, slowDownLogin.stderr);
    assert.match(slowDownLogin.stdout, /Logged in\./);
    assert.strictEqual(pollCount, 3, "expected login polling to continue after a slow_down response");
    fs.rmSync(sessionPath, { force: true });
    loginPollMode = "normal";
    pollCount = 0;

    const invalidBrowserTimeoutLogin = await runCli(
      ["login", "--browser"],
      {
        ...env,
        SUPERTURTLE_CLOUD_BROWSER_TIMEOUT_MS: "0",
      }
    );
    assert.strictEqual(invalidBrowserTimeoutLogin.code, 1);
    assert.match(
      invalidBrowserTimeoutLogin.stderr,
      /Configured hosted browser launch timeout must be a positive number of milliseconds/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected invalid browser launch timeout configuration to avoid writing a session file"
    );

    pollCount = 0;
    const oversizedLocalSessionLogin = await runCli(
      ["login", "--no-browser"],
      {
        ...env,
        SUPERTURTLE_CLOUD_SESSION_MAX_BYTES: "256",
      }
    );
    assert.strictEqual(oversizedLocalSessionLogin.code, 1);
    assert.match(
      oversizedLocalSessionLogin.stderr,
      /Hosted session file .* exceeds the configured size limit of 256 bytes/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected oversized local hosted session writes to fail without leaving a session file behind"
    );
    pollCount = 0;

    loginPollDelayMs = 50;
    pollCount = 0;
    const timedOutLogin = await runCli(
      ["login", "--no-browser"],
      {
        ...env,
        SUPERTURTLE_CLOUD_TIMEOUT_MS: "10",
      }
    );
    assert.strictEqual(timedOutLogin.code, 1);
    assert.match(timedOutLogin.stderr, /timed out after 10ms/i);
    assert.ok(!fs.existsSync(sessionPath), "expected timed out login polling to avoid writing a session file");
    loginPollDelayMs = 0;
    pollCount = 0;

    const invalidConfiguredControlPlaneLogin = await runCli(
      ["login", "--no-browser"],
      {
        ...env,
        SUPERTURTLE_CLOUD_URL: `${baseUrl}/tenant-a`,
      }
    );
    assert.strictEqual(invalidConfiguredControlPlaneLogin.code, 1);
    assert.match(
      invalidConfiguredControlPlaneLogin.stderr,
      /Configured hosted control plane returned an invalid control_plane/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected invalid configured control plane URL to avoid writing a session file"
    );

    const insecureConfiguredControlPlaneLogin = await runCli(
      ["login", "--no-browser"],
      {
        ...env,
        SUPERTURTLE_CLOUD_URL: "http://example.com",
      }
    );
    assert.strictEqual(insecureConfiguredControlPlaneLogin.code, 1);
    assert.match(
      insecureConfiguredControlPlaneLogin.stderr,
      /Configured hosted control plane returned an invalid control_plane/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected non-loopback HTTP control plane URLs to be rejected before login"
    );

    const legacyPredictableTempPath = `${sessionPath}.${process.pid}.tmp`;
    const legacyPredictableTempTargetPath = resolve(tmpDir, "legacy-predictable-temp-target.json");
    fs.writeFileSync(
      legacyPredictableTempTargetPath,
      `${JSON.stringify({ preserved: true }, null, 2)}\n`
    );
    fs.symlinkSync(legacyPredictableTempTargetPath, legacyPredictableTempPath);

    const login = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(login.code, 0, login.stderr);
    assert.match(login.stdout, /Logged in\./);
    assert.ok(fs.existsSync(sessionPath), "expected cloud session file to exist");
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(legacyPredictableTempTargetPath, "utf-8")),
      { preserved: true },
      "expected login writes to avoid the legacy predictable temp-path symlink target"
    );
    assert.ok(
      fs.lstatSync(legacyPredictableTempPath).isSymbolicLink(),
      "expected the legacy predictable temp-path symlink to remain untouched"
    );
    fs.rmSync(legacyPredictableTempPath, { force: true });

    const savedSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(savedSession.schema_version, 1);
    assert.strictEqual(savedSession.control_plane, baseUrl);
    assert.strictEqual(savedSession.access_token, "expired-access");
    assert.deepStrictEqual(savedSession.entitlement, { plan: "managed", state: "active" });
    assert.deepStrictEqual(savedSession.provisioning_job, {
      state: "queued",
      updated_at: "2026-03-12T09:58:00Z",
    });
    assert.ok(savedSession.identity_sync_at, "expected login to persist an initial identity sync timestamp");
    assert.ok(savedSession.cloud_status_sync_at, "expected login to persist an initial cloud status sync timestamp");
    assert.ok(savedSession.last_sync_at, "expected login to persist an initial sync timestamp");
    const mode = fs.statSync(sessionPath).mode & 0o777;
    assert.strictEqual(mode, 0o600);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ ...savedSession, control_plane: "http://127.0.0.1:1" }, null, 2)}\n`
    );

    const cachedWhoamiFromLogin = await runCli(["whoami"], env);
    assert.strictEqual(cachedWhoamiFromLogin.code, 0, cachedWhoamiFromLogin.stderr);
    assert.match(cachedWhoamiFromLogin.stderr, /using cached identity snapshot/i);
    assert.match(cachedWhoamiFromLogin.stdout, /User: user@example.com/);
    assert.match(cachedWhoamiFromLogin.stdout, /Plan: managed/);

    const cachedStatusFromLogin = await runCli(["cloud", "status"], env);
    assert.strictEqual(cachedStatusFromLogin.code, 0, cachedStatusFromLogin.stderr);
    assert.match(cachedStatusFromLogin.stderr, /using cached cloud status snapshot/i);
    assert.match(cachedStatusFromLogin.stdout, /Instance: inst_123/);
    assert.match(cachedStatusFromLogin.stdout, /Provisioning: queued/);

    fs.writeFileSync(sessionPath, `${JSON.stringify(savedSession, null, 2)}\n`);
    fs.chmodSync(sessionPath, 0o644);

    const whoami = await runCli(["whoami"], postLoginEnv);
    assert.strictEqual(whoami.code, 0, whoami.stderr);
    assert.match(whoami.stdout, new RegExp(`Control plane: ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(whoami.stdout, /User: user@example.com/);
    assert.match(whoami.stdout, /Plan: managed/);
    assert.strictEqual(refreshCount, 1, "expected whoami to refresh the expired session");
    assert.strictEqual(fs.statSync(sessionPath).mode & 0o777, 0o600);

    const refreshedSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(refreshedSession.access_token, "access-abc");
    assert.strictEqual(refreshedSession.refresh_token, "refresh-ghi");
    assert.deepStrictEqual(refreshedSession.entitlement, { plan: "managed", state: "active" });
    assert.deepStrictEqual(refreshedSession.workspace, { slug: "acme" });
    assert.ok(refreshedSession.identity_sync_at, "expected identity fetch to persist identity_sync_at");

    const status = await runCli(["cloud", "status"], postLoginEnv);
    assert.strictEqual(status.code, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`Control plane: ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(status.stdout, /State: provisioning/);
    assert.match(status.stdout, /Provisioning: running/);

    const statusSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(statusSession.instance, {
      id: "inst_123",
      provider: "gcp",
      state: "provisioning",
      region: "us-central1",
      hostname: "managed-123.internal",
    });
    assert.deepStrictEqual(statusSession.provisioning_job, {
      id: "job_123",
      kind: "provision",
      state: "running",
      attempt: 1,
      updated_at: "2026-03-12T09:59:00Z",
    });
    assert.ok(statusSession.cloud_status_sync_at, "expected cloud status fetch to persist cloud_status_sync_at");

    const resumed = await runCli(["cloud", "resume"], postLoginEnv);
    assert.strictEqual(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /Instance: inst_123/);
    assert.match(resumed.stdout, /State: provisioning/);
    assert.match(resumed.stdout, /Provisioning: queued/);

    statusMode = "e2b";
    const e2bStatus = await runCli(["cloud", "status"], postLoginEnv);
    assert.strictEqual(e2bStatus.code, 0, e2bStatus.stderr);
    assert.match(e2bStatus.stdout, /Provider: e2b/);
    assert.match(e2bStatus.stdout, /Sandbox: sandbox_123/);
    assert.match(e2bStatus.stdout, /Template: template_teleport_v1/);
    assert.match(e2bStatus.stdout, /State: running/);
    assert.match(e2bStatus.stdout, /Provisioning: succeeded/);
    statusMode = "normal";

    resumeMode = "e2b";
    const e2bResumed = await runCli(["cloud", "resume"], postLoginEnv);
    assert.strictEqual(e2bResumed.code, 0, e2bResumed.stderr);
    assert.match(e2bResumed.stdout, /Provider: e2b/);
    assert.match(e2bResumed.stdout, /Sandbox: sandbox_123/);
    assert.match(e2bResumed.stdout, /Template: template_teleport_v1/);
    assert.match(e2bResumed.stdout, /Resume requested: 2026-03-12T10:06:00Z/);
    assert.match(e2bResumed.stdout, /Provisioning: queued/);
    resumeMode = "normal";

    const checkout = await runCli(["cloud", "checkout"], postLoginEnv);
    assert.strictEqual(checkout.code, 0, checkout.stderr);
    assert.match(checkout.stdout, /Plan: managed/);
    assert.match(checkout.stdout, /Customer: cus_checkout_123/);
    assert.match(checkout.stdout, /Subscription: sub_checkout_123/);
    assert.match(checkout.stdout, /Checkout URL: https:\/\/checkout\.stripe\.test\/session\/cs_checkout_123/);

    const portal = await runCli(["cloud", "portal"], postLoginEnv);
    assert.strictEqual(portal.code, 0, portal.stderr);
    assert.match(portal.stdout, /Customer: cus_checkout_123/);
    assert.match(portal.stdout, /Portal session: bps_portal_123/);
    assert.match(portal.stdout, /Portal URL: https:\/\/billing\.stripe\.test\/session\/bps_portal_123/);

    const resumedSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(resumedSession.instance, {
      id: "inst_123",
      provider: "gcp",
      state: "provisioning",
      region: "us-central1",
      hostname: "managed-123.internal",
      resume_requested_at: "2026-03-12T10:01:00Z",
    });
    assert.deepStrictEqual(resumedSession.provisioning_job, {
      id: "job_resume_123",
      kind: "resume",
      state: "queued",
      attempt: 1,
      updated_at: "2026-03-12T10:01:00Z",
    });

    checkoutMode = "invalid-url";
    const invalidCheckout = await runCli(["cloud", "checkout"], postLoginEnv);
    assert.strictEqual(invalidCheckout.code, 1);
    assert.match(invalidCheckout.stderr, /Hosted billing checkout session returned an invalid checkout_url/i);
    checkoutMode = "normal";

    portalMode = "invalid-url";
    const invalidPortal = await runCli(["cloud", "portal"], postLoginEnv);
    assert.strictEqual(invalidPortal.code, 1);
    assert.match(invalidPortal.stderr, /Hosted billing customer portal session returned an invalid portal_url/i);
    portalMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...statusSession,
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    refreshMode = "redirect";
    const redirectedRefreshWhoami = await runCli(["whoami"], env);
    assert.strictEqual(redirectedRefreshWhoami.code, 1);
    assert.match(redirectedRefreshWhoami.stderr, /redirected/i);
    assert.match(redirectedRefreshWhoami.stderr, /redirects are not allowed/i);
    refreshMode = "normal";

    sessionMode = "redirect";
    const redirectedWhoami = await runCli(["whoami"], env);
    assert.strictEqual(redirectedWhoami.code, 1);
    assert.match(redirectedWhoami.stderr, /redirected/i);
    assert.match(redirectedWhoami.stderr, /redirects are not allowed/i);
    sessionMode = "normal";

    statusMode = "redirect";
    const redirectedStatus = await runCli(["cloud", "status"], env);
    assert.strictEqual(redirectedStatus.code, 1);
    assert.match(redirectedStatus.stderr, /redirected/i);
    assert.match(redirectedStatus.stderr, /redirects are not allowed/i);
    statusMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({ ...statusSession, control_plane: "http://127.0.0.1:1" }, null, 2)}\n`
    );

    const cachedWhoami = await runCli(["whoami"], env);
    assert.strictEqual(cachedWhoami.code, 0, cachedWhoami.stderr);
    assert.match(cachedWhoami.stderr, /using cached identity snapshot/i);
    assert.match(cachedWhoami.stdout, /User: user@example.com/);
    assert.match(cachedWhoami.stdout, /Plan: managed/);

    sessionMode = "http-503";
    const cachedWhoamiFromHttp503 = await runCli(["whoami"], env);
    assert.strictEqual(cachedWhoamiFromHttp503.code, 0, cachedWhoamiFromHttp503.stderr);
    assert.match(cachedWhoamiFromHttp503.stderr, /using cached identity snapshot/i);
    assert.match(cachedWhoamiFromHttp503.stdout, /User: user@example.com/);
    assert.match(cachedWhoamiFromHttp503.stdout, /Plan: managed/);
    sessionMode = "normal";

    sessionDelayMs = 50;
    const cachedWhoamiFromTimeout = await runCli(
      ["whoami"],
      {
        ...env,
        SUPERTURTLE_CLOUD_TIMEOUT_MS: "10",
      }
    );
    assert.strictEqual(cachedWhoamiFromTimeout.code, 0, cachedWhoamiFromTimeout.stderr);
    assert.match(cachedWhoamiFromTimeout.stderr, /using cached identity snapshot/i);
    assert.match(cachedWhoamiFromTimeout.stdout, /User: user@example.com/);
    sessionDelayMs = 0;

    const cachedStatus = await runCli(["cloud", "status"], env);
    assert.strictEqual(cachedStatus.code, 0, cachedStatus.stderr);
    assert.match(cachedStatus.stderr, /using cached cloud status snapshot/i);
    assert.match(cachedStatus.stdout, /Instance: inst_123/);
    assert.match(cachedStatus.stdout, /Provisioning: running/);

    statusMode = "http-503";
    const cachedStatusFromHttp503 = await runCli(["cloud", "status"], env);
    assert.strictEqual(cachedStatusFromHttp503.code, 0, cachedStatusFromHttp503.stderr);
    assert.match(cachedStatusFromHttp503.stderr, /using cached cloud status snapshot/i);
    assert.match(cachedStatusFromHttp503.stdout, /Instance: inst_123/);
    assert.match(cachedStatusFromHttp503.stdout, /Provisioning: running/);
    statusMode = "normal";

    statusDelayMs = 50;
    const cachedStatusFromTimeout = await runCli(
      ["cloud", "status"],
      {
        ...env,
        SUPERTURTLE_CLOUD_TIMEOUT_MS: "10",
      }
    );
    assert.strictEqual(cachedStatusFromTimeout.code, 0, cachedStatusFromTimeout.stderr);
    assert.match(cachedStatusFromTimeout.stderr, /using cached cloud status snapshot/i);
    assert.match(cachedStatusFromTimeout.stdout, /Instance: inst_123/);
    statusDelayMs = 0;

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...statusSession,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    sessionMode = "http-403-invalid-content-type";
    const rejectedWhoamiFromNonJson403 = await runCli(["whoami"], env);
    assert.strictEqual(rejectedWhoamiFromNonJson403.code, 1);
    assert.match(rejectedWhoamiFromNonJson403.stderr, /Hosted session was rejected by the control plane/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected non-JSON 403 whoami responses to invalidate and remove the local hosted session"
    );
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...statusSession,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    sessionMode = "http-403-oversized-response";
    const rejectedWhoamiFromOversized403 = await runCli(
      ["whoami"],
      {
        ...env,
        SUPERTURTLE_CLOUD_RESPONSE_MAX_BYTES: "512",
      }
    );
    assert.strictEqual(rejectedWhoamiFromOversized403.code, 1);
    assert.match(
      rejectedWhoamiFromOversized403.stderr,
      /Hosted session was rejected by the control plane/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected oversized 403 whoami responses to invalidate and remove the local hosted session"
    );
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...statusSession,
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    refreshMode = "http-403-invalid-content-type";
    const rejectedRefreshFromNonJson403 = await runCli(["whoami"], env);
    assert.strictEqual(rejectedRefreshFromNonJson403.code, 1);
    assert.match(rejectedRefreshFromNonJson403.stderr, /Hosted session was rejected by the control plane/i);
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected non-JSON 403 refresh responses to invalidate and remove the local hosted session"
    );
    refreshMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...statusSession,
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    refreshMode = "http-403-oversized-response";
    const rejectedRefreshFromOversized403 = await runCli(
      ["whoami"],
      {
        ...env,
        SUPERTURTLE_CLOUD_RESPONSE_MAX_BYTES: "512",
      }
    );
    assert.strictEqual(rejectedRefreshFromOversized403.code, 1);
    assert.match(
      rejectedRefreshFromOversized403.stderr,
      /Hosted session was rejected by the control plane/i
    );
    assert.ok(
      !fs.existsSync(sessionPath),
      "expected oversized 403 refresh responses to invalidate and remove the local hosted session"
    );
    refreshMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...statusSession,
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    sessionMode = "network-fail";

    const cachedWhoamiAfterRefresh = await runCli(["whoami"], postLoginEnv);
    assert.strictEqual(cachedWhoamiAfterRefresh.code, 0, cachedWhoamiAfterRefresh.stderr);
    assert.match(cachedWhoamiAfterRefresh.stderr, /using cached identity snapshot/i);
    const refreshedCachedSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(refreshedCachedSession.access_token, "access-abc");
    assert.strictEqual(refreshedCachedSession.refresh_token, "refresh-ghi");
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        user: { id: "user_123", email: "user@example.com" },
      }, null, 2)}\n`
    );
    sessionMode = "network-fail";

    const legacyWhoami = await runCli(["whoami"], env);
    assert.strictEqual(legacyWhoami.code, 0, legacyWhoami.stderr);
    assert.match(legacyWhoami.stderr, /using cached identity snapshot/i);
    const migratedLegacySession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(migratedLegacySession.schema_version, 1);
    assert.strictEqual(migratedLegacySession.control_plane, baseUrl);
    assert.strictEqual(migratedLegacySession.refresh_token, "refresh-ghi");
    assert.ok(migratedLegacySession.created_at, "expected legacy session migration to backfill created_at");
    assert.ok(migratedLegacySession.last_sync_at, "expected legacy session migration to backfill last_sync_at");
    assert.ok(
      migratedLegacySession.identity_sync_at,
      "expected legacy session migration to backfill identity_sync_at when cached identity exists"
    );
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        instance: {
          id: "inst_123",
          state: "running",
        },
        provisioning_job: {
          state: "succeeded",
          updated_at: "2026-03-12T10:10:00Z",
        },
      }, null, 2)}\n`
    );
    statusMode = "network-fail";

    const legacyStatus = await runCli(["cloud", "status"], env);
    assert.strictEqual(legacyStatus.code, 0, legacyStatus.stderr);
    assert.match(legacyStatus.stderr, /using cached cloud status snapshot/i);
    const migratedLegacyStatusSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(migratedLegacyStatusSession.schema_version, 1);
    assert.strictEqual(migratedLegacyStatusSession.control_plane, baseUrl);
    assert.ok(
      migratedLegacyStatusSession.cloud_status_sync_at,
      "expected legacy session migration to backfill cloud_status_sync_at when cached status exists"
    );
    statusMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        user: { id: "user_123", email: "user@example.com" },
        padding: "x".repeat(4096),
      }, null, 2)}\n`
    );
    const oversizedStoredSessionWhoami = await runCli(
      ["whoami"],
      {
        ...env,
        SUPERTURTLE_CLOUD_SESSION_MAX_BYTES: "512",
      }
    );
    assert.strictEqual(oversizedStoredSessionWhoami.code, 1);
    assert.match(
      oversizedStoredSessionWhoami.stderr,
      /Hosted session file .* exceeds the configured size limit of 512 bytes/i
    );
    assert.match(oversizedStoredSessionWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        ...migratedLegacyStatusSession,
        schema_version: 99,
      }, null, 2)}\n`
    );

    const futureWhoami = await runCli(["whoami"], env);
    assert.strictEqual(futureWhoami.code, 1);
    assert.match(futureWhoami.stderr, /uses schema_version 99/i);
    assert.match(futureWhoami.stderr, /Upgrade SuperTurtle|superturtle logout/i);
    const futureSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(
      futureSession.schema_version,
      99,
      "expected unsupported future session files to remain untouched"
    );

    fs.writeFileSync(sessionPath, "{not-json\n");
    const corruptWhoami = await runCli(["whoami"], env);
    assert.strictEqual(corruptWhoami.code, 1);
    assert.match(corruptWhoami.stderr, /Hosted session file .* invalid JSON/i);
    assert.match(corruptWhoami.stderr, /superturtle logout/i);

    const symlinkTargetPath = resolve(tmpDir, "cloud-session-target.json");
    fs.writeFileSync(
      symlinkTargetPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    fs.rmSync(sessionPath, { force: true });
    fs.symlinkSync(symlinkTargetPath, sessionPath);
    const symlinkWhoami = await runCli(["whoami"], env);
    assert.strictEqual(symlinkWhoami.code, 1);
    assert.match(symlinkWhoami.stderr, /Hosted session file .* must be a regular file/i);
    assert.match(symlinkWhoami.stderr, /superturtle logout/i);
    const symlinkLogout = await runCli(["logout"], env);
    assert.strictEqual(symlinkLogout.code, 1);
    assert.match(symlinkLogout.stderr, /Hosted session file .* must be a regular file/i);
    assert.ok(fs.lstatSync(sessionPath).isSymbolicLink(), "expected logout to leave a symlinked session path untouched");
    fs.rmSync(sessionPath, { force: true });

    const danglingSymlinkTargetPath = resolve(tmpDir, "cloud-session-dangling-target.json");
    fs.symlinkSync(danglingSymlinkTargetPath, sessionPath);
    const danglingSymlinkWhoami = await runCli(["whoami"], env);
    assert.strictEqual(danglingSymlinkWhoami.code, 1);
    assert.match(danglingSymlinkWhoami.stderr, /Hosted session file .* must be a regular file/i);
    assert.match(danglingSymlinkWhoami.stderr, /superturtle logout/i);
    const danglingSymlinkLogin = await runCli(["login", "--no-browser"], env);
    assert.strictEqual(danglingSymlinkLogin.code, 1);
    assert.match(danglingSymlinkLogin.stderr, /Hosted session file .* must be a regular file/i);
    assert.match(danglingSymlinkLogin.stderr, /superturtle logout/i);
    assert.ok(fs.lstatSync(sessionPath).isSymbolicLink(), "expected dangling symlink session path to remain untouched");
    fs.rmSync(sessionPath, { force: true });

    const symlinkedConfigTargetDir = resolve(tmpDir, "cloud-config-target");
    const symlinkedConfigDir = resolve(tmpDir, "cloud-config-link");
    fs.mkdirSync(symlinkedConfigTargetDir);
    fs.symlinkSync(symlinkedConfigTargetDir, symlinkedConfigDir);
    const symlinkedDirSessionPath = resolve(symlinkedConfigDir, "cloud-session.json");
    const symlinkedDirEnv = {
      ...env,
      SUPERTURTLE_CLOUD_SESSION_PATH: symlinkedDirSessionPath,
    };

    const symlinkedDirLogin = await runCli(["login", "--no-browser"], symlinkedDirEnv);
    assert.strictEqual(symlinkedDirLogin.code, 1);
    assert.match(symlinkedDirLogin.stderr, /Hosted session directory .* must not be a symlink/i);
    assert.match(symlinkedDirLogin.stderr, /superturtle logout/i);
    assert.ok(
      !fs.existsSync(resolve(symlinkedConfigTargetDir, "cloud-session.json")),
      "expected hosted login to refuse writing through a symlinked session directory"
    );

    fs.writeFileSync(
      resolve(symlinkedConfigTargetDir, "cloud-session.json"),
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    const symlinkedDirWhoami = await runCli(["whoami"], symlinkedDirEnv);
    assert.strictEqual(symlinkedDirWhoami.code, 1);
    assert.match(symlinkedDirWhoami.stderr, /Hosted session directory .* must not be a symlink/i);
    assert.match(symlinkedDirWhoami.stderr, /superturtle logout/i);
    const symlinkedDirLogout = await runCli(["logout"], symlinkedDirEnv);
    assert.strictEqual(symlinkedDirLogout.code, 1);
    assert.match(symlinkedDirLogout.stderr, /Hosted session directory .* must not be a symlink/i);
    assert.ok(
      fs.existsSync(resolve(symlinkedConfigTargetDir, "cloud-session.json")),
      "expected logout to refuse deleting through a symlinked session directory"
    );

    fs.mkdirSync(sessionPath);
    const directoryWhoami = await runCli(["whoami"], env);
    assert.strictEqual(directoryWhoami.code, 1);
    assert.match(directoryWhoami.stderr, /Hosted session file .* must be a regular file/i);
    assert.match(directoryWhoami.stderr, /superturtle logout/i);
    fs.rmSync(sessionPath, { recursive: true, force: true });

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: 42,
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    const invalidStoredAccessTokenWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidStoredAccessTokenWhoami.code, 1);
    assert.match(invalidStoredAccessTokenWhoami.stderr, /Hosted session file .* invalid access_token/i);
    assert.match(invalidStoredAccessTokenWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi\u2603",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    const invalidStoredRefreshTokenWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidStoredRefreshTokenWhoami.code, 1);
    assert.match(invalidStoredRefreshTokenWhoami.stderr, /Hosted session file .* invalid refresh_token/i);
    assert.match(invalidStoredRefreshTokenWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: "javascript:alert('owned')",
      }, null, 2)}\n`
    );
    const invalidStoredControlPlaneWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidStoredControlPlaneWhoami.code, 1);
    assert.match(invalidStoredControlPlaneWhoami.stderr, /Hosted session file .* invalid control_plane/i);
    assert.match(invalidStoredControlPlaneWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: `${baseUrl}/tenant-a`,
      }, null, 2)}\n`
    );
    const invalidStoredControlPlanePathWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidStoredControlPlanePathWhoami.code, 1);
    assert.match(
      invalidStoredControlPlanePathWhoami.stderr,
      /Hosted session file .* invalid control_plane/i
    );
    assert.match(invalidStoredControlPlanePathWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: "http://example.com",
      }, null, 2)}\n`
    );
    const invalidStoredInsecureControlPlaneWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidStoredInsecureControlPlaneWhoami.code, 1);
    assert.match(
      invalidStoredInsecureControlPlaneWhoami.stderr,
      /Hosted session file .* invalid control_plane/i
    );
    assert.match(invalidStoredInsecureControlPlaneWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        identity_sync_at: "not-a-timestamp",
        user: { id: "user_123", email: "user@example.com" },
      }, null, 2)}\n`
    );
    const invalidStoredTimestampWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidStoredTimestampWhoami.code, 1);
    assert.match(invalidStoredTimestampWhoami.stderr, /Hosted session file .* invalid identity_sync_at/i);
    assert.match(invalidStoredTimestampWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        refreshed_at: "not-a-timestamp",
      }, null, 2)}\n`
    );
    const invalidStoredRefreshedAtWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidStoredRefreshedAtWhoami.code, 1);
    assert.match(invalidStoredRefreshedAtWhoami.stderr, /Hosted session file .* invalid refreshed_at/i);
    assert.match(invalidStoredRefreshedAtWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        schema_version: 1,
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        provisioning_job: {
          state: "succeeded",
          updated_at: "not-a-timestamp",
        },
      }, null, 2)}\n`
    );
    const invalidStoredProvisioningWhoami = await runCli(["cloud", "status"], env);
    assert.strictEqual(invalidStoredProvisioningWhoami.code, 1);
    assert.match(
      invalidStoredProvisioningWhoami.stderr,
      /Hosted session file .* invalid provisioning_job.updated_at/i
    );
    assert.match(invalidStoredProvisioningWhoami.stderr, /superturtle logout/i);

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    refreshMode = "http-401";
    const revokedRefreshWhoami = await runCli(["whoami"], env);
    assert.strictEqual(revokedRefreshWhoami.code, 1);
    assert.match(revokedRefreshWhoami.stderr, /Hosted session .* rejected by the control plane/i);
    assert.match(revokedRefreshWhoami.stderr, /Removed local cloud session/i);
    assert.match(revokedRefreshWhoami.stderr, /superturtle login/i);
    assert.ok(!fs.existsSync(sessionPath), "expected revoked refresh token to clear the local session");
    refreshMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    refreshMode = "invalid-content-type";
    const invalidRefreshContentTypeWhoami = await runCli(["whoami"], env);
    assert.strictEqual(invalidRefreshContentTypeWhoami.code, 1);
    assert.match(invalidRefreshContentTypeWhoami.stderr, /unsupported content-type/i);
    assert.match(invalidRefreshContentTypeWhoami.stderr, /application\/json/i);
    const invalidRefreshContentTypeSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(
      invalidRefreshContentTypeSession.access_token,
      "expired-access",
      "expected non-JSON refresh responses to leave the previous local session untouched"
    );
    refreshMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        user: { id: "user_123", email: "user@example.com" },
      }, null, 2)}\n`
    );
    sessionMode = "invalid-content-type";
    const invalidWhoamiContentType = await runCli(["whoami"], env);
    assert.strictEqual(invalidWhoamiContentType.code, 1);
    assert.match(invalidWhoamiContentType.stderr, /unsupported content-type/i);
    assert.match(invalidWhoamiContentType.stderr, /application\/json/i);
    const invalidWhoamiContentTypeSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(invalidWhoamiContentTypeSession.user, {
      id: "user_123",
      email: "user@example.com",
    });
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        instance: {
          id: "inst_123",
          state: "running",
          region: "us-central1",
          hostname: "managed-123.internal",
        },
        provisioning_job: {
          state: "succeeded",
          updated_at: "2026-03-12T10:10:00Z",
        },
      }, null, 2)}\n`
    );
    statusMode = "invalid-content-type";
    const invalidCloudStatusContentType = await runCli(["cloud", "status"], env);
    assert.strictEqual(invalidCloudStatusContentType.code, 1);
    assert.match(invalidCloudStatusContentType.stderr, /unsupported content-type/i);
    assert.match(invalidCloudStatusContentType.stderr, /application\/json/i);
    const invalidCloudStatusContentTypeSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(invalidCloudStatusContentTypeSession.provisioning_job, {
      state: "succeeded",
      updated_at: "2026-03-12T10:10:00Z",
    });
    statusMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    refreshMode = "missing-access-token";
    const malformedRefreshWhoami = await runCli(["whoami"], env);
    assert.strictEqual(malformedRefreshWhoami.code, 1);
    assert.match(malformedRefreshWhoami.stderr, /Hosted session refresh did not include a valid access_token/i);
    const malformedRefreshSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.strictEqual(
      malformedRefreshSession.access_token,
      "expired-access",
      "expected malformed refresh responses to leave the previous local session untouched"
    );
    refreshMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "expired-access",
        refresh_token: "refresh-def",
        expires_at: "2000-03-12T10:00:00Z",
        control_plane: baseUrl,
        provisioning_job: {
          state: "succeeded",
          updated_at: "2026-03-12T10:10:00Z",
        },
      }, null, 2)}\n`
    );
    refreshMode = "invalid-provisioning-updated-at";
    const malformedRefreshSnapshotWhoami = await runCli(["cloud", "status"], env);
    assert.strictEqual(malformedRefreshSnapshotWhoami.code, 1);
    assert.match(
      malformedRefreshSnapshotWhoami.stderr,
      /Hosted session refresh returned an invalid provisioning_job.updated_at/i
    );
    const malformedRefreshSnapshotSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(malformedRefreshSnapshotSession.provisioning_job, {
      state: "succeeded",
      updated_at: "2026-03-12T10:10:00Z",
    });
    assert.strictEqual(
      malformedRefreshSnapshotSession.access_token,
      "expired-access",
      "expected malformed refresh snapshot fields to leave the previous local session untouched"
    );
    refreshMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        user: { id: "user_123", email: "user@example.com" },
        workspace: { slug: "acme" },
        entitlement: { plan: "managed", state: "active" },
      }, null, 2)}\n`
    );
    sessionMode = "invalid-user-email";
    const malformedWhoami = await runCli(["whoami"], env);
    assert.strictEqual(malformedWhoami.code, 1);
    assert.match(malformedWhoami.stderr, /Hosted session lookup returned an invalid user.email/i);
    const malformedWhoamiSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(malformedWhoamiSession.user, {
      id: "user_123",
      email: "user@example.com",
    });
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        user: { id: "user_123", email: "user@example.com" },
      }, null, 2)}\n`
    );
    sessionMode = "oversized-response";
    const oversizedWhoami = await runCli(
      ["whoami"],
      {
        ...env,
        SUPERTURTLE_CLOUD_RESPONSE_MAX_BYTES: "512",
      }
    );
    assert.strictEqual(oversizedWhoami.code, 1);
    assert.match(oversizedWhoami.stderr, /exceeded configured size limit of 512 bytes/i);
    const oversizedWhoamiSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(oversizedWhoamiSession.user, {
      id: "user_123",
      email: "user@example.com",
    });
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        instance: {
          id: "inst_123",
          state: "running",
          region: "us-central1",
          hostname: "managed-123.internal",
        },
        provisioning_job: {
          state: "succeeded",
          updated_at: "2026-03-12T10:10:00Z",
        },
      }, null, 2)}\n`
    );
    statusMode = "invalid-provisioning-updated-at";
    const malformedCloudStatus = await runCli(["cloud", "status"], env);
    assert.strictEqual(malformedCloudStatus.code, 1);
    assert.match(
      malformedCloudStatus.stderr,
      /Hosted cloud status lookup returned an invalid provisioning_job.updated_at/i
    );
    const malformedCloudStatusSession = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
    assert.deepStrictEqual(malformedCloudStatusSession.provisioning_job, {
      state: "succeeded",
      updated_at: "2026-03-12T10:10:00Z",
    });
    statusMode = "normal";

    resumeMode = "invalid-provisioning-kind";
    const malformedResume = await runCli(["cloud", "resume"], env);
    assert.strictEqual(malformedResume.code, 1);
    assert.match(
      malformedResume.stderr,
      /Hosted instance resume returned an invalid provisioning_job.kind/i
    );
    resumeMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: null,
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
      }, null, 2)}\n`
    );
    sessionMode = "http-401";
    const unauthorizedWhoami = await runCli(["whoami"], env);
    assert.strictEqual(unauthorizedWhoami.code, 1);
    assert.match(unauthorizedWhoami.stderr, /Hosted session expired and cannot be refreshed/i);
    assert.match(unauthorizedWhoami.stderr, /Removed local cloud session/i);
    assert.match(unauthorizedWhoami.stderr, /superturtle login/i);
    assert.ok(!fs.existsSync(sessionPath), "expected unauthorized session to clear the local session");
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        user: { id: "user_123", email: "user@example.com" },
        workspace: { slug: "acme" },
        entitlement: { plan: "managed", state: "active" },
      }, null, 2)}\n`
    );
    sessionMode = "http-403";
    const forbiddenWhoami = await runCli(["whoami"], env);
    assert.strictEqual(forbiddenWhoami.code, 1);
    assert.match(forbiddenWhoami.stderr, /Hosted session .* rejected by the control plane/i);
    assert.match(forbiddenWhoami.stderr, /Removed local cloud session/i);
    assert.match(forbiddenWhoami.stderr, /superturtle login/i);
    assert.ok(!fs.existsSync(sessionPath), "expected forbidden whoami session to clear the local session");
    sessionMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        instance: {
          id: "inst_123",
          state: "running",
          region: "us-central1",
          hostname: "managed-123.internal",
        },
        provisioning_job: {
          state: "succeeded",
          updated_at: "2026-03-12T10:10:00Z",
        },
      }, null, 2)}\n`
    );
    statusMode = "http-403";
    const forbiddenCloudStatus = await runCli(["cloud", "status"], env);
    assert.strictEqual(forbiddenCloudStatus.code, 1);
    assert.match(forbiddenCloudStatus.stderr, /Hosted session .* rejected by the control plane/i);
    assert.match(forbiddenCloudStatus.stderr, /Removed local cloud session/i);
    assert.match(forbiddenCloudStatus.stderr, /superturtle login/i);
    assert.ok(!fs.existsSync(sessionPath), "expected forbidden cloud status session to clear the local session");
    statusMode = "normal";

    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify({
        access_token: "access-abc",
        refresh_token: "refresh-ghi",
        expires_at: "2999-03-12T10:00:00Z",
        control_plane: baseUrl,
        instance: {
          id: "inst_123",
          state: "running",
          region: "us-central1",
          hostname: "managed-123.internal",
        },
        provisioning_job: {
          state: "succeeded",
          updated_at: "2026-03-12T10:10:00Z",
        },
      }, null, 2)}\n`
    );
    resumeMode = "http-403";
    const forbiddenResume = await runCli(["cloud", "resume"], env);
    assert.strictEqual(forbiddenResume.code, 1);
    assert.match(forbiddenResume.stderr, /Hosted session .* rejected by the control plane/i);
    assert.match(forbiddenResume.stderr, /Removed local cloud session/i);
    assert.match(forbiddenResume.stderr, /superturtle login/i);
    assert.ok(!fs.existsSync(sessionPath), "expected forbidden cloud resume session to clear the local session");
    resumeMode = "normal";

    const logout = await runCli(["logout"], env);
    assert.strictEqual(logout.code, 0, logout.stderr);
    assert.ok(!fs.existsSync(sessionPath), "expected logout to remove session file");
  } finally {
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
    server.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  }
});
