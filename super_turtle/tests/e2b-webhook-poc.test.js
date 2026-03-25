const assert = require("assert");
const fs = require("fs");
const os = require("os");
const { join, resolve } = require("path");
const {
  buildLocalAuthBootstrap,
  buildPocConfig,
  buildRemoteAuthFinalizeCommand,
  buildRemoteBootstrapCommand,
  buildRemoteEnv,
  buildManagedRuntimeManifest,
  buildReadyUrl,
  buildRemoteStartCommand,
  buildStateRecord,
  buildWebhookUrl,
  buildHealthUrl,
  extractTokenFromCredentialPayload,
  hasLocalCodexAuth,
  isMissingSandboxError,
  parseDotEnv,
  persistManagedRuntimeManifest,
  persistRemoteProjectState,
  serializeDotEnv,
  shouldRunFullBootstrap,
} = require("../bin/e2b-webhook-poc-lib.js");
const { loadDotEnvFileIntoProcess } = require("../bin/e2b-webhook-poc.js");

(() => {
  const envFile = resolve(os.tmpdir(), `superturtle-dotenv-${Date.now()}-${Math.random().toString(16).slice(2)}.env`);
  const originalE2BApiKey = process.env.E2B_API_KEY;
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.E2B_API_KEY = "ambient-key";
  process.env.TELEGRAM_BOT_TOKEN = "ambient-token";
  fs.writeFileSync(
    envFile,
    "E2B_API_KEY=project-key\nTELEGRAM_BOT_TOKEN=project-token\nNEW_ONLY=from-file\n",
    "utf-8"
  );
  loadDotEnvFileIntoProcess(envFile);
  assert.strictEqual(process.env.E2B_API_KEY, "project-key");
  assert.strictEqual(process.env.TELEGRAM_BOT_TOKEN, "project-token");
  assert.strictEqual(process.env.NEW_ONLY, "from-file");
  fs.unlinkSync(envFile);
  if (originalE2BApiKey === undefined) {
    delete process.env.E2B_API_KEY;
  } else {
    process.env.E2B_API_KEY = originalE2BApiKey;
  }
  if (originalTelegramToken === undefined) {
    delete process.env.TELEGRAM_BOT_TOKEN;
  } else {
    process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
  }
  delete process.env.NEW_ONLY;

  const parsed = parseDotEnv(`
# comment
TELEGRAM_BOT_TOKEN=123:abc
TELEGRAM_ALLOWED_USERS="12345"
CLAUDE_WORKING_DIR='/tmp/project'
`);
  assert.deepStrictEqual(parsed, {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_ALLOWED_USERS: "12345",
    CLAUDE_WORKING_DIR: "/tmp/project",
  });
  assert.strictEqual(
    extractTokenFromCredentialPayload('{"claudeAiOauth":{"accessToken":"token-123"}}'),
    "token-123"
  );

  const config = buildPocConfig("/Users/example/project", {
    port: "8787",
    runtimeInstallSpec: "superturtle@0.2.6-beta.148.1",
    timeoutMs: "123000",
    webhookPath: "telegram/webhook/demo",
  });
  assert.strictEqual(config.port, 8787);
  assert.strictEqual(config.timeoutMs, 123000);
  assert.strictEqual(config.webhookPath, "/telegram/webhook/demo");
  assert.strictEqual(config.remoteRoot, "/home/user/project");
  assert.strictEqual(config.templateId, "superturtle-managed-runtime:latest");
  assert.strictEqual(config.templateVersion, "latest");
  assert.strictEqual(config.runtimeInstallSpec, "superturtle@0.2.6-beta.148.1");
  assert.strictEqual(config.runtimeVersion, "0.2.6-beta.148.1");

  const remoteEnv = buildRemoteEnv(
    {
      TELEGRAM_BOT_TOKEN: "123:abc",
      TELEGRAM_ALLOWED_USERS: "12345",
      CLAUDE_WORKING_DIR: "/local/path",
      OPENAI_API_KEY: "sk-test",
    },
    "/home/user/project",
    "https://sandbox.example/telegram/webhook/demo",
    "secret-demo",
    8787,
    "/healthz",
    "/readyz",
    "agent",
    "codex",
    { claudeAccessToken: "claude-token-123" }
  );
  assert.strictEqual(remoteEnv.CLAUDE_WORKING_DIR, "/home/user/project");
  assert.strictEqual(remoteEnv.CLAUDE_CODE_OAUTH_TOKEN, "claude-token-123");
  assert.strictEqual(remoteEnv.SUPERTURTLE_RUNTIME_ROLE, "teleport-remote");
  assert.strictEqual(remoteEnv.SUPERTURTLE_REMOTE_MODE, "agent");
  assert.strictEqual(remoteEnv.SUPERTURTLE_REMOTE_DRIVER, "codex");
  assert.strictEqual(remoteEnv.TELEGRAM_TRANSPORT, "webhook");
  assert.strictEqual(remoteEnv.TELEGRAM_WEBHOOK_REGISTER, "false");
  assert.strictEqual(remoteEnv.TELEGRAM_WEBHOOK_URL, "https://sandbox.example/telegram/webhook/demo");
  assert.strictEqual(remoteEnv.TELEGRAM_WEBHOOK_SECRET, "secret-demo");
  assert.strictEqual(remoteEnv.TELEGRAM_WEBHOOK_READY_PATH, "/readyz");
  assert.strictEqual(remoteEnv.DASHBOARD_ENABLED, "false");
  assert.strictEqual(remoteEnv.PORT, "8787");
  assert.strictEqual(remoteEnv.TURTLE_GREETINGS, "false");

  const state = buildStateRecord("/Users/example/project", "sandbox_123", "host.example", {
    port: 8787,
    timeoutMs: 123000,
    templateId: "superturtle-managed-runtime:latest",
    templateVersion: "latest",
    runtimeInstallSpec: "superturtle@0.2.6-beta.148.1",
    runtimeVersion: "0.2.6-beta.148.1",
    remoteMode: "agent",
    remoteDriver: "codex",
    remoteRoot: "/home/user/project",
    webhookPath: "/telegram/webhook/demo",
    webhookSecret: "secret-demo",
    healthPath: "/healthz",
    readyPath: "/readyz",
    logPath: "/tmp/superturtle-e2b-bot.log",
    pidPath: "/tmp/superturtle-e2b-bot.pid",
  });
  assert.strictEqual(state.webhookUrl, "https://host.example/telegram/webhook/demo");
  assert.strictEqual(state.healthUrl, "https://host.example/healthz");
  assert.strictEqual(state.readyUrl, "https://host.example/readyz");
  assert.strictEqual(state.ownerMode, "local");
  assert.strictEqual(state.managed, true);
  assert.strictEqual(state.remoteMode, "agent");
  assert.strictEqual(state.remoteDriver, "codex");
  assert.strictEqual(state.runtimeInstallSpec, "superturtle@0.2.6-beta.148.1");

  assert.strictEqual(buildWebhookUrl("host.example", "/telegram/webhook/demo"), "https://host.example/telegram/webhook/demo");
  assert.strictEqual(buildHealthUrl("host.example", "healthz"), "https://host.example/healthz");
  assert.strictEqual(buildReadyUrl("host.example", "readyz"), "https://host.example/readyz");
  assert.deepStrictEqual(
    parseDotEnv(serializeDotEnv({
      TELEGRAM_BOT_TOKEN: "123:abc",
      CLAUDE_CODE_OAUTH_TOKEN: "token-with-specials:/+=",
      TELEGRAM_ALLOWED_USERS: "12345",
    })),
    {
      TELEGRAM_BOT_TOKEN: "123:abc",
      CLAUDE_CODE_OAUTH_TOKEN: "token-with-specials:/+=",
      TELEGRAM_ALLOWED_USERS: "12345",
    }
  );

  const bootstrapCommand = buildRemoteBootstrapCommand({
    remoteRoot: "/home/user/project",
    logPath: "/tmp/superturtle-e2b-bot.log",
    pidPath: "/tmp/superturtle-e2b-bot.pid",
    runtimeInstallSpec: "superturtle@0.2.6-beta.148.1",
  });
  assert.match(bootstrapCommand, /curl -fsSL https:\/\/bun\.sh\/install/);
  assert.match(bootstrapCommand, /bun install -g 'superturtle@0\.2\.6-beta\.148\.1'/);
  assert.match(bootstrapCommand, /command -v superturtle/);
  assert.doesNotMatch(bootstrapCommand, /tar -xzf/);

  const authFinalizeCommand = buildRemoteAuthFinalizeCommand({
    remoteRoot: "/home/user/project",
    remoteMode: "agent",
  });
  assert.match(authFinalizeCommand, /npm install -g --prefix "\$HOME\/\.local" @openai\/codex/);
  assert.match(authFinalizeCommand, /codex login status/);

  const manifest = buildManagedRuntimeManifest({
    runtimeInstallSpec: "superturtle@0.2.6-beta.148.1",
    runtimeVersion: "0.2.6-beta.148.1",
    templateId: "template_123",
    templateVersion: "v0.2.6-beta.148.1",
    remoteMode: "agent",
    remoteDriver: "codex",
  });
  assert.strictEqual(manifest.runtime_install_spec, "superturtle@0.2.6-beta.148.1");
  assert.strictEqual(manifest.runtime_version, "0.2.6-beta.148.1");
  assert.strictEqual(manifest.remote_mode, "agent");
  assert.strictEqual(manifest.remote_driver, "codex");
  assert.strictEqual(
    shouldRunFullBootstrap(
      {
        runtimeInstallSpec: "superturtle@0.2.6-beta.148.1",
        runtimeVersion: "0.2.6-beta.148.1",
        remoteMode: "agent",
        remoteDriver: "codex",
      },
      manifest
    ),
    false
  );
  assert.strictEqual(
    shouldRunFullBootstrap(
      {
        runtimeInstallSpec: "superturtle@0.2.6-beta.148.1",
        runtimeVersion: "0.2.6-beta.148.1",
        remoteMode: "control",
        remoteDriver: null,
      },
      manifest
    ),
    true
  );
  assert.strictEqual(
    shouldRunFullBootstrap(
      {
        runtimeInstallSpec: "superturtle@0.2.6-beta.149.1",
        runtimeVersion: "0.2.6-beta.149.1",
        remoteMode: "agent",
        remoteDriver: "codex",
      },
      manifest
    ),
    true
  );

  const startCommand = buildRemoteStartCommand({
    remoteRoot: "/home/user/project",
    logPath: "/tmp/superturtle-e2b-bot.log",
    pidPath: "/tmp/superturtle-e2b-bot.pid",
  });
  assert.match(startCommand, /echo \$\$ > '\/tmp\/superturtle-e2b-bot\.pid'/);
  assert.match(startCommand, /export CLAUDE_WORKING_DIR='\/home\/user\/project'/);
  assert.match(startCommand, /export SUPERTURTLE_RESTART_ON_CRASH=1/);
  assert.match(startCommand, /superturtle stop >/);
  assert.match(startCommand, /exec superturtle service run/);

  assert.throws(
    () =>
      buildRemoteEnv(
        { TELEGRAM_ALLOWED_USERS: "12345" },
        "/home/user/project",
        "https://sandbox.example/telegram/webhook/demo",
        "secret-demo",
        8787,
        "/healthz",
        "/readyz",
        "control",
        null
    ),
    /TELEGRAM_BOT_TOKEN/
  );

  assert.strictEqual(
    isMissingSandboxError(Object.assign(new Error("Paused sandbox abc not found"), { name: "NotFoundError" })),
    true
  );
  assert.strictEqual(
    isMissingSandboxError(new Error("some other failure")),
    false
  );
})();

(async () => {
  const writes = [];
  const commands = [];
  const fakeSandbox = {
    files: {
      async write(filePath, content) {
        writes.push({ filePath, content });
      },
    },
    commands: {
      async run(command) {
        commands.push(command);
      },
    },
  };

  const remoteEnv = {
    TELEGRAM_BOT_TOKEN: "123:abc",
    TELEGRAM_ALLOWED_USERS: "12345",
  };
  const projectState = await persistRemoteProjectState(fakeSandbox, {
    remoteRoot: "/home/user/project",
  }, remoteEnv);
  assert.deepStrictEqual(projectState, {
    remoteProjectConfigPath: "/home/user/project/.superturtle/project.json",
    remoteProjectEnvPath: "/home/user/project/.superturtle/.env",
  });
  assert.strictEqual(writes.length, 2);
  assert.strictEqual(writes[0].filePath, "/home/user/project/.superturtle/project.json");
  assert.strictEqual(writes[1].filePath, "/home/user/project/.superturtle/.env");
  assert.deepStrictEqual(JSON.parse(String(writes[0].content).trim()).repo_root, "/home/user/project");
  assert.deepStrictEqual(String(writes[1].content), "TELEGRAM_BOT_TOKEN=123:abc\nTELEGRAM_ALLOWED_USERS=12345\n");
  assert.strictEqual(commands.length, 2);

  await persistManagedRuntimeManifest(fakeSandbox, {
    remoteRoot: "/home/user/project",
    runtimeInstallSpec: "superturtle@0.2.6-beta.148.1",
    runtimeVersion: "0.2.6-beta.148.1",
    templateId: "template_123",
    templateVersion: "v0.2.6-beta.148.1",
    remoteMode: "agent",
    remoteDriver: "codex",
  });

  const manifestWrite = writes.at(-1);
  assert.strictEqual(manifestWrite.filePath, "/home/user/project/.superturtle/managed-runtime.json");
  const parsed = JSON.parse(String(manifestWrite.content).trim());
  assert.strictEqual(parsed.runtime_install_spec, "superturtle@0.2.6-beta.148.1");
  assert.strictEqual(parsed.runtime_version, "0.2.6-beta.148.1");
  assert.strictEqual(parsed.remote_mode, "agent");
  assert.strictEqual(parsed.remote_driver, "codex");
})();

(() => {
  const tmpHome = fs.mkdtempSync(resolve(os.tmpdir(), "superturtle-e2b-auth-test-"));
  const codexDir = join(tmpHome, ".codex");
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(join(codexDir, "auth.json"), "{\"token\":\"demo\"}\n", "utf-8");

  const originalHome = process.env.HOME;
  const originalClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    process.env.HOME = tmpHome;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "claude-env-token";

    const bootstrap = buildLocalAuthBootstrap({});
    assert.strictEqual(bootstrap.claudeAccessToken, "claude-env-token");
    assert.strictEqual(hasLocalCodexAuth(), true);
    assert.strictEqual(bootstrap.codexAuthSourcePath, join(tmpHome, ".codex", "auth.json"));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalClaudeToken === undefined) {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    } else {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = originalClaudeToken;
    }
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
})();
