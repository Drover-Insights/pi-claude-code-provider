import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, DefaultPackageManager, SettingsManager, formatSize } from "@earendil-works/pi-coding-agent";
import initializePiClaudeCodeProvider, { createPiClaudeCodeProvider } from "../../extensions/index.ts";
import implementation, { initializePiClaudeCodeProvider as initializeConfiguredProvider } from "../../extensions/pi-claude-code-provider.ts";
import { VERIFIED_VERSIONS, platformStatus } from "../../src/compatibility.ts";
import { providerModelsForSubscription } from "../../src/catalog.ts";
import { createClaudeFailoverStream } from "../../src/failover.ts";
import { CAPTURED_CLAUDE_HELP_PATH, ELIGIBLE_CLAUDE_AUTH } from "../support/claude-fixture.js";
import { nodeFixtureSource } from "../support/node-fixture.js";

const piClaudeCodeProvider = (pi) => initializePiClaudeCodeProvider(pi);
const CONFIGURED_ACCOUNTS = Object.freeze({
    primary: Object.freeze({
        auth: Object.freeze({ ...ELIGIBLE_CLAUDE_AUTH, email: "primary@example.test", orgId: "org_primary" }),
        fingerprint: "sha256:a6ec27b5b85ab0d35d9cf3d7cf13d4448c1c09e5f2a022851266927e9f86a2d1",
    }),
    secondary: Object.freeze({
        auth: Object.freeze({ ...ELIGIBLE_CLAUDE_AUTH, email: "secondary@example.test", orgId: "org_secondary" }),
        fingerprint: "sha256:063d402cc24d9830411472d25a4be57af881048ea10315153373858ff33651dd",
    }),
});

function configuredInstances(primaryRoot, secondaryRoot) {
    return [
        { providerId: "claude-primary", label: "primary", configRoot: primaryRoot, expectedIdentityFingerprint: CONFIGURED_ACCOUNTS.primary.fingerprint },
        { providerId: "claude-secondary", label: "secondary", configRoot: secondaryRoot, expectedIdentityFingerprint: CONFIGURED_ACCOUNTS.secondary.fingerprint },
    ];
}

function configuredAuthByRoot(primaryRoot, secondaryRoot) {
    return {
        [primaryRoot]: CONFIGURED_ACCOUNTS.primary.auth,
        [secondaryRoot]: CONFIGURED_ACCOUNTS.secondary.auth,
    };
}

function fakePi(initialTools = []) {
    const commands = new Map();
    const handlers = new Map();
    const providers = new Map();
    const tools = new Map(initialTools.map((tool) => [tool.name, tool]));
    return {
        commands,
        handlers,
        providers,
        tools,
        api: {
            registerCommand(name, options) { commands.set(name, options); },
            registerProvider(name, config) { providers.set(name, config); },
            registerTool(tool) { tools.set(tool.name, tool); },
            on(event, handler) {
                const values = handlers.get(event) ?? [];
                values.push(handler);
                handlers.set(event, values);
            },
            getAllTools() { return [...tools.values()]; },
        },
    };
}

async function createFakeClaude(searchResult = "ok", {
    searchDelayMs = 0,
    rateLimitInfo,
    configRootRateLimitInfo = {},
    rejectedConfigRoots = [],
    partialBeforeRateLimitRoots = [],
    malformedAfterRateLimitRoots = [],
    rateLimitResultRoots = [],
    requestLogPath,
    reportCwd = false,
    configRootResults = {},
    configRootAuth = {},
    defaultAuth = ELIGIBLE_CLAUDE_AUTH,
    failAuthWithConfigRoot = false,
    failRequestWithConfigRoot = false,
} = {}) {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-extension-"));
    const executable = join(directory, process.platform === "win32" ? "claude.cjs" : "claude");
    const rateLimitEvents = Array.isArray(rateLimitInfo) ? rateLimitInfo : rateLimitInfo ? [rateLimitInfo] : [];
    const init = { type: "system", subtype: "init", tools: ["WebFetch", "WebSearch"], mcp_servers: [], model: "claude-sonnet-5", permissionMode: "dontAsk", slash_commands: [], skills: [], plugins: [], apiKeySource: "none" };
    const providerInit = { ...init, tools: [] };
    // Keep fake Claude JSONL visible in sandboxes that lose buffered Node child stdout.
    await writeFile(executable, nodeFixtureSource(`
if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${VERIFIED_VERSIONS.claudeCode}\n`)});
else if (process.argv[2] === "auth" && process.argv[3] === "status") {
  if (${JSON.stringify(failAuthWithConfigRoot)}) {
    process.stderr.write("auth failed under " + process.env.CLAUDE_CONFIG_DIR);
    process.exit(17);
  }
  process.stdout.write(JSON.stringify(${JSON.stringify(configRootAuth)}[process.env.CLAUDE_CONFIG_DIR] ?? ${JSON.stringify(defaultAuth)}));
}
else if (process.argv.includes("--help")) process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(CAPTURED_CLAUDE_HELP_PATH)}, "utf8"));
else if (${JSON.stringify(failRequestWithConfigRoot)}) {
  process.stderr.write("request failed under " + process.env.CLAUDE_CONFIG_DIR);
  process.exit(17);
}
else {
  setTimeout(() => {
    const providerMode = process.argv.includes("--system-prompt-file");
    process.stdout.write(JSON.stringify(providerMode ? ${JSON.stringify(providerInit)} : ${JSON.stringify(init)}) + "\\n");
    if (${JSON.stringify(requestLogPath)}) require("node:fs").appendFileSync(${JSON.stringify(requestLogPath)}, String(process.env.CLAUDE_CONFIG_DIR) + "\\n");
    if (${JSON.stringify(partialBeforeRateLimitRoots)}.includes(process.env.CLAUDE_CONFIG_DIR)) {
      process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"message_start",message:{id:"msg_partial",model:"claude-sonnet-5",usage:{}}}}) + "\\n");
      process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_start",index:0,content_block:{type:"text",text:""}}}) + "\\n");
      process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"partial"}}}) + "\\n");
      process.stdout.write(JSON.stringify({type:"stream_event",event:{type:"content_block_stop",index:0}}) + "\\n");
    }
    const configuredRateLimits = ${JSON.stringify(configRootRateLimitInfo)}[process.env.CLAUDE_CONFIG_DIR];
    const emittedRateLimits = configuredRateLimits === undefined ? ${JSON.stringify(rateLimitEvents)} : configuredRateLimits;
    for (const rateLimitInfo of emittedRateLimits) process.stdout.write(JSON.stringify({type:"rate_limit_event",rate_limit_info:rateLimitInfo}) + "\\n");
    if (${JSON.stringify(malformedAfterRateLimitRoots)}.includes(process.env.CLAUDE_CONFIG_DIR)) {
      process.stdout.write(JSON.stringify({type:"unsupported_after_rate_limit"}) + "\\n");
      process.exitCode = 1;
    }
    else if (${JSON.stringify(rateLimitResultRoots)}.includes(process.env.CLAUDE_CONFIG_DIR)) {
      process.stdout.write(JSON.stringify({type:"result",is_error:true,api_error_status:429,result:"subscription limit reached"}) + "\\n");
      process.exitCode = 1;
    }
    else if (${JSON.stringify(rejectedConfigRoots)}.includes(process.env.CLAUDE_CONFIG_DIR)) process.exitCode = 1;
    else {
      const configuredResult = ${JSON.stringify(configRootResults)}[process.env.CLAUDE_CONFIG_DIR] ?? ${JSON.stringify(searchResult)};
      process.stdout.write(JSON.stringify({type:"result",is_error:false,result:${reportCwd ? "providerMode ? process.cwd() : " : ""}configuredResult}) + "\\n");
    }
  }, ${searchDelayMs});
}
`), { mode: 0o700 });
    await chmod(executable, 0o700);
    return { directory, executable };
}

test("the default package extension loads an ordered account pool from its private configuration file", async () => {
    const [primaryRoot, secondaryRoot, configurationDirectory] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-config-")),
    ]);
    const configurationPath = join(configurationDirectory, "instances.json");
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
    });
    const originalExecutable = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    const originalConfiguration = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = configurationPath;
    await writeFile(configurationPath, JSON.stringify({
        instances: configuredInstances(primaryRoot, secondaryRoot),
        failover: {
            providerId: "claude-auto",
            label: "automatic",
            order: ["claude-primary", "claude-secondary"],
        },
    }), { mode: 0o600 });
    try {
        const pi = fakePi();

        await implementation(pi.api);

        assert.deepEqual([...pi.providers.keys()], ["claude-primary", "claude-secondary", "claude-auto"]);
    } finally {
        if (originalExecutable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = originalExecutable;
        if (originalConfiguration === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = originalConfiguration;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(configurationDirectory, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("the default package extension preserves ambient single-account behavior when private configuration is unset", async () => {
    const { directory, executable } = await createFakeClaude();
    const originalExecutable = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    const originalConfiguration = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    try {
        const pi = fakePi();

        await implementation(pi.api);

        assert.deepEqual([...pi.providers.keys()], ["pi-claude-code-provider"]);
    } finally {
        if (originalExecutable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = originalExecutable;
        if (originalConfiguration === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = originalConfiguration;
        await rm(directory, { recursive: true, force: true });
    }
});

test("the default package extension rejects a non-private configuration file without disclosing its path", { skip: process.platform === "win32" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-config-"));
    const configurationPath = join(directory, "instances.json");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = configurationPath;
    await writeFile(configurationPath, JSON.stringify({ instances: [] }), { mode: 0o644 });
    try {
        const pi = fakePi();

        await assert.rejects(implementation(pi.api), error => {
            assert.match(error.message, /mode 0600/i);
            assert.doesNotMatch(error.message, new RegExp(configurationPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            return true;
        });
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("the default package extension rejects a symlinked configuration file without disclosing its path", { skip: process.platform === "win32" }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-config-"));
    const targetPath = join(directory, "private.json");
    const configurationPath = join(directory, "instances.json");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = configurationPath;
    await writeFile(targetPath, JSON.stringify({ instances: [] }), { mode: 0o600 });
    await symlink(targetPath, configurationPath);
    try {
        const pi = fakePi();

        await assert.rejects(implementation(pi.api), error => {
            assert.match(error.message, /symlink/i);
            assert.doesNotMatch(error.message, new RegExp(configurationPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
            return true;
        });
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("the default package extension rejects unknown private configuration fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-config-"));
    const configurationPath = join(directory, "instances.json");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = configurationPath;
    await writeFile(configurationPath, JSON.stringify({ instances: [], unexpected: "value" }), { mode: 0o600 });
    try {
        const pi = fakePi();

        await assert.rejects(implementation(pi.api), /unknown field/i);
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("the default package extension allowlists instance and failover descriptor fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-config-"));
    const configurationPath = join(directory, "instances.json");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = configurationPath;
    const cases = [
        { instances: [{ unexpected: "value" }] },
        { instances: [], failover: { unexpected: "value" } },
    ];
    try {
        for (const configuration of cases) {
            await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
            const pi = fakePi();

            await assert.rejects(implementation(pi.api), /unknown field/i);
            assert.equal(pi.providers.size, 0);
            assert.equal(pi.commands.size, 0);
        }
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("the default package extension rejects an oversized private configuration file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-config-"));
    const configurationPath = join(directory, "instances.json");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = configurationPath;
    await writeFile(configurationPath, `${" ".repeat(64 * 1024)}{\"instances\":[]}`, { mode: 0o600 });
    try {
        const pi = fakePi();

        await assert.rejects(implementation(pi.api), /too large/i);
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("the default package extension rejects a private configuration file that is not UTF-8", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-config-"));
    const configurationPath = join(directory, "instances.json");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
    process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = configurationPath;
    await writeFile(configurationPath, Buffer.from([0xff]), { mode: 0o600 });
    try {
        const pi = fakePi();

        await assert.rejects(implementation(pi.api), /valid UTF-8/i);
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_CONFIG = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("account-specific providers reject duplicate canonical Claude configuration roots before registration", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-account-root-"));
    try {
        const pi = fakePi();
        const extension = createPiClaudeCodeProvider({
            instances: configuredInstances(configRoot, configRoot),
        });

        await assert.rejects(extension(pi.api), /distinct.*configuration root/i);
        assert.equal(pi.providers.size, 0);
    } finally {
        await rm(configRoot, { recursive: true, force: true });
    }
});

test("account-specific provider descriptors require distinct opaque IDs and labels", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = join(primaryRoot, "unavailable-claude");
    try {
        const valid = configuredInstances(primaryRoot, secondaryRoot);
        const cases = [
            [],
            [valid[0], { ...valid[1], providerId: valid[0].providerId }],
            [valid[0], { ...valid[1], label: valid[0].label }],
            [{ ...valid[0], providerId: "Claude Primary" }],
            [{ ...valid[0], label: "primary@example.test" }],
        ];
        for (const instances of cases) {
            const pi = fakePi();
            await assert.rejects(createPiClaudeCodeProvider({ instances })(pi.api), /configured instance|provider id|opaque label/i);
            assert.equal(pi.providers.size, 0);
            assert.equal(pi.commands.size, 0);
        }
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover requires a distinct provider and an ordered set of known instances", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    try {
        const instances = configuredInstances(primaryRoot, secondaryRoot);
        const invalidFailovers = [
            { providerId: "claude-primary", label: "automatic", order: ["claude-primary", "claude-secondary"] },
            { providerId: "claude-auto", label: "automatic", order: ["claude-primary", "claude-missing"] },
            { providerId: "claude-auto", label: "automatic", order: ["claude-primary", "claude-primary"] },
            { providerId: "claude-auto", label: "automatic", order: ["claude-primary"] },
        ];
        for (const failover of invalidFailovers) {
            const pi = fakePi();
            await assert.rejects(
                createPiClaudeCodeProvider({ instances, failover })(pi.api),
                /failover/i,
            );
            assert.equal(pi.providers.size, 0);
            assert.equal(pi.commands.size, 0);
            assert.equal(pi.handlers.size, 0);
        }
    } finally {
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
        ]);
    }
});

test("the exported initializer enforces configured instance descriptor and root validation", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-direct-initializer-"));
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: { [configRoot]: CONFIGURED_ACCOUNTS.primary.auth },
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        const invalid = {
            ...configuredInstances(configRoot, configRoot)[0],
            label: "primary@example.test",
        };

        await assert.rejects(
            initializeConfiguredProvider(pi.api, [invalid]),
            /opaque label/i,
        );
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
        assert.equal(pi.handlers.size, 0);

        const missingRootPi = fakePi();
        const missingRoot = join(configRoot, "missing");
        await assert.rejects(
            initializeConfiguredProvider(missingRootPi.api, [{
                ...configuredInstances(configRoot, configRoot)[0],
                configRoot: missingRoot,
            }]),
            (error) => /primary/.test(error.message)
                && /configuration root/i.test(error.message)
                && !error.message.includes(missingRoot),
        );
        assert.equal(missingRootPi.providers.size, 0);
        assert.equal(missingRootPi.commands.size, 0);
        assert.equal(missingRootPi.handlers.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific provider descriptors require a valid identity fingerprint before registration", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-fingerprint-validation-"));
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: { [configRoot]: CONFIGURED_ACCOUNTS.primary.auth },
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const valid = configuredInstances(configRoot, configRoot)[0];
        const cases = [
            { ...valid, expectedIdentityFingerprint: undefined },
            { ...valid, expectedIdentityFingerprint: "sha256:not-a-fingerprint" },
        ];
        for (const instance of cases) {
            const pi = fakePi();
            await assert.rejects(
                createPiClaudeCodeProvider({ instances: [instance] })(pi.api),
                /identity fingerprint/i,
            );
            assert.equal(pi.providers.size, 0);
            assert.equal(pi.commands.size, 0);
            assert.equal(pi.handlers.size, 0);
        }
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific provider startup uses the validated descriptor snapshot", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-descriptor-snapshot-"));
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: { [configRoot]: CONFIGURED_ACCOUNTS.primary.auth },
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const instance = { ...configuredInstances(configRoot, configRoot)[0], configRoot };
        const pi = fakePi();
        const startup = createPiClaudeCodeProvider({ instances: [instance] })(pi.api);
        Object.assign(instance, {
            providerId: "Changed Invalid Provider",
            label: "changed@example.test",
            expectedIdentityFingerprint: CONFIGURED_ACCOUNTS.secondary.fingerprint,
        });

        await startup;

        assert.deepEqual([...pi.providers.keys()], ["claude-primary"]);
        assert.equal(pi.providers.get("claude-primary").name, "Claude Code Subscription (primary)");
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific providers reject missing, non-directory, relative, and non-canonical roots", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-root-validation-"));
    const fileRoot = join(configRoot, "file");
    await writeFile(fileRoot, "not a directory");
    const cases = [
        join(configRoot, "missing"),
        fileRoot,
        relative(process.cwd(), configRoot),
        `${configRoot}/.`,
        `${configRoot}/`,
    ];
    try {
        for (const invalidRoot of cases) {
            const pi = fakePi();
            await assert.rejects(
                createPiClaudeCodeProvider({
                    instances: [{ ...configuredInstances(configRoot, configRoot)[0], configRoot: invalidRoot }],
                })(pi.api),
                (error) => /configuration root/i.test(error.message) && !error.message.includes(invalidRoot),
            );
            assert.equal(pi.providers.size, 0);
            assert.equal(pi.commands.size, 0);
        }
    } finally {
        await rm(configRoot, { recursive: true, force: true });
    }
});

test("account-specific startup labels only the instance with an invalid configuration root", async () => {
    const primaryRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-"));
    const missingRoot = join(primaryRoot, "missing-secondary");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = join(primaryRoot, "unavailable-claude");
    try {
        const pi = fakePi();
        await assert.rejects(
            createPiClaudeCodeProvider({
                instances: configuredInstances(primaryRoot, missingRoot),
            })(pi.api),
            (error) => /secondary/.test(error.message)
                && !/primary/.test(error.message)
                && /configuration root/i.test(error.message)
                && !error.message.includes(missingRoot),
        );
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
        assert.equal(pi.handlers.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(primaryRoot, { recursive: true, force: true });
    }
});

test("account-specific providers reject symlink-ambiguous configuration roots before registration", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-real-root-"));
    const linkedRoot = `${configRoot}-link`;
    await symlink(configRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = join(configRoot, "unavailable-claude");
    try {
        const pi = fakePi();
        const extension = createPiClaudeCodeProvider({
            instances: [
                { ...configuredInstances(configRoot, configRoot)[0], configRoot: linkedRoot },
            ],
        });

        await assert.rejects(extension(pi.api), /canonical.*configuration root/i);
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.commands.size, 0);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(linkedRoot, { recursive: true, force: true }),
            rm(configRoot, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific providers fail closed when a root resolves the wrong account identity", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-wrong-account-"));
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: { [configRoot]: CONFIGURED_ACCOUNTS.secondary.auth },
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: [{ ...configuredInstances(configRoot, configRoot)[0], configRoot }],
        })(pi.api);

        assert.equal(pi.providers.size, 0);
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message) { notices.push(message); } } });
        assert.equal(notices.length, 1);
        assert.match(notices[0], /identity does not match/i);
        for (const privateValue of [
            configRoot,
            CONFIGURED_ACCOUNTS.primary.fingerprint,
            CONFIGURED_ACCOUNTS.secondary.auth.email,
            CONFIGURED_ACCOUNTS.secondary.auth.orgId,
        ]) assert.equal(notices[0].includes(privateValue), false);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific startup identifies the configured instance that fails preflight", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: {
            [primaryRoot]: CONFIGURED_ACCOUNTS.primary.auth,
            [secondaryRoot]: CONFIGURED_ACCOUNTS.primary.auth,
        },
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
        })(pi.api);

        assert.equal(pi.providers.size, 0);
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message) { notices.push(message); } } });
        assert.equal(notices.length, 1);
        assert.match(notices[0], /secondary/);
        assert.doesNotMatch(notices[0], /primary/);
        assert.match(notices[0], /identity does not match/i);
        for (const privateValue of [
            primaryRoot,
            secondaryRoot,
            CONFIGURED_ACCOUNTS.secondary.fingerprint,
            CONFIGURED_ACCOUNTS.primary.auth.email,
            CONFIGURED_ACCOUNTS.primary.auth.orgId,
        ]) assert.equal(notices[0].includes(privateValue), false);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific providers fail closed on unsupported authentication", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-unsupported-auth-"));
    const unsupportedAuth = { ...CONFIGURED_ACCOUNTS.primary.auth, authMethod: "apiKey" };
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: { [configRoot]: unsupportedAuth },
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: [{ ...configuredInstances(configRoot, configRoot)[0], configRoot }],
        })(pi.api);

        assert.equal(pi.providers.size, 0);
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message) { notices.push(message); } } });
        assert.equal(notices.length, 1);
        assert.match(notices[0], /first-party claude\.ai subscription/i);
        assert.equal(notices[0].includes(configRoot), false);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific startup failures redact the bound configuration root", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-redacted-root-"));
    const { directory, executable } = await createFakeClaude("ok", { failAuthWithConfigRoot: true });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: [{ ...configuredInstances(configRoot, configRoot)[0], configRoot }],
        })(pi.api);

        assert.equal(pi.providers.size, 0);
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message) { notices.push(message); } } });
        assert.equal(notices.length, 1);
        assert.equal(notices[0].includes(configRoot), false);
        assert.match(notices[0], /\[configuration root\]/);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific providers fail closed when the Claude executable is unavailable", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-unavailable-executable-"));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = join(tmpdir(), "definitely-unavailable-claude");
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: [{ ...configuredInstances(configRoot, configRoot)[0], configRoot }],
        })(pi.api);

        assert.equal(pi.providers.size, 0);
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { ui: { notify(message) { notices.push(message); } } });
        assert.equal(notices.length, 1);
        assert.match(notices[0], /executable is not runnable/i);
        assert.equal(notices[0].includes(configRoot), false);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(configRoot, { recursive: true, force: true });
    }
});

test("account-specific providers register distinct stable provider IDs", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        const extension = createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
        });

        await extension(pi.api);

        assert.deepEqual([...pi.providers.keys()], ["claude-primary", "claude-secondary"]);
        assert.equal(pi.providers.has("pi-claude-code-provider"), false);
        assert.match(pi.providers.get("claude-primary").name, /primary/i);
        assert.match(pi.providers.get("claude-secondary").name, /secondary/i);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover advertises the most conservative shared model limits", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const auth = configuredAuthByRoot(primaryRoot, secondaryRoot);
    auth[primaryRoot] = { ...auth[primaryRoot], subscriptionType: "max" };
    auth[secondaryRoot] = { ...auth[secondaryRoot], subscriptionType: "pro" };
    const { directory, executable } = await createFakeClaude("ok", { configRootAuth: auth });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
            failover: {
                providerId: "claude-auto",
                label: "automatic",
                order: ["claude-primary", "claude-secondary"],
            },
        })(pi.api);

        const opus = pi.providers.get("claude-auto").models.find((model) => model.id === "opus");
        assert.equal(opus.contextWindow, 200_000);
        assert.equal(opus.maxTokens, 64_000);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("each account-specific provider request uses only its bound Claude configuration root", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootResults: {
            [primaryRoot]: "primary-account",
            [secondaryRoot]: "secondary-account",
        },
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        const extension = createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
        });
        await extension(pi.api);
        const sessionStart = pi.handlers.get("session_start")[0];
        sessionStart({}, { cwd: tmpdir(), ui: { notify() {} } });

        for (const [providerId, expectedText] of [["claude-primary", "primary-account"], ["claude-secondary", "secondary-account"]]) {
            const provider = pi.providers.get(providerId);
            const configured = provider.models.find((model) => model.id === "sonnet");
            const model = { ...configured, provider: providerId, api: provider.api, baseUrl: provider.baseUrl };
            const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
            const result = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
            assert.equal(result.stopReason, "stop");
            assert.deepEqual(result.content, [{ type: "text", text: expectedText }]);
        }

        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover retries an unseen rate-limit rejection and sticks to the standby account", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const requestLogPath = join(primaryRoot, "requests.log");
    const rejected = { status: "rejected", rateLimitType: "five_hour", resetsAt: Date.now() + 60_000 };
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootResults: {
            [primaryRoot]: "primary-account",
            [secondaryRoot]: "secondary-account",
        },
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
        configRootRateLimitInfo: {
            [primaryRoot]: [{ status: "rejected", rateLimitType: "five_hour" }, rejected],
        },
        rejectedConfigRoots: [primaryRoot],
        requestLogPath,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
            failover: {
                providerId: "claude-auto",
                label: "automatic",
                order: ["claude-primary", "claude-secondary"],
            },
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() { throw new Error("UI unavailable"); } } });
        const provider = pi.providers.get("claude-auto");
        assert.ok(provider);
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-auto", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        let payloadCalls = 0;
        let responseCalls = 0;
        const first = await provider.streamSimple(model, context, {
            reasoning: "medium",
            onPayload() { payloadCalls += 1; },
            onResponse() { responseCalls += 1; },
        }).result();
        assert.equal(first.stopReason, "stop");
        assert.deepEqual(first.content, [{ type: "text", text: "secondary-account" }]);
        assert.equal(payloadCalls, 1);
        assert.equal(responseCalls, 1);
        const second = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(second.stopReason, "stop");
        assert.deepEqual(second.content, [{ type: "text", text: "secondary-account" }]);
        assert.deepEqual((await readFile(requestLogPath, "utf8")).trim().split("\n"), [
            primaryRoot,
            secondaryRoot,
            secondaryRoot,
        ]);

        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover retries when Claude reports the rejection as a 429 error result", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const requestLogPath = join(primaryRoot, "requests.log");
    const rejected = { status: "rejected", rateLimitType: "five_hour", resetsAt: Date.now() + 60_000 };
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootResults: {
            [primaryRoot]: "primary-account",
            [secondaryRoot]: "secondary-account",
        },
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
        configRootRateLimitInfo: { [primaryRoot]: [rejected] },
        rateLimitResultRoots: [primaryRoot],
        requestLogPath,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
            failover: {
                providerId: "claude-auto",
                label: "automatic",
                order: ["claude-primary", "claude-secondary"],
            },
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() {} } });
        const provider = pi.providers.get("claude-auto");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-auto", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        const result = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "stop", result.errorMessage);
        assert.deepEqual(result.content, [{ type: "text", text: "secondary-account" }]);
        assert.deepEqual((await readFile(requestLogPath, "utf8")).trim().split("\n"), [primaryRoot, secondaryRoot]);

        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover retries an account after its reported reset even when an earlier notice had none", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const requestLogPath = join(primaryRoot, "requests.log");
    // Claude reports resetsAt in Unix seconds; the failover clock is milliseconds.
    const resetSeconds = 2_000_000_000;
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootResults: { [secondaryRoot]: "secondary-account" },
        configRootRateLimitInfo: {
            [primaryRoot]: [
                { status: "rejected", rateLimitType: "five_hour" },
                { status: "rejected", rateLimitType: "five_hour", resetsAt: resetSeconds },
            ],
        },
        rejectedConfigRoots: [primaryRoot],
        requestLogPath,
    });
    try {
        let clock = resetSeconds * 1000 - 60_000;
        const installation = (configRoot) => ({ executable, version: VERIFIED_VERSIONS.claudeCode, subscriptionType: "pro", configRoot });
        const streamSimple = createClaudeFailoverStream([
            { providerId: "claude-primary", label: "primary", installation: installation(primaryRoot) },
            { providerId: "claude-secondary", label: "secondary", installation: installation(secondaryRoot) },
        ], { now: () => clock, workingDirectory: () => tmpdir() });
        const configured = providerModelsForSubscription("pro").find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-auto", api: "pi-claude-code-provider-headless", baseUrl: "pi-claude-code-provider://local" };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        const first = await streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(first.stopReason, "stop", first.errorMessage);
        clock = resetSeconds * 1000 + 1;
        const second = await streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(second.stopReason, "stop", second.errorMessage);
        assert.deepEqual((await readFile(requestLogPath, "utf8")).trim().split("\n"), [
            primaryRoot,
            secondaryRoot,
            primaryRoot,
            secondaryRoot,
        ]);
    } finally {
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover reports labeled exhaustion after trying each account once", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const requestLogPath = join(primaryRoot, "requests.log");
    const rejected = { status: "rejected", rateLimitType: "five_hour" };
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
        configRootRateLimitInfo: { [primaryRoot]: [rejected], [secondaryRoot]: [rejected] },
        rejectedConfigRoots: [primaryRoot, secondaryRoot],
        requestLogPath,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
            failover: {
                providerId: "claude-auto",
                label: "automatic",
                order: ["claude-primary", "claude-secondary"],
            },
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() {} } });
        const provider = pi.providers.get("claude-auto");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-auto", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        const result = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage, /primary.*secondary/i);
        assert.equal(result.errorMessage.includes(primaryRoot), false);
        assert.equal(result.errorMessage.includes(secondaryRoot), false);
        assert.deepEqual((await readFile(requestLogPath, "utf8")).trim().split("\n"), [primaryRoot, secondaryRoot]);

        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover never retries after assistant output becomes visible", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const requestLogPath = join(primaryRoot, "requests.log");
    const rejected = { status: "rejected", rateLimitType: "five_hour", resetsAt: Date.now() + 60_000 };
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
        configRootRateLimitInfo: { [primaryRoot]: [rejected] },
        rejectedConfigRoots: [primaryRoot],
        partialBeforeRateLimitRoots: [primaryRoot],
        requestLogPath,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
            failover: {
                providerId: "claude-auto",
                label: "automatic",
                order: ["claude-primary", "claude-secondary"],
            },
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() {} } });
        const provider = pi.providers.get("claude-auto");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-auto", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        const result = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.deepEqual(result.content, [{ type: "text", text: "partial" }]);
        const next = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(next.stopReason, "stop");
        assert.deepEqual(next.content, [{ type: "text", text: "unbound" }]);
        assert.deepEqual((await readFile(requestLogPath, "utf8")).trim().split("\n"), [primaryRoot, secondaryRoot]);

        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover preserves a protocol failure that follows a rate-limit notice", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const requestLogPath = join(primaryRoot, "requests.log");
    const rejected = { status: "rejected", rateLimitType: "five_hour" };
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
        configRootRateLimitInfo: { [primaryRoot]: [rejected] },
        malformedAfterRateLimitRoots: [primaryRoot],
        requestLogPath,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
            failover: {
                providerId: "claude-auto",
                label: "automatic",
                order: ["claude-primary", "claude-secondary"],
            },
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() {} } });
        const provider = pi.providers.get("claude-auto");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-auto", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        const result = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.match(result.errorMessage, /unsupported/i);
        assert.deepEqual((await readFile(requestLogPath, "utf8")).trim().split("\n"), [primaryRoot]);

        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("configured failover does not switch accounts for a non-rate-limit failure", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const requestLogPath = join(primaryRoot, "requests.log");
    const { directory, executable } = await createFakeClaude("unbound", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
        rejectedConfigRoots: [primaryRoot],
        requestLogPath,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
            failover: {
                providerId: "claude-auto",
                label: "automatic",
                order: ["claude-primary", "claude-secondary"],
            },
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() {} } });
        const provider = pi.providers.get("claude-auto");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-auto", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        const result = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.deepEqual((await readFile(requestLogPath, "utf8")).trim().split("\n"), [primaryRoot]);

        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("account-specific request failures redact the bound configuration root", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-request-redaction-"));
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: { [configRoot]: CONFIGURED_ACCOUNTS.primary.auth },
        failRequestWithConfigRoot: true,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: [{ ...configuredInstances(configRoot, configRoot)[0], configRoot }],
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() {} } });
        const provider = pi.providers.get("claude-primary");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-primary", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        const result = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(result.stopReason, "error");
        assert.equal(result.errorMessage.includes(configRoot), false);
        assert.match(result.errorMessage, /<PRIVATE>/);

        const search = pi.tools.get("pi_claude_code_provider_web_search");
        await assert.rejects(
            search.execute("call", { query: "query" }, undefined),
            (error) => !error.message.includes(configRoot) && /<PRIVATE>/.test(error.message),
        );
        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("the account-specific doctor checks every bound root and reports labels without paths", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const ineligibleAuth = { loggedIn: false };
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
        defaultAuth: ineligibleAuth,
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
        })(pi.api);
        const notices = [];
        await pi.commands.get("pi-claude-code-provider-doctor").handler("", {
            ui: { notify(message, level) { notices.push({ message, level }); } },
        });

        assert.equal(notices.length, 1);
        assert.match(notices[0].message, /primary/i);
        assert.match(notices[0].message, /secondary/i);
        assert.equal(notices[0].message.includes(primaryRoot), false);
        assert.equal(notices[0].message.includes(secondaryRoot), false);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("the account-specific doctor does not attribute process-wide request metrics to each account", async () => {
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
        })(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() {} } });
        const provider = pi.providers.get("claude-secondary");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = { ...configured, provider: "claude-secondary", api: provider.api, baseUrl: provider.baseUrl };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");

        const notices = [];
        await pi.commands.get("pi-claude-code-provider-doctor").handler("", {
            ui: { notify(message, level) { notices.push({ message, level }); } },
        });

        assert.equal(notices.length, 1);
        assert.match(notices[0].message, /primary/);
        assert.match(notices[0].message, /secondary/);
        assert.doesNotMatch(notices[0].message, /Last request:/);
        assert.doesNotMatch(notices[0].message, /Metrics log error:/);
        assert.doesNotMatch(notices[0].message, /Stale runtime cleanup:/);
        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("the account-specific doctor fully redacts nested configuration roots", async () => {
    const parentRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-parent-root-"));
    const nestedRoot = join(parentRoot, "nested-secret-root");
    await mkdir(nestedRoot);
    const successful = await createFakeClaude("ok", {
        configRootAuth: configuredAuthByRoot(parentRoot, nestedRoot),
    });
    const failing = await createFakeClaude("ok", { failAuthWithConfigRoot: true });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = successful.executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(parentRoot, nestedRoot),
        })(pi.api);
        process.env.PI_CLAUDE_CODE_PROVIDER_PATH = failing.executable;
        const notices = [];

        await pi.commands.get("pi-claude-code-provider-doctor").handler("", {
            ui: { notify(message, level) { notices.push({ message, level }); } },
        });

        assert.equal(notices.length, 1);
        assert.equal(notices[0].message.includes(parentRoot), false);
        assert.equal(notices[0].message.includes(nestedRoot), false);
        assert.equal(notices[0].message.includes("nested-secret-root"), false);
        assert.match(notices[0].message, /\[configuration root\]/);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(parentRoot, { recursive: true, force: true }),
            rm(successful.directory, { recursive: true, force: true }),
            rm(failing.directory, { recursive: true, force: true }),
        ]);
    }
});

test("the account-specific doctor attributes an invalid root only to the affected instance", async () => {
    const [primaryRoot, secondaryRoot, replacementRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-replacement-")),
    ]);
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
        })(pi.api);
        await rm(secondaryRoot, { recursive: true, force: true });
        await symlink(replacementRoot, secondaryRoot, process.platform === "win32" ? "junction" : "dir");
        const notices = [];

        await pi.commands.get("pi-claude-code-provider-doctor").handler("", {
            ui: { notify(message, level) { notices.push({ message, level }); } },
        });

        assert.equal(notices.length, 1);
        assert.equal(notices[0].level, "warning");
        const sections = notices[0].message.split("\n\n");
        const primary = sections.find((section) => section.startsWith("primary\n"));
        const secondary = sections.find((section) => section.startsWith("secondary\n"));
        assert.ok(primary);
        assert.ok(secondary);
        assert.doesNotMatch(primary, /Claude Code check failed/);
        assert.match(secondary, /canonical.*configuration root/i);
        assert.equal(notices[0].message.includes(primaryRoot), false);
        assert.equal(notices[0].message.includes(secondaryRoot), false);
        assert.equal(notices[0].message.includes(replacementRoot), false);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(replacementRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("the account-specific doctor rejects a configuration root replaced by a symlink", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-doctor-root-"));
    const replacementRoot = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-doctor-replacement-"));
    const { directory, executable } = await createFakeClaude("ok", {
        configRootAuth: { [configRoot]: CONFIGURED_ACCOUNTS.primary.auth },
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: [{ ...configuredInstances(configRoot, configRoot)[0], configRoot }],
        })(pi.api);
        await rm(configRoot, { recursive: true, force: true });
        await symlink(replacementRoot, configRoot, process.platform === "win32" ? "junction" : "dir");
        const notices = [];

        await pi.commands.get("pi-claude-code-provider-doctor").handler("", {
            ui: { notify(message, level) { notices.push({ message, level }); } },
        });

        assert.equal(notices.length, 1);
        assert.equal(notices[0].level, "warning");
        assert.match(notices[0].message, /canonical.*configuration root/i);
        assert.equal(notices[0].message.includes(configRoot), false);
        assert.equal(notices[0].message.includes(replacementRoot), false);
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(configRoot, { recursive: true, force: true }),
            rm(replacementRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("platform acknowledgement hides only the startup advisory and leaves doctor truthful", async (t) => {
    const status = platformStatus();
    if (!status.warning) return t.skip("host has no platform advisory");
    const { directory, executable } = await createFakeClaude();
    const originalPath = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    const originalAcknowledgement = process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const notices = [];
        const ctx = { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } };
        delete process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM;
        pi.handlers.get("session_start")[0]({}, ctx);
        assert.ok(notices.some(({ message }) => message.includes(status.warning)));
        await pi.handlers.get("session_shutdown")[0]({}, {});
        notices.length = 0;
        process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM = status.current;
        pi.handlers.get("session_start")[0]({}, ctx);
        assert.equal(notices.some(({ message }) => message.includes(status.warning)), false);
        await pi.commands.get("pi-claude-code-provider-doctor").handler("", ctx);
        assert.ok(notices.some(({ message }) => message.includes(`Platform ${status.current} (unverified;`)));
        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (originalPath === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = originalPath;
        if (originalAcknowledgement === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM;
        else process.env.PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM = originalAcknowledgement;
        await rm(directory, { recursive: true, force: true });
    }
});

test("configured accounts report and deduplicate rate-limit warnings independently", async () => {
    const warning = {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.77,
        resetsAt: 1_800_000_000,
    };
    const [primaryRoot, secondaryRoot] = await Promise.all([
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-primary-")),
        mkdtemp(join(tmpdir(), "pi-claude-code-provider-secondary-")),
    ]);
    const { directory, executable } = await createFakeClaude("ok", {
        rateLimitInfo: [warning, warning],
        configRootAuth: configuredAuthByRoot(primaryRoot, secondaryRoot),
    });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await createPiClaudeCodeProvider({
            instances: configuredInstances(primaryRoot, secondaryRoot),
        })(pi.api);
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };

        for (const providerId of ["claude-primary", "claude-secondary"]) {
            const provider = pi.providers.get(providerId);
            const configured = provider.models.find((model) => model.id === "sonnet");
            const model = { ...configured, provider: providerId, api: provider.api, baseUrl: provider.baseUrl };
            await provider.streamSimple(model, context, { reasoning: "medium" }).result();
            await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        }

        const warnings = notices.filter(({ message }) => message.includes("rate limit warning"));
        assert.equal(warnings.length, 2);
        assert.match(warnings[0].message, /primary/);
        assert.doesNotMatch(warnings[0].message, /secondary/);
        assert.match(warnings[1].message, /secondary/);
        assert.doesNotMatch(warnings[1].message, /primary/);
        await pi.handlers.get("session_shutdown")[0]({}, {});
    } finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([
            rm(primaryRoot, { recursive: true, force: true }),
            rm(secondaryRoot, { recursive: true, force: true }),
            rm(directory, { recursive: true, force: true }),
        ]);
    }
});

test("routes rate-limit warnings to the active Pi UI and launches nothing before a session starts", async () => {
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.876,
        resetsAt: 1_800_000_000,
    } });
    const original = {
        executable: process.env.PI_CLAUDE_CODE_PROVIDER_PATH,
        metrics: process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG,
    };
    const metricsPath = join(directory, "metrics.jsonl");
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = metricsPath;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        assert.ok(provider);
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        // Before any session there is no working directory to run Claude in.
        const early = await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(early.stopReason, "error");
        assert.match(early.errorMessage ?? "", /session working directory is not available/);

        const notices = [];
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        const warning = notices.find(({ message }) => message.includes("rate limit warning"));
        assert.deepEqual(warning, {
            message: `[pi-claude-code-provider] Claude rate limit warning: 87% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleString()}`,
            level: "warning",
        });
        // A seven_day window resets up to a week out, so a bare wall-clock time
        // reads as "today" and understates the wait by days.
        const reset = new Date(1_800_000_000_000);
        assert.ok(warning.message.includes(String(reset.getFullYear())) || warning.message.includes(String(reset.getFullYear() % 100)));
        assert.ok(!warning.message.endsWith(`resets at ${reset.toLocaleTimeString()}`));
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const records = (await readFile(metricsPath, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(records.length, 2);
        assert.deepEqual(records.map((record) => record.errorCategory ?? null), ["working_directory", null]);
        assert.equal(records.every((record) => record.requestedModel === "sonnet"), true);
    }
    finally {
        if (original.executable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original.executable;
        if (original.metrics === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original.metrics;
        await rm(directory, { recursive: true, force: true });
    }
});

test("does not report a disabled overage as a rate limit", async () => {
    // The steady state on a subscription without usage credits: the plan window
    // is healthy and overage is administratively unavailable on every event.
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed",
        rateLimitType: "five_hour",
        utilization: 0.11,
        resetsAt: 1_800_000_000,
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
        isUsingOverage: false,
    } });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")), []);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("reports a repeated rate-limit warning once per session", async () => {
    const warning = {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.77,
        resetsAt: 1_800_000_000,
    };
    // Claude repeats the notice within one process and across the fresh process
    // this transport spawns for every tool round-trip.
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: [warning, warning] });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")), [{
            message: `[pi-claude-code-provider] Claude rate limit warning: 77% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleString()}`,
            level: "warning",
        }]);

        // A new session starts from a clean slate.
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const later = [];
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { later.push({ message, level }); } } });
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.equal(later.filter(({ message }) => message.includes("rate limit")).length, 1);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("reports one warning while utilization moves within the displayed percent", async () => {
    // Utilization arrives as a changing fraction; the notice shows whole percent.
    const warning = (utilization) => ({ status: "allowed_warning", rateLimitType: "five_hour", utilization, resetsAt: 1_800_000_000 });
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: [warning(0.871), warning(0.874)] });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        await provider.streamSimple(model, context, { reasoning: "medium" }).result();
        assert.deepEqual(notices.filter(({ message }) => message.includes("rate limit")).map(({ message }) => message), [
            `[pi-claude-code-provider] Claude rate limit warning: 87% used (five_hour); resets at ${new Date(1_800_000_000_000).toLocaleString()}`,
        ]);
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("converts fractional weekly utilization to a percentage", async () => {
    const { directory, executable } = await createFakeClaude("ok", { rateLimitInfo: {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.861,
    } });
    const original = {
        executable: process.env.PI_CLAUDE_CODE_PROVIDER_PATH,
        metrics: process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG,
    };
    const metricsPath = join(directory, "metrics.jsonl");
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = metricsPath;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        assert.ok(provider);
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        const notices = [];
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal((await provider.streamSimple(model, context, { reasoning: "medium" }).result()).stopReason, "stop");
        assert.deepEqual(notices.find(({ message }) => message.includes("rate limit warning")), {
            message: "[pi-claude-code-provider] Claude rate limit warning: 86% used (seven_day)",
            level: "warning",
        });
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original.executable === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original.executable;
        if (original.metrics === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG;
        else process.env.PI_CLAUDE_CODE_PROVIDER_METRICS_LOG = original.metrics;
        await rm(directory, { recursive: true, force: true });
    }
});

test("failed preflight retains the doctor and reports one session error", async () => {
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = "/does/not/exist/claude";
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        assert.equal(pi.commands.has("pi-claude-code-provider-doctor"), true);
        assert.equal(pi.providers.size, 0);
        assert.equal(pi.tools.size, 0);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal(notices.length, 1);
        assert.equal(notices[0].level, "error");
        assert.match(notices[0].message, /^\[pi-claude-code-provider\]/);
        assert.match(notices[0].message, /unavailable.*pi-claude-code-provider-doctor.*reload/i);
        await pi.commands.get("pi-claude-code-provider-doctor").handler("report", { ui: { notify(message, level) { notices.push({ message, level }); } } });
        const reportPath = notices.at(-1).message.match(/written to (.*); preflight/)?.[1];
        assert.ok(reportPath);
        try {
            assert.equal(notices.at(-1).level, "warning");
            if (process.platform !== "win32") assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
            assert.match(await readFile(reportPath, "utf8"), /"errorCode": "executable_missing"/);
        }
        finally {
            await rm(dirname(reportPath), { recursive: true, force: true });
        }
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
    }
});

test("truncated web-search output is retained only for the session", async () => {
    const { directory, executable } = await createFakeClaude("x".repeat(60 * 1024));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const existingWebSearch = { name: "web_search" };
        const pi = fakePi([existingWebSearch]);
        await piClaudeCodeProvider(pi.api);
        assert.equal(pi.providers.has("pi-claude-code-provider"), true);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal(pi.tools.get("web_search"), existingWebSearch);
        assert.equal(notices.some(({ message }) => /(?:Pi|Claude Code) .*unverified/.test(message)), false);
        assert.equal(notices.every(({ message }) => message.startsWith("[pi-claude-code-provider]")), true);
        const search = pi.tools.get("pi_claude_code_provider_web_search");
        assert.ok(search);
        assert.match(search.description, new RegExp(`${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines`));
        const result = await search.execute("call", { query: "query" }, undefined);
        assert.equal(result.details.truncated, true);
        assert.ok(result.details.fullOutputPath);
        await access(result.details.fullOutputPath);
        const shutdown = pi.handlers.get("session_shutdown") ?? [];
        assert.equal(shutdown.length, 1);
        await shutdown[0]({}, {});
        await assert.rejects(access(result.details.fullOutputPath));
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("web-search output finishing after shutdown is not retained", async () => {
    const { directory, executable } = await createFakeClaude("x".repeat(60 * 1024), { searchDelayMs: 50 });
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    const outputDirectories = async () => (await readdir(tmpdir(), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("pi-claude-code-provider-search-output-"))
        .map((entry) => entry.name)
        .sort();
    const before = await outputDirectories();
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        pi.handlers.get("session_start")[0]({}, { cwd: tmpdir(), ui: { notify() { } } });
        const search = pi.tools.get("pi_claude_code_provider_web_search");
        const pending = search.execute("call", { query: "query" }, undefined);
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const result = await pending;
        assert.equal(result.details.truncated, true);
        assert.equal(result.details.fullOutputPath, undefined);
        assert.doesNotMatch(result.content[0].text, /Full output:/);
        const after = await outputDirectories();
        assert.deepEqual(after.filter((name) => !before.includes(name)), []);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("an occupied permanent web-search name is preserved with a prefixed warning", async () => {
    const { directory, executable } = await createFakeClaude();
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const existingSearch = { name: "pi_claude_code_provider_web_search", owner: "other-extension" };
        const pi = fakePi([existingSearch]);
        await piClaudeCodeProvider(pi.api);
        const notices = [];
        const sessionStart = pi.handlers.get("session_start") ?? [];
        assert.equal(sessionStart.length, 1);
        sessionStart[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { notices.push({ message, level }); } } });
        assert.equal(pi.tools.get("pi_claude_code_provider_web_search"), existingSearch);
        const collision = notices.find(({ message }) => message.includes("tool name is already occupied"));
        assert.ok(collision);
        assert.equal(collision.level, "warning");
        assert.match(collision.message, /^\[pi-claude-code-provider\]/);
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const later = [];
        sessionStart[0]({}, { cwd: tmpdir(), ui: { notify(message, level) { later.push({ message, level }); } } });
        assert.equal(pi.tools.get("pi_claude_code_provider_web_search"), existingSearch);
        assert.equal(later.some(({ message }) => message.includes("tool name is already occupied")), false);
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await rm(directory, { recursive: true, force: true });
    }
});

test("provider requests run Claude in the current Pi session's directory, never the host process cwd", async () => {
    const { directory, executable } = await createFakeClaude("ok", { reportCwd: true });
    const sessionB = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-session-b-"));
    const sessionC = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-session-c-"));
    const original = process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
    process.env.PI_CLAUDE_CODE_PROVIDER_PATH = executable;
    try {
        const pi = fakePi();
        await piClaudeCodeProvider(pi.api);
        const provider = pi.providers.get("pi-claude-code-provider");
        const configured = provider.models.find((model) => model.id === "sonnet");
        const model = {
            ...configured,
            provider: "pi-claude-code-provider",
            api: "pi-claude-code-provider-headless",
            baseUrl: "pi-claude-code-provider://local",
        };
        const context = { messages: [{ role: "user", content: "hello", timestamp: 1 }], tools: [] };
        const request = () => provider.streamSimple(model, context, { reasoning: "medium" }).result();
        const childCwd = async () => {
            const result = await request();
            assert.equal(result.stopReason, "stop", result.errorMessage);
            return result.content.find((block) => block.type === "text")?.text;
        };
        const ui = { notify() { } };
        // A resumed or imported session takes its cwd from the session file, so
        // the host process cwd is the wrong directory to report to Claude.
        assert.notEqual(await realpath(sessionB), await realpath(process.cwd()));
        pi.handlers.get("session_start")[0]({}, { cwd: sessionB, ui });
        assert.equal(await realpath(await childCwd()), await realpath(sessionB));
        await pi.handlers.get("session_shutdown")[0]({}, {});
        const afterShutdown = await request();
        assert.equal(afterShutdown.stopReason, "error");
        assert.match(afterShutdown.errorMessage ?? "", /session working directory is not available/);
        pi.handlers.get("session_start")[0]({}, { cwd: sessionC, ui });
        assert.equal(await realpath(await childCwd()), await realpath(sessionC));
        await pi.handlers.get("session_shutdown")[0]({}, {});
    }
    finally {
        if (original === undefined) delete process.env.PI_CLAUDE_CODE_PROVIDER_PATH;
        else process.env.PI_CLAUDE_CODE_PROVIDER_PATH = original;
        await Promise.all([directory, sessionB, sessionC].map((path) => rm(path, { recursive: true, force: true })));
    }
});

test("Pi resolves the package to its index entry, which re-exports the implementation", async () => {
    // An index entry keeps Pi's startup extension label to the bare package name.
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const agentDir = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-agent-"));
    try {
        const packageManager = new DefaultPackageManager({ cwd: packageRoot, agentDir, settingsManager: SettingsManager.inMemory() });
        const resolved = await packageManager.resolveExtensionSources([packageRoot], { temporary: true });
        assert.deepEqual(resolved.extensions.map((extension) => extension.path), [join(packageRoot, "extensions", "index.ts")]);
        assert.equal(initializePiClaudeCodeProvider, implementation);
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
});
