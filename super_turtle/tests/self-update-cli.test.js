const assert = require("assert");

const { __test__ } = require("../bin/superturtle.js");

(() => {
  assert.deepStrictEqual(
    __test__.parseExactRuntimeInstallSpec("superturtle@0.2.9-beta.143.1"),
    {
      installSpec: "superturtle@0.2.9-beta.143.1",
      version: "0.2.9-beta.143.1",
    }
  );
  assert.strictEqual(__test__.parseExactRuntimeInstallSpec("superturtle@managed-codex"), null);
  assert.strictEqual(__test__.parseExactRuntimeInstallSpec("latest"), null);

  assert.deepStrictEqual(
    __test__.parseSelfUpdateRunnerArgs([
      "--cwd",
      "/tmp/project",
      "--spec",
      "superturtle@0.2.9-beta.143.1",
    ]),
    {
      cwd: "/tmp/project",
      installSpec: "superturtle@0.2.9-beta.143.1",
    }
  );
})();
