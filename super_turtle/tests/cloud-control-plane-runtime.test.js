const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const { resolve } = require("path");

const {
  CONTROL_PLANE_WRITE_SCOPE,
  completeLoginRequest,
  createDefaultState,
  createRuntime,
  handleHttpRequest,
  readState,
  requestCloudStatus,
  requestMachineClaudeProviderAuth,
  requestMachineHeartbeat,
  requestMachineRegister,
  requestInstanceReprovision,
  requestTeleportTarget,
  requestLoginPoll,
  requestLoginStart,
  requestSession,
  requestSessionRefresh,
  requestInstanceResume,
  requestStripeCustomerPortalSession,
  requestStripeCheckoutSession,
  requestStripeWebhook,
  runNextProvisioningJob,
  writeState,
} = require("../bin/cloud-control-plane-runtime.js");

function signStripePayload(secret, timestamp, payload) {
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

function createSeedState() {
  const state = createDefaultState();
  state.users.push({
    id: "user_123",
    email: "user@example.com",
    created_at: "2026-03-12T10:00:00Z",
  });
  state.identities.push({
    id: "ident_123",
    user_id: "user_123",
    provider: "github",
    provider_user_id: "github_123",
    email: "user@example.com",
    created_at: "2026-03-12T10:00:00Z",
    last_used_at: null,
  });
  state.sessions.push({
    id: "sess_123",
    user_id: "user_123",
    state: "active",
    access_token: "access_123",
    refresh_token: "refresh_123",
    scopes: [CONTROL_PLANE_WRITE_SCOPE],
    created_at: "2026-03-12T10:00:00Z",
    expires_at: "2026-03-12T11:00:00Z",
  });
  state.entitlements.push({
    user_id: "user_123",
    plan: "managed",
    state: "active",
    subscription_id: "sub_123",
    current_period_end: "2026-04-12T10:00:00Z",
    cancel_at_period_end: false,
  });
  state.provider_credentials.push({
    id: "cred_123",
    user_id: "user_123",
    provider: "claude",
    state: "valid",
    access_token: "claude-valid-token",
    account_email: "claude-user@example.com",
    configured_at: "2026-03-12T10:00:00Z",
    last_validated_at: "2026-03-12T10:00:00Z",
    last_error_code: null,
    last_error_message: null,
  });
  return state;
}

function createClock() {
  const values = [
    "2026-03-12T10:00:00Z",
    "2026-03-12T10:00:01Z",
    "2026-03-12T10:00:02Z",
    "2026-03-12T10:00:03Z",
    "2026-03-12T10:00:04Z",
    "2026-03-12T10:00:05Z",
    "2026-03-12T10:00:06Z",
    "2026-03-12T10:00:07Z",
    "2026-03-12T10:00:08Z",
    "2026-03-12T10:00:09Z",
    "2026-03-12T10:00:10Z",
    "2026-03-12T10:00:11Z",
    "2026-03-12T10:00:12Z",
    "2026-03-12T10:00:13Z",
    "2026-03-12T10:00:14Z",
    "2026-03-12T10:00:15Z",
    "2026-03-12T10:00:16Z",
    "2026-03-12T10:00:17Z",
    "2026-03-12T10:00:18Z",
    "2026-03-12T10:00:19Z",
  ];
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

async function run() {
  const tmpDir = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-control-plane-runtime-"));
  const statePath = resolve(tmpDir, "control-plane-state.json");

  writeState(statePath, createSeedState());

  const runtime = createRuntime({
    statePath,
    now: createClock(),
    publicOrigin: "https://api.superturtle.dev",
    stripe: { webhookSecret: "whsec_test_123" },
    createId(prefix) {
      return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
    },
  });

  const loginStarted = requestLoginStart(runtime, {
    client_name: "superturtle-cli",
    device_name: "devbox",
    scopes: ["cloud:read", "teleport:write"],
  });
  assert.strictEqual(loginStarted.status, 200);
  assert.match(loginStarted.data.device_code, /^device_/);
  assert.strictEqual(loginStarted.data.interval_ms, 2000);
  assert.strictEqual(loginStarted.data.verification_uri, "https://api.superturtle.dev/verify");
  assert.match(
    loginStarted.data.verification_uri_complete,
    /^https:\/\/api\.superturtle\.dev\/verify\?user_code=/
  );

  const loginPending = requestLoginPoll(runtime, loginStarted.data.device_code);
  assert.strictEqual(loginPending.status, 428);
  assert.strictEqual(loginPending.data.error, "authorization_pending");

  const completedLogin = completeLoginRequest(runtime, loginStarted.data.device_code, {
    userId: "user_123",
  });
  assert.strictEqual(completedLogin.status, 200);
  assert.match(completedLogin.data.access_token, /^access_/);
  assert.match(completedLogin.data.refresh_token, /^refresh_/);
  assert.strictEqual(completedLogin.data.user.email, "user@example.com");
  assert.strictEqual(completedLogin.data.entitlement.state, "active");

  const loginPollCompleted = requestLoginPoll(runtime, loginStarted.data.device_code);
  assert.strictEqual(loginPollCompleted.status, 200);
  assert.strictEqual(loginPollCompleted.data.session.id, completedLogin.data.session.id);

  const persistedAfterLogin = readState(statePath);
  assert.strictEqual(persistedAfterLogin.login_requests.length, 1);
  assert.strictEqual(persistedAfterLogin.login_requests[0].state, "completed");
  assert.strictEqual(persistedAfterLogin.login_requests[0].session_id, completedLogin.data.session.id);
  assert.match(
    JSON.stringify(persistedAfterLogin.audit_log),
    /login_request\.completed/,
    "expected completed login requests to be written to the durable audit log"
  );

  const whoami = requestSession(runtime, "access_123");
  assert.strictEqual(whoami.status, 200);
  assert.strictEqual(whoami.data.user.email, "user@example.com");
  assert.strictEqual(whoami.data.identities.length, 1);
  assert.strictEqual(whoami.data.identities[0].provider, "github");
  assert.strictEqual(whoami.data.session.id, "sess_123");
  assert.strictEqual(whoami.data.session.last_authenticated_at, "2026-03-12T10:00:10Z");

  const persistedAfterWhoAmI = readState(statePath);
  assert.strictEqual(persistedAfterWhoAmI.sessions[0].last_authenticated_at, "2026-03-12T10:00:10Z");
  assert.strictEqual(persistedAfterWhoAmI.identities[0].last_used_at, "2026-03-12T10:00:10Z");
  assert.match(
    JSON.stringify(persistedAfterWhoAmI.audit_log),
    /session\.lookup/,
    "expected session lookups to be written to the durable audit log"
  );

  const refreshed = requestSessionRefresh(runtime, "refresh_123");
  assert.strictEqual(refreshed.status, 200);
  assert.match(refreshed.data.access_token, /^access_/);
  assert.match(refreshed.data.refresh_token, /^refresh_/);
  assert.strictEqual(refreshed.data.session.id, "sess_123");
  assert.strictEqual(refreshed.data.session.last_authenticated_at, "2026-03-12T10:00:12Z");
  assert.strictEqual(refreshed.data.entitlement.state, "active");

  const persistedAfterRefresh = readState(statePath);
  assert.strictEqual(persistedAfterRefresh.sessions[0].access_token, refreshed.data.access_token);
  assert.strictEqual(persistedAfterRefresh.sessions[0].refresh_token, refreshed.data.refresh_token);
  assert.strictEqual(persistedAfterRefresh.sessions[0].expires_at, "2026-03-12T11:00:12.000Z");
  assert.strictEqual(persistedAfterRefresh.sessions[0].last_authenticated_at, "2026-03-12T10:00:12Z");
  assert.strictEqual(persistedAfterRefresh.identities[0].last_used_at, "2026-03-12T10:00:12Z");
  assert.match(
    JSON.stringify(persistedAfterRefresh.audit_log),
    /session\.refreshed/,
    "expected session refreshes to be written to the durable audit log"
  );

  const initialStatus = requestCloudStatus(runtime, refreshed.data.access_token);
  assert.strictEqual(initialStatus.status, 200);
  assert.strictEqual(initialStatus.data.instance, null);
  assert.strictEqual(initialStatus.data.provisioning_job, null);
  assert.deepStrictEqual(initialStatus.data.audit_log, []);

  const persistedAfterStatus = readState(statePath);
  assert.strictEqual(persistedAfterStatus.sessions[0].last_authenticated_at, "2026-03-12T10:00:14Z");
  assert.strictEqual(persistedAfterStatus.identities[0].last_used_at, "2026-03-12T10:00:14Z");
  assert.match(
    JSON.stringify(persistedAfterStatus.audit_log),
    /cloud_status\.lookup/,
    "expected cloud status lookups to be written to the durable audit log"
  );

  const created = requestInstanceResume(runtime, refreshed.data.access_token);
  assert.strictEqual(created.status, 200);
  assert.strictEqual(created.data.instance.state, "provisioning");
  assert.strictEqual(created.data.provisioning_job.kind, "provision");
  assert.strictEqual(created.data.provisioning_job.state, "queued");

  const persistedAfterCreate = readState(statePath);
  assert.strictEqual(persistedAfterCreate.managed_instances.length, 1);
  assert.strictEqual(persistedAfterCreate.provisioning_jobs.length, 1);
  assert.strictEqual(persistedAfterCreate.managed_instances[0].state, "provisioning");

  const deduped = requestInstanceResume(runtime, refreshed.data.access_token);
  assert.strictEqual(deduped.status, 200);
  assert.strictEqual(deduped.data.provisioning_job.id, created.data.provisioning_job.id);
  assert.match(
    JSON.stringify(readState(statePath).audit_log),
    /instance\.resume_deduplicated/,
    "expected resume dedupe to be written to the durable audit log"
  );

  const completed = await runNextProvisioningJob(runtime);
  assert.strictEqual(completed.instance.state, "running");
  assert.strictEqual(completed.provisioning_job.state, "succeeded");
  assert.ok(completed.instance.hostname);
  assert.ok(completed.instance.machine_token_id);

  const persistedWithMachineToken = readState(statePath);
  assert.ok(persistedWithMachineToken.managed_instances[0].machine_auth_token);

  const registered = requestMachineRegister(
    runtime,
    persistedWithMachineToken.managed_instances[0].machine_auth_token,
    {
      hostname: "vm-registered.managed.superturtle.internal",
      vm_name: "gcp-vm-registered",
      zone: "us-central1-b",
    }
  );
  assert.strictEqual(registered.status, 200);
  assert.strictEqual(registered.data.instance.state, "running");
  assert.strictEqual(registered.data.instance.hostname, "vm-registered.managed.superturtle.internal");
  assert.strictEqual(registered.data.instance.zone, "us-central1-b");

  const heartbeat = requestMachineHeartbeat(
    runtime,
    persistedWithMachineToken.managed_instances[0].machine_auth_token,
    {
      health_status: "healthy",
      region: "us-central1",
    }
  );
  assert.strictEqual(heartbeat.status, 200);
  assert.strictEqual(heartbeat.data.ok, true);
  assert.strictEqual(heartbeat.data.health_status, "healthy");

  const machineClaude = requestMachineClaudeProviderAuth(
    runtime,
    persistedWithMachineToken.managed_instances[0].machine_auth_token
  );
  assert.strictEqual(machineClaude.status, 200);
  assert.strictEqual(machineClaude.data.provider, "claude");
  assert.strictEqual(machineClaude.data.configured, true);
  assert.strictEqual(machineClaude.data.access_token, "claude-valid-token");
  assert.strictEqual(machineClaude.data.credential.account_email, "claude-user@example.com");

  const persistedAfterRun = readState(statePath);
  assert.strictEqual(persistedAfterRun.managed_instances[0].state, "running");
  assert.strictEqual(persistedAfterRun.provisioning_jobs[0].state, "succeeded");
  assert.strictEqual(
    persistedAfterRun.managed_instances[0].hostname,
    "vm-registered.managed.superturtle.internal"
  );
  assert.strictEqual(persistedAfterRun.managed_instances[0].health_status, "healthy");
  assert.match(
    JSON.stringify(persistedAfterRun.audit_log),
    /machine\.(registered|heartbeat)|provider_credential\.claude_machine_lookup/,
    "expected machine lifecycle and Claude lookup events to be written to the durable audit log"
  );

  const runningStatus = requestCloudStatus(runtime, refreshed.data.access_token);
  assert.strictEqual(runningStatus.status, 200);
  assert.strictEqual(runningStatus.data.instance.id, created.data.instance.id);
  assert.strictEqual(runningStatus.data.instance.state, "running");
  assert.strictEqual(runningStatus.data.provisioning_job.id, created.data.provisioning_job.id);
  assert.strictEqual(runningStatus.data.provisioning_job.state, "succeeded");

  const teleportTarget = requestTeleportTarget(runtime, refreshed.data.access_token);
  assert.strictEqual(teleportTarget.status, 200);
  assert.strictEqual(
    teleportTarget.data.ssh_target,
    "superturtle@vm-registered.managed.superturtle.internal"
  );
  assert.strictEqual(teleportTarget.data.remote_root, "/srv/superturtle");
  assert.strictEqual(teleportTarget.data.instance.id, created.data.instance.id);
  assert.match(
    JSON.stringify(readState(statePath).audit_log),
    /teleport_target\.lookup/,
    "expected teleport target lookups to be written to the durable audit log"
  );

  const reprovisionRequested = requestInstanceReprovision(runtime, refreshed.data.access_token);
  assert.strictEqual(reprovisionRequested.status, 200);
  assert.strictEqual(reprovisionRequested.data.instance.id, created.data.instance.id);
  assert.strictEqual(reprovisionRequested.data.instance.state, "provisioning");
  assert.strictEqual(reprovisionRequested.data.provisioning_job.kind, "reprovision");
  assert.strictEqual(reprovisionRequested.data.provisioning_job.state, "queued");
  assert.strictEqual(reprovisionRequested.data.instance.machine_token_id, null);
  assert.strictEqual(readState(statePath).managed_instances[0].machine_auth_token, null);

  const reprovisionDeduped = requestInstanceReprovision(runtime, refreshed.data.access_token);
  assert.strictEqual(reprovisionDeduped.status, 200);
  assert.strictEqual(
    reprovisionDeduped.data.provisioning_job.id,
    reprovisionRequested.data.provisioning_job.id
  );
  assert.match(
    JSON.stringify(readState(statePath).audit_log),
    /instance\.reprovision_deduplicated/,
    "expected reprovision dedupe to be written to the durable audit log"
  );

  const reprovisionCompleted = await runNextProvisioningJob(runtime);
  assert.strictEqual(reprovisionCompleted.instance.state, "running");
  assert.strictEqual(reprovisionCompleted.provisioning_job.kind, "reprovision");
  assert.strictEqual(reprovisionCompleted.provisioning_job.state, "succeeded");
  assert.ok(reprovisionCompleted.instance.machine_token_id);
  assert.ok(readState(statePath).managed_instances[0].machine_auth_token);

  const reprovisionForbiddenPath = resolve(tmpDir, "reprovision-forbidden-state.json");
  writeState(reprovisionForbiddenPath, createSeedState());
  const reprovisionForbiddenRuntime = createRuntime({
    statePath: reprovisionForbiddenPath,
    now: createClock(),
  });
  const reprovisionForbidden = requestInstanceReprovision(reprovisionForbiddenRuntime, "access_123");
  assert.strictEqual(reprovisionForbidden.status, 409);

  const invalidMachineClaude = requestMachineClaudeProviderAuth(runtime, "machine_auth_invalid");
  assert.strictEqual(invalidMachineClaude.status, 401);

  const forbiddenPath = resolve(tmpDir, "forbidden-state.json");
  const forbiddenState = createSeedState();
  forbiddenState.entitlements[0].state = "inactive";
  writeState(forbiddenPath, forbiddenState);
  const forbiddenRuntime = createRuntime({ statePath: forbiddenPath, now: createClock() });
  const forbidden = requestInstanceResume(forbiddenRuntime, "access_123");
  assert.strictEqual(forbidden.status, 403);
  assert.deepStrictEqual(forbidden.data, {
    error: "forbidden",
    reason: "no_active_subscription",
    entitlement: {
      plan: "managed",
      status: "inactive",
      period_end: "2026-04-12T10:00:00Z",
    },
  });
  assert.deepStrictEqual(readState(forbiddenPath).managed_instances, []);
  const forbiddenStatus = requestCloudStatus(forbiddenRuntime, "access_123");
  assert.strictEqual(forbiddenStatus.status, 403);
  assert.deepStrictEqual(forbiddenStatus.data, forbidden.data);

  const checkoutPath = resolve(tmpDir, "checkout-state.json");
  const checkoutState = createSeedState();
  checkoutState.entitlements[0].state = "inactive";
  writeState(checkoutPath, checkoutState);
  const checkoutRuntime = createRuntime({
    statePath: checkoutPath,
    now: createClock(),
    stripe: {
      billingAdapter: {
        async createCheckoutSession({ userId, plan, customerId }) {
          assert.strictEqual(userId, "user_123");
          assert.strictEqual(plan, "managed");
          assert.strictEqual(customerId, null);
          return {
            id: "cs_created_123",
            url: "https://checkout.stripe.test/session/cs_created_123",
            customerId: "cus_checkout_123",
            subscriptionId: null,
          };
        },
      },
    },
  });
  const checkoutCreated = await requestStripeCheckoutSession(checkoutRuntime, "access_123", {
    plan: "managed",
  });
  assert.strictEqual(checkoutCreated.status, 200);
  assert.strictEqual(checkoutCreated.data.checkout_session_id, "cs_created_123");
  assert.strictEqual(checkoutCreated.data.customer_id, "cus_checkout_123");
  assert.match(checkoutCreated.data.checkout_url, /^https:\/\/checkout\.stripe\.test\//);
  const checkoutPersisted = readState(checkoutPath);
  assert.strictEqual(checkoutPersisted.subscriptions.length, 1);
  assert.strictEqual(checkoutPersisted.subscriptions[0].checkout_session_id, "cs_created_123");
  assert.strictEqual(checkoutPersisted.subscriptions[0].provider_customer_id, "cus_checkout_123");
  assert.strictEqual(checkoutPersisted.subscriptions[0].state, "inactive");
  assert.match(
    JSON.stringify(checkoutPersisted.audit_log),
    /billing\.checkout_session_created/,
    "expected checkout-session creation to be written to the durable audit log"
  );

  const checkoutActiveDenied = await requestStripeCheckoutSession(
    createRuntime({
      statePath,
      now: createClock(),
      stripe: {
        billingAdapter: {
          async createCheckoutSession() {
            throw new Error("should not be called for already-active entitlements");
          },
        },
      },
    }),
    refreshed.data.access_token,
    {
      plan: "managed",
    }
  );
  assert.strictEqual(checkoutActiveDenied.status, 409);

  const portalPath = resolve(tmpDir, "portal-state.json");
  const portalState = createSeedState();
  portalState.subscriptions.push({
    id: "subrec_portal_123",
    provider: "stripe",
    user_id: "user_123",
    provider_customer_id: "cus_portal_123",
    provider_subscription_id: "sub_portal_123",
    checkout_session_id: "cs_portal_123",
    plan: "managed",
    state: "active",
    current_period_end: "2026-04-12T10:00:00Z",
    cancel_at_period_end: false,
    latest_event_id: "evt_portal_seed",
    latest_event_type: "customer.subscription.created",
    created_at: "2026-03-12T10:00:00Z",
    updated_at: "2026-03-12T10:00:00Z",
  });
  writeState(portalPath, portalState);
  const portalRuntime = createRuntime({
    statePath: portalPath,
    now: createClock(),
    stripe: {
      billingAdapter: {
        async createCustomerPortalSession({ customerId, userId }) {
          assert.strictEqual(customerId, "cus_portal_123");
          assert.strictEqual(userId, "user_123");
          return {
            id: "bps_created_123",
            url: "https://billing.stripe.test/session/bps_created_123",
          };
        },
      },
    },
  });
  const portalCreated = await requestStripeCustomerPortalSession(portalRuntime, "access_123");
  assert.strictEqual(portalCreated.status, 200);
  assert.strictEqual(portalCreated.data.customer_id, "cus_portal_123");
  assert.strictEqual(portalCreated.data.portal_session_id, "bps_created_123");
  assert.match(portalCreated.data.portal_url, /^https:\/\/billing\.stripe\.test\//);
  assert.match(
    JSON.stringify(readState(portalPath).audit_log),
    /billing\.customer_portal_session_created/,
    "expected customer-portal session creation to be written to the durable audit log"
  );

  const portalMissingCustomer = await requestStripeCustomerPortalSession(portalRuntime, "access_123_missing");
  assert.strictEqual(portalMissingCustomer.status, 401);

  const portalCustomerMissingPath = resolve(tmpDir, "portal-missing-customer-state.json");
  writeState(portalCustomerMissingPath, createSeedState());
  const portalCustomerMissingRuntime = createRuntime({
    statePath: portalCustomerMissingPath,
    now: createClock(),
    stripe: {
      billingAdapter: {
        async createCustomerPortalSession() {
          throw new Error("should not be called without a persisted customer");
        },
      },
    },
  });
  const portalCustomerMissing = await requestStripeCustomerPortalSession(
    portalCustomerMissingRuntime,
    "access_123"
  );
  assert.strictEqual(portalCustomerMissing.status, 409);

  const checkoutEventPayload = JSON.stringify({
    id: "evt_checkout_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_123",
        customer: "cus_123",
        subscription: "sub_123",
        metadata: {
          user_id: "user_123",
          plan: "managed",
        },
      },
    },
  });
  const checkoutSignature = signStripePayload("whsec_test_123", 1773309615, checkoutEventPayload);
  const checkoutWebhook = requestStripeWebhook(runtime, checkoutSignature, checkoutEventPayload);
  assert.strictEqual(checkoutWebhook.status, 200);
  assert.strictEqual(checkoutWebhook.data.ok, true);

  const subscriptionEventPayload = JSON.stringify({
    id: "evt_subscription_123",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "past_due",
        cancel_at_period_end: true,
        current_period_end: 1775902219,
        items: {
          data: [
            {
              price: {
                lookup_key: "managed",
              },
            },
          ],
        },
      },
    },
  });
  const subscriptionSignature = signStripePayload("whsec_test_123", 1773309615, subscriptionEventPayload);
  const subscriptionWebhook = requestStripeWebhook(runtime, subscriptionSignature, subscriptionEventPayload);
  assert.strictEqual(subscriptionWebhook.status, 200);
  assert.strictEqual(subscriptionWebhook.data.entitlement_state, "past_due");

  const billingPersisted = readState(statePath);
  assert.strictEqual(billingPersisted.subscriptions.length, 1);
  assert.strictEqual(billingPersisted.subscriptions[0].provider_customer_id, "cus_123");
  assert.strictEqual(billingPersisted.subscriptions[0].provider_subscription_id, "sub_123");
  assert.strictEqual(billingPersisted.subscriptions[0].state, "past_due");
  assert.strictEqual(billingPersisted.entitlements[0].state, "past_due");
  assert.strictEqual(billingPersisted.entitlements[0].cancel_at_period_end, true);
  assert.strictEqual(billingPersisted.billing_events.length, 2);
  assert.match(
    JSON.stringify(billingPersisted.audit_log),
    /billing\.webhook_processed/,
    "expected Stripe webhook processing to be written to the durable audit log"
  );

  const deniedAfterBilling = requestInstanceResume(runtime, refreshed.data.access_token);
  assert.strictEqual(deniedAfterBilling.status, 403);

  const duplicateWebhook = requestStripeWebhook(runtime, subscriptionSignature, subscriptionEventPayload);
  assert.strictEqual(duplicateWebhook.status, 200);
  assert.strictEqual(duplicateWebhook.data.state, "already_processed");

  const badSignatureWebhook = requestStripeWebhook(runtime, "t=1773309615,v1=bad", subscriptionEventPayload);
  assert.strictEqual(badSignatureWebhook.status, 401);

  const httpPath = resolve(tmpDir, "http-state.json");
  writeState(httpPath, createSeedState());
  const httpRuntime = createRuntime({
    statePath: httpPath,
    now: createClock(),
    stripe: { webhookSecret: "whsec_test_http" },
  });
  const server = http.createServer(async (req, res) => {
    const response = await handleHttpRequest(httpRuntime, req);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/cli/cloud/instance/resume`, {
    method: "POST",
    headers: {
      authorization: "Bearer access_123",
    },
  });
  assert.strictEqual(response.status, 200);
  const payload = await response.json();
  assert.strictEqual(payload.instance.state, "provisioning");
  assert.strictEqual(payload.provisioning_job.state, "queued");

  const whoamiResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/session`, {
    headers: {
      authorization: "Bearer access_123",
    },
  });
  assert.strictEqual(whoamiResponse.status, 200);
  const whoamiPayload = await whoamiResponse.json();
  assert.strictEqual(whoamiPayload.user.email, "user@example.com");
  assert.strictEqual(whoamiPayload.session.id, "sess_123");
  assert.strictEqual(whoamiPayload.identities[0].provider, "github");

  const refreshResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/session/refresh`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ refresh_token: "refresh_123" }),
  });
  assert.strictEqual(refreshResponse.status, 200);
  const refreshPayload = await refreshResponse.json();
  assert.match(refreshPayload.access_token, /^access_/);
  assert.match(refreshPayload.refresh_token, /^refresh_/);
  assert.strictEqual(refreshPayload.session.id, "sess_123");

  const cloudStatusResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/cloud/status`, {
    headers: {
      authorization: `Bearer ${refreshPayload.access_token}`,
    },
  });
  assert.strictEqual(cloudStatusResponse.status, 200);
  const cloudStatusPayload = await cloudStatusResponse.json();
  assert.strictEqual(cloudStatusPayload.instance.state, "provisioning");
  assert.strictEqual(cloudStatusPayload.provisioning_job.state, "queued");

  const httpRunCompleted = await runNextProvisioningJob(httpRuntime);
  const httpMachineState = readState(httpPath);
  const httpMachineToken = httpMachineState.managed_instances[0].machine_auth_token;
  assert.strictEqual(httpRunCompleted.instance.state, "running");

  const machineRegisterResponse = await fetch(`http://127.0.0.1:${address.port}/v1/machine/register`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${httpMachineToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      hostname: "http-vm.managed.superturtle.internal",
      vm_name: "http-managed-vm",
    }),
  });
  assert.strictEqual(machineRegisterResponse.status, 200);
  const machineRegisterPayload = await machineRegisterResponse.json();
  assert.strictEqual(machineRegisterPayload.instance.hostname, "http-vm.managed.superturtle.internal");

  const machineHeartbeatResponse = await fetch(`http://127.0.0.1:${address.port}/v1/machine/heartbeat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${httpMachineToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      health_status: "degraded",
    }),
  });
  assert.strictEqual(machineHeartbeatResponse.status, 200);
  const machineHeartbeatPayload = await machineHeartbeatResponse.json();
  assert.strictEqual(machineHeartbeatPayload.ok, true);
  assert.strictEqual(machineHeartbeatPayload.health_status, "degraded");

  const machineClaudeResponse = await fetch(`http://127.0.0.1:${address.port}/v1/machine/providers/claude`, {
    headers: {
      authorization: `Bearer ${httpMachineToken}`,
    },
  });
  assert.strictEqual(machineClaudeResponse.status, 200);
  const machineClaudePayload = await machineClaudeResponse.json();
  assert.strictEqual(machineClaudePayload.provider, "claude");
  assert.strictEqual(machineClaudePayload.configured, true);
  assert.strictEqual(machineClaudePayload.access_token, "claude-valid-token");

  const teleportTargetResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/teleport/target`, {
    headers: {
      authorization: `Bearer ${refreshPayload.access_token}`,
    },
  });
  assert.strictEqual(teleportTargetResponse.status, 200);
  const teleportTargetPayload = await teleportTargetResponse.json();
  assert.strictEqual(
    teleportTargetPayload.ssh_target,
    "superturtle@http-vm.managed.superturtle.internal"
  );
  assert.strictEqual(teleportTargetPayload.remote_root, "/srv/superturtle");
  assert.strictEqual(teleportTargetPayload.instance.state, "running");

  const reprovisionResponse = await fetch(
    `http://127.0.0.1:${address.port}/v1/cli/cloud/instance/reprovision`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${refreshPayload.access_token}`,
      },
    }
  );
  assert.strictEqual(reprovisionResponse.status, 200);
  const reprovisionPayload = await reprovisionResponse.json();
  assert.strictEqual(reprovisionPayload.instance.state, "provisioning");
  assert.strictEqual(reprovisionPayload.provisioning_job.kind, "reprovision");
  assert.strictEqual(reprovisionPayload.provisioning_job.state, "queued");

  const loginStartResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/login/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "superturtle-cli",
      device_name: "http-devbox",
      scopes: ["cloud:read"],
    }),
  });
  assert.strictEqual(loginStartResponse.status, 200);
  const loginStartPayload = await loginStartResponse.json();
  assert.match(loginStartPayload.device_code, /^device_/);

  const loginPollPendingResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/login/poll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ device_code: loginStartPayload.device_code }),
  });
  assert.strictEqual(loginPollPendingResponse.status, 428);

  const httpRuntimeCompleted = completeLoginRequest(httpRuntime, loginStartPayload.device_code, {
    userId: "user_123",
  });
  assert.strictEqual(httpRuntimeCompleted.status, 200);

  const loginPollCompletedResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/login/poll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ device_code: loginStartPayload.device_code }),
  });
  assert.strictEqual(loginPollCompletedResponse.status, 200);
  const loginPollCompletedPayload = await loginPollCompletedResponse.json();
  assert.strictEqual(loginPollCompletedPayload.session.id, httpRuntimeCompleted.data.session.id);

  const httpStripePayload = JSON.stringify({
    id: "evt_http_subscription_123",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_123",
        customer: "cus_http_123",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: 1775902219,
        metadata: {
          user_id: "user_123",
        },
        items: {
          data: [
            {
              price: {
                lookup_key: "managed",
              },
            },
          ],
        },
      },
    },
  });
  const httpStripeResponse = await fetch(`http://127.0.0.1:${address.port}/v1/billing/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": signStripePayload("whsec_test_http", 1773309615, httpStripePayload),
    },
    body: httpStripePayload,
  });
  assert.strictEqual(httpStripeResponse.status, 200);
  const httpStripeResult = await httpStripeResponse.json();
  assert.strictEqual(httpStripeResult.ok, true);
  assert.strictEqual(readState(httpPath).entitlements[0].state, "active");

  const malformedRefreshResponse = await fetch(`http://127.0.0.1:${address.port}/v1/cli/session/refresh`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
    },
    body: "refresh_123",
  });
  assert.strictEqual(malformedRefreshResponse.status, 415);

  server.close();

  const httpCheckoutPath = resolve(tmpDir, "http-checkout-state.json");
  const httpCheckoutState = createSeedState();
  httpCheckoutState.entitlements[0].state = "inactive";
  writeState(httpCheckoutPath, httpCheckoutState);
  const httpCheckoutRuntime = createRuntime({
    statePath: httpCheckoutPath,
    now: createClock(),
    stripe: {
      billingAdapter: {
        async createCheckoutSession() {
          return {
            id: "cs_http_checkout_123",
            url: "https://checkout.stripe.test/session/cs_http_checkout_123",
            customerId: "cus_http_checkout_123",
            subscriptionId: null,
          };
        },
      },
    },
  });
  const checkoutServer = http.createServer(async (req, res) => {
    const response = await handleHttpRequest(httpCheckoutRuntime, req);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
  await new Promise((resolveListen) => checkoutServer.listen(0, "127.0.0.1", resolveListen));
  const checkoutAddress = checkoutServer.address();
  const httpCheckoutResponse = await fetch(
    `http://127.0.0.1:${checkoutAddress.port}/v1/billing/stripe/checkout-session`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer access_123",
        "content-type": "application/json",
      },
      body: JSON.stringify({ plan: "managed" }),
    }
  );
  assert.strictEqual(httpCheckoutResponse.status, 200);
  const httpCheckoutPayload = await httpCheckoutResponse.json();
  assert.strictEqual(httpCheckoutPayload.checkout_session_id, "cs_http_checkout_123");
  assert.strictEqual(readState(httpCheckoutPath).subscriptions[0].checkout_session_id, "cs_http_checkout_123");
  checkoutServer.close();

  const httpPortalPath = resolve(tmpDir, "http-portal-state.json");
  const httpPortalState = createSeedState();
  httpPortalState.subscriptions.push({
    id: "subrec_http_portal_123",
    provider: "stripe",
    user_id: "user_123",
    provider_customer_id: "cus_http_portal_123",
    provider_subscription_id: "sub_http_portal_123",
    checkout_session_id: "cs_http_portal_123",
    plan: "managed",
    state: "active",
    current_period_end: "2026-04-12T10:00:00Z",
    cancel_at_period_end: false,
    latest_event_id: "evt_http_portal_seed",
    latest_event_type: "customer.subscription.created",
    created_at: "2026-03-12T10:00:00Z",
    updated_at: "2026-03-12T10:00:00Z",
  });
  writeState(httpPortalPath, httpPortalState);
  const httpPortalRuntime = createRuntime({
    statePath: httpPortalPath,
    now: createClock(),
    stripe: {
      billingAdapter: {
        async createCustomerPortalSession() {
          return {
            id: "bps_http_portal_123",
            url: "https://billing.stripe.test/session/bps_http_portal_123",
          };
        },
      },
    },
  });
  const portalServer = http.createServer(async (req, res) => {
    const response = await handleHttpRequest(httpPortalRuntime, req);
    res.writeHead(response.status, response.headers);
    res.end(response.body);
  });
  await new Promise((resolveListen) => portalServer.listen(0, "127.0.0.1", resolveListen));
  const portalAddress = portalServer.address();
  const httpPortalResponse = await fetch(
    `http://127.0.0.1:${portalAddress.port}/v1/billing/stripe/customer-portal-session`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer access_123",
      },
    }
  );
  assert.strictEqual(httpPortalResponse.status, 200);
  const httpPortalPayload = await httpPortalResponse.json();
  assert.strictEqual(httpPortalPayload.customer_id, "cus_http_portal_123");
  assert.strictEqual(httpPortalPayload.portal_session_id, "bps_http_portal_123");
  portalServer.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
