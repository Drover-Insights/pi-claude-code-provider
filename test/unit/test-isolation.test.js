import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const preload = new URL("../support/register-pi-loader.js", import.meta.url).href;

test("the test preload ignores a maintainer's ambient provider configuration", () => {
  const result = spawnSync(process.execPath, [
    "--import", preload,
    "--eval", "process.stdout.write(String(process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG))",
  ], {
    encoding: "utf8",
    env: { ...process.env, PI_CLAUDE_CODE_PROVIDER_CONFIG: "/ambient/instances.json" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "undefined");
});
