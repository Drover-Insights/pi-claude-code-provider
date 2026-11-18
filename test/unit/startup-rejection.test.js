import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeEventMapper } from "../../src/stream-events.ts";

function fixture() {
  const events = [], effects = [], output = { content: [] };
  const mapper = new ClaudeEventMapper({
    stream: { push: event => events.push(event), end: () => effects.push("end") },
    output, expectedTools: new Set(), toolNames: new Map(),
    onToolUse: () => effects.push("tool"),
    onResponseAnnouncement: () => effects.push("response"),
  });
  const record = { type: "system", subtype: "init", tools: [], mcp_servers: [],
    model: "synthetic-opus", permissionMode: "dontAsk", apiKeySource: "none",
    slash_commands: [], skills: [], plugins: [] };
  return { mapper, record, events, effects, output };
}

for (let mask = 1; mask < 8; mask++) {
  const labels = ["slash-commands", "skills", "plugins"].filter((_, index) => mask & (1 << index));
  test(`startup rejection reports only fixed categories: ${labels.join(",")}`, () => {
    const f = fixture();
    if (mask & 1) f.record.slash_commands = ["SYNTHETIC_PRIVATE_COMMAND"];
    if (mask & 2) f.record.skills = ["SYNTHETIC_PRIVATE_SKILL"];
    if (mask & 4) f.record.plugins = [{ name: "SYNTHETIC_PRIVATE_PLUGIN", path: "/synthetic/private", source: "private" }];
    assert.throws(() => f.mapper.accept(f.record), error => {
      assert.equal(error.code, "isolation_customizations");
      assert.equal(error.message, `Claude Code loaded unexpected customizations [inventory: ${labels.join(",")}]`);
      assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE|\/synthetic\/private/);
      return true;
    });
    assert.deepEqual(f.events, []);
    assert.deepEqual(f.effects, []);
    assert.equal(f.output.responseModel, undefined);
  });
}

for (const [name, mutate, code] of [
  ["tools before customization", record => { record.tools = ["unexpected"]; record.skills = ["private"]; }, "isolation_tools"],
  ["permissions before customization", record => { record.permissionMode = "default"; record.skills = ["private"]; }, "isolation_permissions"],
  ["malformed inventory", record => { record.skills = {}; }, "protocol_init"],
  ["authentication", record => { record.apiKeySource = "apiKey"; }, "isolation_auth"],
  ["MCP", record => { record.mcp_servers = [{ name: "unexpected", status: "connected" }]; }, "isolation_mcp"],
]) test(`startup detail preserves ${name} refusal`, () => {
  const f = fixture(); mutate(f.record);
  assert.throws(() => f.mapper.accept(f.record), error => {
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /\[inventory:/);
    return true;
  });
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.effects, []);
});

test("accepted startup still publishes the response only after validation", () => {
  const f = fixture();
  f.mapper.accept(f.record);
  assert.equal(f.output.responseModel, "synthetic-opus");
  assert.equal(f.events[0]?.type, "start");
  assert.deepEqual(f.effects, ["response"]);
});

test("projection failure retains the original denial without publishing output", () => {
  const f = fixture(); let reads = 0;
  Object.defineProperty(f.record, "skills", { get() {
    if (++reads > 2) throw new Error("SYNTHETIC_PRIVATE_GETTER");
    return ["synthetic"];
  } });
  assert.throws(() => f.mapper.accept(f.record), error => error.code === "isolation_customizations" &&
    error.message === "Claude Code loaded unexpected customizations");
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.effects, []);
});
