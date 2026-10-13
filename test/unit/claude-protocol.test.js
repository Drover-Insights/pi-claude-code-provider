import assert from "node:assert/strict";
import test from "node:test";
import { terminalResultErrorDetail, validateClaudeInitialization } from "../../src/claude-protocol.ts";

const base = {
    type: "system",
    subtype: "init",
    tools: [],
    mcp_servers: [],
    model: "claude-sonnet-5",
    permissionMode: "dontAsk",
    slash_commands: [],
    skills: [],
    plugins: [],
    apiKeySource: "none",
};

test("reports sanitized MCP initialization errors without private paths", () => {
    assert.throws(
        () => validateClaudeInitialization({
            ...base,
            mcp_server_errors: [{
                name: "pi",
                type: "invalid_config",
                message: "bad\u0000 config at /tmp/provider-private/catalog.json",
            }],
        }, { tools: new Set(), mcpServer: "none", privatePaths: ["/tmp/provider-private"] }),
        (error) => error.code === "isolation_mcp"
            && /invalid_config: bad +config at <PRIVATE>\/catalog\.json/.test(error.message)
            && !error.message.includes("/tmp/provider-private"),
    );
    assert.throws(
        () => validateClaudeInitialization({ ...base, mcp_server_errors: [{ type: "broken" }] }, { tools: new Set(), mcpServer: "none" }),
        (error) => error.code === "protocol_init",
    );
    assert.throws(
        () => validateClaudeInitialization({
            ...base,
            mcp_server_errors: [{ name: "pi", type: "invalid_config", message: "bad image at /tmp/provider-images/image.png" }],
        }, { tools: new Set(), mcpServer: "none", privatePaths: ["/tmp/provider-private", "/tmp/provider-images"] }),
        (error) => error.code === "isolation_mcp"
            && error.message.includes("<PRIVATE>/image.png")
            && !error.message.includes("/tmp/provider-images"),
    );
});

const builtinPlugins = [
    { name: "agents-md", path: "builtin", source: "agents-md@builtin" },
    { name: "telemetry", path: "builtin", source: "telemetry@builtin" },
];
// Claude Code 2.1.296 renamed agents-md, dropped telemetry, and added plugin-authoring.
const renamedBuiltinPlugins = [
    { name: "cc-plugin-agents-md", path: "builtin", source: "cc-plugin-agents-md@builtin" },
    { name: "cc-plugin-plugin-authoring", path: "builtin", source: "cc-plugin-plugin-authoring@builtin" },
];
const noTools = { tools: new Set(), mcpServer: "none" };

test("accepts the builtin plugins Claude Code always reports", () => {
    assert.equal(validateClaudeInitialization({ ...base, plugins: builtinPlugins }, noTools), "claude-sonnet-5");
    assert.equal(validateClaudeInitialization({ ...base, plugins: [...builtinPlugins].reverse() }, noTools), "claude-sonnet-5");
    assert.equal(validateClaudeInitialization({ ...base, plugins: [builtinPlugins[1]] }, noTools), "claude-sonnet-5");
});

test("accepts the renamed builtin plugins Claude Code 2.1.296 reports", () => {
    assert.equal(validateClaudeInitialization({ ...base, plugins: renamedBuiltinPlugins }, noTools), "claude-sonnet-5");
    assert.equal(validateClaudeInitialization({ ...base, plugins: [...renamedBuiltinPlugins].reverse() }, noTools), "claude-sonnet-5");
    assert.equal(validateClaudeInitialization({ ...base, plugins: [renamedBuiltinPlugins[0]] }, noTools), "claude-sonnet-5");
    assert.equal(validateClaudeInitialization({ ...base, plugins: [renamedBuiltinPlugins[1]] }, noTools), "claude-sonnet-5");
});

test("rejects a mix of the original and renamed builtin plugin sets", () => {
    for (const plugins of [
        [builtinPlugins[0], renamedBuiltinPlugins[0]],
        [builtinPlugins[1], renamedBuiltinPlugins[1]],
        [...builtinPlugins, ...renamedBuiltinPlugins],
    ]) {
        assert.throws(
            () => validateClaudeInitialization({ ...base, plugins }, noTools),
            (error) => error.code === "isolation_customizations",
            JSON.stringify(plugins),
        );
    }
});

test("rejects any plugin other than the exact builtin inventory", () => {
    const [agentsMd] = builtinPlugins;
    for (const plugins of [
        [{ name: "other", path: "builtin", source: "other@builtin" }],
        [{ ...agentsMd, path: "/opt/claude/plugins/agents-md" }],
        [{ ...agentsMd, source: "agents-md@marketplace" }],
        [{ ...agentsMd, extra: true }],
        [{ name: "agents-md", path: "builtin" }],
        [agentsMd, agentsMd],
        [renamedBuiltinPlugins[1], renamedBuiltinPlugins[1]],
        [{ ...renamedBuiltinPlugins[1], source: "cc-plugin-plugin-authoring@marketplace" }],
        [{ ...renamedBuiltinPlugins[1], path: "/opt/claude/plugins/plugin-authoring" }],
        [{ name: "plugin-authoring", path: "builtin", source: "plugin-authoring@builtin" }],
        [...builtinPlugins, { name: "other", path: "/tmp/other", source: "other@local" }],
        ["agents-md"],
        [null],
    ]) {
        assert.throws(
            () => validateClaudeInitialization({ ...base, plugins }, noTools),
            (error) => error.code === "isolation_customizations",
            JSON.stringify(plugins),
        );
    }
});

test("rejects slash commands and skills alongside the builtin plugins", () => {
    for (const plugins of [builtinPlugins, renamedBuiltinPlugins]) {
        for (const extra of [{ slash_commands: ["review"] }, { skills: ["debug"] }, { skills: ["plugin-authoring"] }]) {
            assert.throws(
                () => validateClaudeInitialization({ ...base, plugins, ...extra }, noTools),
                (error) => error.code === "isolation_customizations",
            );
        }
    }
});

test("shares terminal result diagnostics across Claude protocol consumers", () => {
    assert.equal(terminalResultErrorDetail({ result: null, errors: ["first", "second"] }), "first; second");
    assert.equal(terminalResultErrorDetail({ terminal_reason: "limit" }, "assistant detail"), "assistant detail");
});
