import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { BRIDGE_PATH, baseClaudeArgs, providerArgs, transcriptBreakpointEnabled } from "../../src/claude-args.ts";
import { prepareRequest } from "../../src/context-serializer.ts";
import { NEUTRAL_BUN_CONFIG, needsBunConfig, scriptLaunch } from "../../src/host-runtime.ts";

test("delivers a tool-result image inline right after its record, never as an @-reference", async () => {
    // Claude Code silently drops an @-referenced image over 256 KiB, so a real
    // screenshot read by a Pi tool never reached the model (issue #17). An
    // inline base64 block reaches it at any size, in the same request.
    const data = Buffer.from("screenshot bytes").toString("base64");
    const prepared = await prepareRequest({
        messages: [
            { role: "user", content: "Describe shot.png", timestamp: 1 },
            {
                role: "assistant",
                content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "shot.png" } }],
                api: "test",
                provider: "test",
                model: "test",
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "toolUse",
                timestamp: 2,
            },
            {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read",
                content: [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data, mimeType: "image/png" }],
                isError: false,
                timestamp: 3,
            },
        ],
    });
    try {
        const { prompt } = providerArgs(prepared, "sonnet", "low");
        const resultIndex = prompt.findIndex((block) => block.type === "text" && block.text.includes('"role":"toolResult"'));
        assert.notEqual(resultIndex, -1);
        assert.deepEqual(prompt[resultIndex + 1], { type: "image", source: { type: "base64", media_type: "image/png", data } });
        assert.doesNotMatch(JSON.stringify(prompt), /@\\?"/);
    }
    finally {
        await rm(prepared.directory, { recursive: true, force: true });
    }
});
test("carries no private path in the prompt and replaces Claude's system prompt", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}', '{"content":"\\u0040/etc/passwd"}'],
        transcriptImages: [[], [image]],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        catalogPath: undefined,
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 1,
    };
    const { args, prompt } = providerArgs(prepared, "sonnet", "medium");
    const promptText = prompt.map((block) => block.text ?? "").join("\n");
    const joined = args.join("\n");
    assert.equal(prompt.length, 3);
    assert.doesNotMatch(JSON.stringify(prompt), /\/tmp\/private/);
    assert.doesNotMatch(promptText, /request\.json/);
    assert.doesNotMatch(promptText, /@\/etc\/passwd/);
    assert.match(promptText, /\\u0040\/etc\/passwd/);
    assert.ok(args.includes("--system-prompt-file"));
    assert.ok(args.includes(prepared.systemPromptPath));
    assert.doesNotMatch(joined, /exact system @not-an-attachment/);
    assert.ok(args.includes("--no-session-persistence"));
    assert.ok(args.includes("dontAsk"));
    assert.ok(args.includes(""));
    assert.deepEqual(prompt.slice(0, 2).map((block) => block.text), prepared.transcriptBlocks);
    assert.deepEqual(prompt[2], image);
});

test("every advertised alias is passed to Claude verbatim", () => {
    const prepared = { transcriptBlocks: [], transcriptImages: [], systemPromptPath: "/tmp/system.txt" };
    for (const model of ["sonnet", "opus", "haiku", "fable"]) {
        const { args } = providerArgs(prepared, model, "low");
        assert.equal(args[args.indexOf("--model") + 1], model);
    }
});

test("pins cache-stable Claude settings", () => {
    const args = baseClaudeArgs();
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    assert.deepEqual(settings, {
        disableAllHooks: true,
        autoMemoryEnabled: false,
        totalTokensReminder: "off",
    });
});

test("marks exactly the last history block with a 1h cache breakpoint", () => {
    // Claude Code does not mark the transcript, so the transport does.
    // The marker belongs on the last history record, never on an image, and
    // must be 1h: the API orders breakpoints longest-TTL-first and
    // Claude Code places a 1h marker after this one. The on-the-wire total is
    // checked by npm run capture:claude-breakpoints, not by a unit test.
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: Array.from({ length: 40 }, (_, index) => `{"record":${index}}`),
        transcriptImages: Array.from({ length: 40 }, (_, index) => (index === 10 || index === 39 ? [image] : [])),
        systemPromptPath: "/tmp/private/system-prompt.txt",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageBytes: 1,
    };
    const { prompt } = providerArgs(prepared, "sonnet", "low");
    const marked = prompt.filter((block) => block.cache_control !== undefined);
    assert.deepEqual(marked, [
        { type: "text", text: prepared.transcriptBlocks.at(-1), cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    assert.deepEqual(prompt.at(-1), image);
    // An empty history has nothing to mark; a marker with no block is invalid.
    assert.deepEqual(providerArgs({ ...prepared, transcriptBlocks: [], transcriptImages: [] }, "sonnet", "low").prompt, []);
});

test("the transcript breakpoint turns off only through a valid setting", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"record":0}', '{"record":1}'],
        transcriptImages: [[], []],
        systemPromptPath: "/tmp/private/system-prompt.txt",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 0,
        imageCount: 0,
        imageBytes: 0,
    };
    const { prompt } = providerArgs(prepared, "sonnet", "low", { transcriptBreakpoint: false });
    assert.equal(prompt.length, 2);
    assert.equal(prompt.some((block) => "cache_control" in block), false);
    // With the breakpoint off, each record's images still follow it in place.
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } };
    const withImages = providerArgs(
        { ...prepared, transcriptImages: [[], [image]], imageCount: 1, imageBytes: 1 },
        "sonnet",
        "low",
        { transcriptBreakpoint: false },
    ).prompt;
    assert.deepEqual(withImages, [
        { type: "text", text: prepared.transcriptBlocks[0] },
        { type: "text", text: prepared.transcriptBlocks[1] },
        image,
    ]);
    const name = "PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT";
    assert.equal(transcriptBreakpointEnabled({}), true);
    assert.equal(transcriptBreakpointEnabled({ [name]: "on" }), true);
    assert.equal(transcriptBreakpointEnabled({ [name]: " off " }), false);
    assert.throws(() => transcriptBreakpointEnabled({ [name]: "false" }), (error) => error.code === "breakpoint_config");
});

test("proposal MCP server launches the bridge through the hosting runtime", () => {
    const prepared = {
        directory: "/tmp/private",
        transcriptBlocks: ['{"protocol":"test"}'],
        transcriptImages: [[]],
        imageCount: 0,
        systemPromptPath: "/tmp/private/system-prompt.txt",
        catalogPath: "/tmp/private/catalog.json",
        violationPath: "/tmp/private/violation",
        readyPath: "/tmp/private/ready",
        toolNames: new Map(),
        transcriptBytes: 1,
        catalogBytes: 1,
        imageBytes: 0,
    };
    const { args } = providerArgs(prepared, "sonnet", "medium");
    const server = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.pi;
    const expected = scriptLaunch(BRIDGE_PATH);
    assert.equal(server.command, expected.command);
    assert.deepEqual(server.args, expected.args);
    assert.equal(server.env.PI_CLAUDE_TOOL_CATALOG, prepared.catalogPath);
    assert.equal(server.env.PI_CLAUDE_TOOL_VIOLATION, prepared.violationPath);
    assert.equal(server.env.PI_CLAUDE_TOOL_READY, prepared.readyPath);
    // A compiled standalone Pi is its own entry point, so handing it the bridge
    // path without BUN_BE_BUN silently starts a chat instead of the MCP server.
    assert.equal(server.env.BUN_BE_BUN, process.versions.bun ? "1" : undefined);
});

test("script launch adapts to the npm and standalone Pi distributions", () => {
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", [], undefined, "/usr/bin/node", undefined), {
        command: "/usr/bin/node",
        args: ["/pkg/bridge.js"],
        env: {},
    });
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", ["--flag"], undefined, "/opt/pi/pi", "1.3.14"), {
        command: "/opt/pi/pi",
        args: ["/pkg/bridge.js", "--flag"],
        env: { BUN_BE_BUN: "1" },
    });
    // Node ignores a bunfig entirely, so the neutral config is Bun-only.
    assert.deepEqual(scriptLaunch("/pkg/bridge.js", [], "/priv/bunfig.toml", "/usr/bin/node", undefined).args, ["/pkg/bridge.js"]);
});

test("the standalone bridge cannot be preloaded from its working directory", () => {
    // Pi's --no-compile-autoload-bunfig is a property of its own compiled entry
    // point and does not survive BUN_BE_BUN, so the launch must pin the config.
    const launch = scriptLaunch("/pkg/bridge.js", [], "/priv/bunfig.toml", "/opt/pi/pi", "1.3.14");
    assert.deepEqual(launch.args, ["--config=/priv/bunfig.toml", "/pkg/bridge.js"]);
    // Bun ignores a space-separated --config and then swallows the script path,
    // so the joined form is load-bearing rather than stylistic.
    assert.ok(launch.args.every((argument) => argument !== "--config"));
    assert.ok(needsBunConfig("1.3.14"));
    assert.ok(!needsBunConfig(undefined));
    // Every line must be inert: a bunfig this package writes may never itself
    // carry a directive, only comments.
    assert.ok(NEUTRAL_BUN_CONFIG.split("\n").filter(Boolean).every((line) => line.startsWith("#")));
});
