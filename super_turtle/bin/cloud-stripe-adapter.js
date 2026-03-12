const crypto = require("crypto");
const http = require("http");
const https = require("https");

const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

function fail(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseStripeSignatureHeader(headerValue) {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    fail("Missing Stripe signature header.", "missing_signature");
  }

  const values = {
    timestamp: null,
    signatures: [],
  };

  for (const part of headerValue.split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = typeof rawKey === "string" ? rawKey.trim() : "";
    const value = typeof rawValue === "string" ? rawValue.trim() : "";
    if (!key || !value) {
      continue;
    }
    if (key === "t") {
      values.timestamp = value;
      continue;
    }
    if (key === "v1") {
      values.signatures.push(value);
    }
  }

  if (!values.timestamp || values.signatures.length === 0) {
    fail("Stripe signature header was incomplete.", "invalid_signature");
  }

  return values;
}

function verifyStripeWebhookSignature({ payload, signatureHeader, webhookSecret, now = Date.now() }) {
  if (typeof webhookSecret !== "string" || webhookSecret.trim().length === 0) {
    fail("Stripe webhook secret is not configured.", "missing_webhook_secret");
  }
  if (typeof payload !== "string" || payload.length === 0) {
    fail("Stripe webhook payload must be a non-empty string.", "invalid_payload");
  }

  const parsed = parseStripeSignatureHeader(signatureHeader);
  const timestampSeconds = Number(parsed.timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    fail("Stripe signature timestamp was invalid.", "invalid_signature");
  }

  const currentSeconds = Math.floor(now / 1000);
  if (Math.abs(currentSeconds - timestampSeconds) > DEFAULT_SIGNATURE_TOLERANCE_SECONDS) {
    fail("Stripe signature timestamp was outside the tolerated window.", "signature_expired");
  }

  const signedPayload = `${parsed.timestamp}.${payload}`;
  const expectedSignature = crypto.createHmac("sha256", webhookSecret).update(signedPayload).digest("hex");
  const expectedBytes = Buffer.from(expectedSignature, "utf-8");

  const matched = parsed.signatures.some((candidate) => {
    const candidateBytes = Buffer.from(candidate, "utf-8");
    return candidateBytes.length === expectedBytes.length && crypto.timingSafeEqual(candidateBytes, expectedBytes);
  });

  if (!matched) {
    fail("Stripe signature verification failed.", "invalid_signature");
  }
}

function parseStripeWebhookEvent(payload) {
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    fail("Stripe webhook payload was not valid JSON.", "invalid_json");
  }

  if (!event || typeof event !== "object" || Array.isArray(event)) {
    fail("Stripe webhook payload must be a JSON object.", "invalid_event");
  }
  if (typeof event.id !== "string" || event.id.trim().length === 0) {
    fail("Stripe webhook event.id is required.", "invalid_event");
  }
  if (typeof event.type !== "string" || event.type.trim().length === 0) {
    fail("Stripe webhook event.type is required.", "invalid_event");
  }
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    fail("Stripe webhook event.data is required.", "invalid_event");
  }
  if (!event.data.object || typeof event.data.object !== "object" || Array.isArray(event.data.object)) {
    fail("Stripe webhook event.data.object is required.", "invalid_event");
  }

  return event;
}

function readMetadataUserId(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  return typeof metadata.user_id === "string" && metadata.user_id.trim().length > 0 ? metadata.user_id.trim() : null;
}

function normalizePlan(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "managed";
  }
  return value.trim();
}

function mapStripeSubscriptionStatus(status) {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "unpaid":
    case "paused":
      return "suspended";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
      return "inactive";
    default:
      return "inactive";
  }
}

function toIsoTimestamp(seconds) {
  if (!Number.isFinite(seconds)) {
    return null;
  }
  return new Date(seconds * 1000).toISOString();
}

function validateReturnUrl(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`Stripe checkout ${fieldName} is required.`, "invalid_checkout_config");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`Stripe checkout ${fieldName} must be a valid URL.`, "invalid_checkout_config");
  }

  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password) {
    fail(`Stripe checkout ${fieldName} must be an http or https URL without embedded credentials.`, "invalid_checkout_config");
  }

  return parsed.toString();
}

function validateCheckoutSessionResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    fail("Stripe checkout adapter returned an invalid response.", "invalid_checkout_response");
  }
  if (typeof response.id !== "string" || response.id.trim().length === 0) {
    fail("Stripe checkout adapter response is missing id.", "invalid_checkout_response");
  }
  if (typeof response.url !== "string" || response.url.trim().length === 0) {
    fail("Stripe checkout adapter response is missing url.", "invalid_checkout_response");
  }

  return {
    id: response.id.trim(),
    url: response.url.trim(),
    customerId:
      typeof response.customerId === "string" && response.customerId.trim().length > 0
        ? response.customerId.trim()
        : null,
    subscriptionId:
      typeof response.subscriptionId === "string" && response.subscriptionId.trim().length > 0
        ? response.subscriptionId.trim()
        : null,
  };
}

function validatePortalSessionResponse(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    fail("Stripe billing portal adapter returned an invalid response.", "invalid_portal_response");
  }
  if (typeof response.url !== "string" || response.url.trim().length === 0) {
    fail("Stripe billing portal adapter response is missing url.", "invalid_portal_response");
  }

  return {
    id:
      typeof response.id === "string" && response.id.trim().length > 0 ? response.id.trim() : null,
    url: response.url.trim(),
  };
}

function encodeStripeForm(data) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(data)) {
    if (value == null) {
      continue;
    }
    params.append(key, String(value));
  }
  return params.toString();
}

function createStripeBillingAdapter(options = {}) {
  const secretKey = typeof options.secretKey === "string" ? options.secretKey.trim() : "";
  const priceId = typeof options.priceId === "string" ? options.priceId.trim() : "";
  const apiBaseUrl =
    typeof options.apiBaseUrl === "string" && options.apiBaseUrl.trim().length > 0
      ? options.apiBaseUrl.trim().replace(/\/+$/, "")
      : "https://api.stripe.com";
  const mode = typeof options.mode === "string" && options.mode.trim().length > 0 ? options.mode.trim() : "subscription";
  const successUrl = validateReturnUrl(options.successUrl, "successUrl");
  const cancelUrl = validateReturnUrl(options.cancelUrl, "cancelUrl");
  const portalReturnUrl = validateReturnUrl(
    options.portalReturnUrl || options.successUrl,
    "portalReturnUrl"
  );

  if (!secretKey) {
    fail("Stripe secret key is not configured.", "missing_api_key");
  }
  if (!priceId) {
    fail("Stripe managed plan price id is not configured.", "missing_price_id");
  }

  return {
    async createCheckoutSession({ userId, plan, customerId, metadata = {} }) {
      if (typeof userId !== "string" || userId.trim().length === 0) {
        fail("Stripe checkout requires a userId.", "invalid_checkout_request");
      }

      const requestBody = encodeStripeForm({
        mode,
        success_url: successUrl,
        cancel_url: cancelUrl,
        "line_items[0][quantity]": 1,
        "line_items[0][price]": priceId,
        "metadata[user_id]": userId.trim(),
        "metadata[plan]": normalizePlan(plan),
        "subscription_data[metadata][user_id]": userId.trim(),
        "subscription_data[metadata][plan]": normalizePlan(plan),
        customer: customerId || undefined,
        "client_reference_id": userId.trim(),
        ...Object.fromEntries(
          Object.entries(metadata)
            .filter(([key, value]) => typeof key === "string" && key.trim().length > 0 && value != null)
            .map(([key, value]) => [`metadata[${key}]`, String(value)])
        ),
      });

      const target = new URL(`${apiBaseUrl}/v1/checkout/sessions`);
      const requestImpl = target.protocol === "http:" ? http : https;
      const response = await new Promise((resolvePromise, rejectPromise) => {
        const request = requestImpl.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            path: `${target.pathname}${target.search}`,
            method: "POST",
            headers: {
              authorization: `Bearer ${secretKey}`,
              "content-type": "application/x-www-form-urlencoded",
              "content-length": Buffer.byteLength(requestBody),
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf-8");
              if (res.statusCode !== 200) {
                const error = new Error(`Stripe checkout session creation failed with status ${res.statusCode}.`);
                error.code = "stripe_checkout_failed";
                error.statusCode = res.statusCode;
                error.responseBody = body;
                rejectPromise(error);
                return;
              }

              let parsed;
              try {
                parsed = JSON.parse(body);
              } catch {
                const error = new Error("Stripe checkout session creation returned invalid JSON.");
                error.code = "stripe_checkout_failed";
                rejectPromise(error);
                return;
              }
              resolvePromise(parsed);
            });
          }
        );
        request.on("error", rejectPromise);
        request.write(requestBody);
        request.end();
      });

      return validateCheckoutSessionResponse({
        id: response.id,
        url: response.url,
        customerId: response.customer,
        subscriptionId: response.subscription,
      });
    },

    async createCustomerPortalSession({ customerId }) {
      if (typeof customerId !== "string" || customerId.trim().length === 0) {
        fail("Stripe billing portal requires a customerId.", "invalid_portal_request");
      }

      const requestBody = encodeStripeForm({
        customer: customerId.trim(),
        return_url: portalReturnUrl,
      });

      const target = new URL(`${apiBaseUrl}/v1/billing_portal/sessions`);
      const requestImpl = target.protocol === "http:" ? http : https;
      const response = await new Promise((resolvePromise, rejectPromise) => {
        const request = requestImpl.request(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            path: `${target.pathname}${target.search}`,
            method: "POST",
            headers: {
              authorization: `Bearer ${secretKey}`,
              "content-type": "application/x-www-form-urlencoded",
              "content-length": Buffer.byteLength(requestBody),
            },
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on("end", () => {
              const body = Buffer.concat(chunks).toString("utf-8");
              if (res.statusCode !== 200) {
                const error = new Error(`Stripe billing portal session creation failed with status ${res.statusCode}.`);
                error.code = "stripe_portal_failed";
                error.statusCode = res.statusCode;
                error.responseBody = body;
                rejectPromise(error);
                return;
              }

              let parsed;
              try {
                parsed = JSON.parse(body);
              } catch {
                const error = new Error("Stripe billing portal session creation returned invalid JSON.");
                error.code = "stripe_portal_failed";
                rejectPromise(error);
                return;
              }
              resolvePromise(parsed);
            });
          }
        );
        request.on("error", rejectPromise);
        request.write(requestBody);
        request.end();
      });

      return validatePortalSessionResponse({
        id: response.id,
        url: response.url,
      });
    },
  };
}

function normalizeStripeWebhookEvent(event) {
  const object = event.data.object;
  if (event.type === "checkout.session.completed") {
    return {
      eventId: event.id,
      eventType: event.type,
      kind: "checkout_session",
      userId: readMetadataUserId(object.metadata),
      customerId: typeof object.customer === "string" && object.customer.trim().length > 0 ? object.customer : null,
      subscriptionId:
        typeof object.subscription === "string" && object.subscription.trim().length > 0
          ? object.subscription
          : null,
      checkoutSessionId: typeof object.id === "string" && object.id.trim().length > 0 ? object.id : null,
      plan: normalizePlan(object.metadata?.plan),
    };
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const firstItem = Array.isArray(object.items?.data) ? object.items.data[0] : null;
    const price = firstItem && firstItem.price && typeof firstItem.price === "object" ? firstItem.price : null;
    return {
      eventId: event.id,
      eventType: event.type,
      kind: "subscription",
      userId: readMetadataUserId(object.metadata),
      customerId: typeof object.customer === "string" && object.customer.trim().length > 0 ? object.customer : null,
      subscriptionId: typeof object.id === "string" && object.id.trim().length > 0 ? object.id : null,
      checkoutSessionId: null,
      plan: normalizePlan(price?.lookup_key || price?.nickname || object.metadata?.plan),
      entitlementState: mapStripeSubscriptionStatus(object.status),
      currentPeriodEnd: toIsoTimestamp(object.current_period_end),
      cancelAtPeriodEnd: typeof object.cancel_at_period_end === "boolean" ? object.cancel_at_period_end : false,
    };
  }

  return {
    eventId: event.id,
    eventType: event.type,
    kind: "ignored",
  };
}

module.exports = {
  createStripeBillingAdapter,
  normalizeStripeWebhookEvent,
  parseStripeWebhookEvent,
  validateCheckoutSessionResponse,
  validatePortalSessionResponse,
  verifyStripeWebhookSignature,
};
