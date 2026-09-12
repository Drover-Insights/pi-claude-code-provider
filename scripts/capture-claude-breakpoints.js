// Capture where Claude Code places prompt-cache breakpoints in the request this
// provider actually sends, without spending subscription quota. A loopback
// ANTHROPIC_BASE_URL and a dummy token make the CLI serialize a request; the
// local server records it and answers 400. Nothing reaches Anthropic and no
// account credential is read.
//
// The argument vector, stdin prompt and child environment come from the
// provider's own providerArgs and buildClaudeEnvironment, so this follows the
// provider instead of drifting from a hand-rebuilt copy of it.
//
// Two captures are taken, in different private request directories. That is what
// separates the two ways caching fails: a transcript with no breakpoint of its
// own, and a breakpoint that survives behind a block which changes every request.
// A single capture cannot tell them apart.
//
//   npm run capture:claude-breakpoints
//   npm run capture:claude-breakpoints -- --model haiku
//   npm run capture:claude-breakpoints -- --strip-marker
//   npm run capture:claude-breakpoints -- --images 2 --output /tmp/body.json
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeExecutable, buildClaudeEnvironment } from "../src/auth.ts";
import { providerArgs } from "../src/claude-args.ts";

// Anthropic permits four cache breakpoints per request. A fifth is rejected
// outright, so this is a hard ceiling rather than a quality signal.
const MAX_BREAKPOINTS = 4;
// Transcript-dominant padding, well past every model's minimum cacheable prefix,
// so a cached system prompt cannot stand in for a reusable history.
const PAD = Array.from({ length: 2600 }, (_, index) => `stable-${index % 97}`).join(" ");
const BLOCKS = [
  JSON.stringify({ protocol: "capture", instruction: "Inert cache-shape probe." }),
  JSON.stringify({ role: "user", content: `Inert padding: ${PAD}` }),
  JSON.stringify({ role: "user", content: "Reply exactly OK." }),
  JSON.stringify({ role: "assistant", content: [{ type: "text", text: "OK" }] }),
  JSON.stringify({ role: "user", content: "Reply exactly APPEND-OK." }),
];
const SYSTEM_PROMPT = "You are an inert cache-shape probe. Answer the current request.";
const CATALOG = [{ name: "probe", description: "Inert proposal only", inputSchema: { type: "object", properties: {} } }];
// A 1x1 PNG, enough for the CLI to treat an @-reference as a real attachment.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function parseOptions(argv) {
  const options = { model: "sonnet", effort: "low", images: 0, tools: true, marker: true, claude: undefined, output: undefined };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--model") options.model = value();
    else if (flag === "--effort") options.effort = value();
    else if (flag === "--images") options.images = Number.parseInt(value(), 10);
    else if (flag === "--claude") options.claude = value();
    else if (flag === "--output") options.output = value();
    else if (flag === "--no-tools") options.tools = false;
    // The control arm: drop the breakpoint the provider sets, to show the
    // regressed shape on an affected build without editing src/claude-args.ts.
    else if (flag === "--strip-marker") options.marker = false;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!Number.isInteger(options.images) || options.images < 0) throw new Error("--images requires a non-negative integer");
  return options;
}

/** Serve exactly one request body on loopback, then refuse so the CLI stops. */
function captureServer() {
  let resolveBody;
  const body = new Promise((resolve) => {
    resolveBody = resolve;
  });
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      // The CLI may probe other endpoints first. Only a POST carrying a body is
      // the inference request; anything else is refused without being recorded.
      const received = Buffer.concat(chunks).toString("utf8");
      if (request.method === "POST" && received) resolveBody(received);
      const payload = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "local capture complete" } });
      response.writeHead(400, { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) });
      response.end(payload);
    });
  });
  const listening = new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, body, listening, port: () => server.address().port };
}

async function captureOnce(options, executable, home) {
  const { server, body, listening, port } = captureServer();
  await listening;
  const baseUrl = `http://127.0.0.1:${port()}`;
  // Mirror the provider: a fresh private directory per request, holding the
  // system prompt, the catalog, and any generated attachments.
  const directory = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-request-"));
  try {
    await writeFile(join(directory, "system-prompt.txt"), SYSTEM_PROMPT);
    await writeFile(join(directory, "tools.json"), JSON.stringify(CATALOG));
    const attachmentPaths = [];
    for (let index = 0; index < options.images; index++) {
      const path = join(directory, `image-${index}.png`);
      await writeFile(path, PNG);
      attachmentPaths.push(path);
    }
    const prepared = {
      directory,
      systemPromptPath: join(directory, "system-prompt.txt"),
      attachmentPaths,
      transcriptBlocks: BLOCKS,
      ...(options.tools
        ? {
            catalogPath: join(directory, "tools.json"),
            readyPath: join(directory, "mcp-ready"),
            violationPath: join(directory, "mcp-execution-attempt"),
          }
        : {}),
    };
    const { args, prompt } = providerArgs(prepared, options.model, options.effort);
    if (!options.marker) for (const block of prompt) delete block.cache_control;
    const env = buildClaudeEnvironment({
      HOME: home,
      ANTHROPIC_BASE_URL: baseUrl,
      CLAUDE_CODE_OAUTH_TOKEN: "local-capture-dummy-oauth-token",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    });
    // An inherited proxy would send this capture off the loopback interface.
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[name];
    const child = spawn(executable, args, { cwd: directory, env, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
    const captured = await Promise.race([
      body,
      new Promise((_, reject) => child.once("exit", () => setTimeout(() => reject(new Error("Claude Code sent no request to the local capture server")), 1000))),
    ]);
    child.kill();
    return { body: redact(JSON.parse(captured)), prompt };
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redact(nested)]));
  if (typeof value === "string") return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>");
  return value;
}

/** Flatten every block into [label, block] in the order the API reads them. */
function flatten(body) {
  const blocks = [];
  (body.system ?? []).forEach((entry, index) => blocks.push([`system[${index}]`, entry]));
  (body.messages ?? []).forEach((message, messageIndex) => {
    if (typeof message.content === "string") {
      blocks.push([`messages[${messageIndex}]`, { type: "text", text: message.content }]);
      return;
    }
    (message.content ?? []).forEach((block, blockIndex) => blocks.push([`messages[${messageIndex}].content[${blockIndex}]`, block]));
  });
  return blocks;
}

function report(captures) {
  const { body, prompt } = captures.at(-1);
  const blocks = flatten(body);
  const sent = new Set(prompt.map((block) => block.text));
  const history = blocks.flatMap(([, block], position) => (sent.has(block.text) ? [position] : []));
  const first = history.at(0) ?? -1;
  const last = history.at(-1) ?? -1;
  const region = (position) => (position < first ? "ahead of it" : position <= last ? "transcript" : "appended after");

  console.log(`served model:   ${body.model}`);
  console.log(`message roles:  ${(body.messages ?? []).map((message) => message.role).join(", ")}`);
  const marked = blocks.flatMap(([label, block], position) => (block.cache_control ? [{ position, label, block }] : []));
  console.log(`breakpoints:    ${marked.length} of ${MAX_BREAKPOINTS} permitted`);
  for (const { position, label, block } of marked) {
    const ttl = block.cache_control.ttl ?? "5m (default)";
    const preview = JSON.stringify((block.text ?? "").slice(0, 44).replaceAll("\n", " "));
    console.log(`  ${label.padEnd(28)} ttl=${ttl.padEnd(12)} ${region(position).padEnd(16)} ${preview}`);
  }

  const earlier = flatten(captures[0].body);
  const varying = blocks.findIndex(([, block], position) => earlier[position]?.[1]?.text !== block.text);
  if (varying === -1) {
    console.log("first varying:  nothing; the two captures are byte-identical");
  } else {
    console.log(`first varying:  ${blocks[varying][0]} (${region(varying)})`);
    const [left, right] = [earlier[varying]?.[1]?.text ?? "", blocks[varying][1].text ?? ""].map((text) => text.split("\n"));
    for (const [index, line] of right.entries()) {
      if (left[index] !== line) console.log(`  - ${left[index] ?? ""}\n  + ${line}`);
    }
  }

  // The four verdicts are the four things that can go wrong, in the order that
  // makes the earliest one the actionable answer.
  const verdict =
    marked.length > MAX_BREAKPOINTS
      ? `BROKEN: ${marked.length} breakpoints exceeds the ${MAX_BREAKPOINTS} the API accepts; it will reject this request`
      : !marked.some(({ position }) => position >= first && position <= last)
        ? "BROKEN: no breakpoint inside the transcript, so no growing prefix is reusable"
        : varying !== -1 && varying <= last
          ? "BROKEN: a block ahead of the transcript changes every request, so its cached entry is never matched"
          : "HEALTHY: the transcript carries a breakpoint and everything ahead of it is stable";
  console.log(`verdict:        ${verdict}`);
  return verdict.startsWith("HEALTHY");
}

const options = parseOptions(process.argv.slice(2));
const executable = options.claude ?? claudeExecutable();
const home = await mkdtemp(join(tmpdir(), "pi-claude-code-provider-capture-home-"));
let captures;
try {
  captures = [await captureOnce(options, executable, home), await captureOnce(options, executable, home)];
} finally {
  await rm(home, { recursive: true, force: true });
}
const healthy = report(captures);
if (options.output) {
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(captures.at(-1).body, null, 2)}\n`);
  console.log(`wrote:          ${options.output}`);
}
process.exitCode = healthy ? 0 : 1;
