# pi-claude-code-provider

A [Pi](https://pi.dev) package that creates a provider for Claude family models from a subscription-authenticated Claude Code installation by launching Anthropic's installed `claude` executable in documented non-interactive print mode. Pi remains fully in charge of the session: branching, compaction, and history behave like any other Pi provider, and every tool runs visibly in Pi — the Claude process can propose tool calls but never execute anything on its own. The goal is simple: the convenience of your Claude subscription in Pi, with the fewest possible surprises.

This package never imitates private OAuth traffic, does not use the Agents SDK, and does not modify Claude's internal session files. It never reads Claude credentials or uses an Anthropic API key.

This project was developed using frontier AI models under human guidance. Almost all of the docs and code were written by machines except for this introductory material. The project may be over-engineered in some respects; that's fine. If you enjoy this package, please star it on github.

## Requirements

- [Pi](https://pi.dev) 0.85.1 or newer, installed from npm or a standalone build
- Claude Code 2.1.270 or newer
- Claude Code logged in to an eligible Pro, Max, Team, or Enterprise claude.ai subscription
- Node.js 22.19 or newer only when Pi itself is installed from npm; the standalone build needs no separate Node installation

Those are the minimum supported versions. They are not the same as the tested
[compatibility baseline](DEVELOPING.md#compatibility-baseline), which records the newest versions a release gate has actually validated and moves on its own schedule. An older install is not blocked; `/pi-claude-code-provider-doctor` reports when one falls below the minimum.

Pi ships as an npm package that runs on Node and as a compiled standalone binary that embeds Bun. Both are supported: the package launches its tool-proposal bridge under whichever runtime is hosting Pi rather than assuming Node. The standalone build carries its own live bridge gate, which the maintainer runs on Linux x64; the table in [DEVELOPING.md](DEVELOPING.md#compatibility-baseline) records the exact scope. Run `/pi-claude-code-provider-doctor` on either build: it reports the resolved runtime and completes a real bridge handshake.

See the [compatibility baseline](DEVELOPING.md#compatibility-baseline) for tested versions and platforms. Other platforms continue with a warning and runtime capability checks.

The provider rejects API-key authentication and any non-first-party routing, such as Bedrock, Vertex, or Foundry, and does not forward API keys or `ANTHROPIC_BASE_URL` to Claude. If `claude` is not on `PATH`, set `PI_CLAUDE_CODE_PROVIDER_PATH` to its executable path.

## Install

```bash
pi install npm:pi-claude-code-provider
```

To install directly from GitHub's default branch:

```bash
pi install git:github.com/chem/pi-claude-code-provider
```

Add `-l` for a project-local installation. Pi loads project packages only after the project is trusted; use `pi config` to enable or disable the extension.

## Use

Open `/model` and choose one of these aliases: `sonnet`, `fable`, `opus`, or `haiku`. Pi displays them with the provider name, for example `sonnet [pi-claude-code-provider]`.

To select one directly:

```text
/model pi-claude-code-provider/sonnet
```

The same canonical reference works from the command line with `pi --model pi-claude-code-provider/sonnet`.

Pi maps its exposed thinking levels to Claude's `low`, `medium`, `high`, `xhigh`, and `max` effort values; unsupported levels are hidden. Opus uses a 200K context window on Pro and 1M on Max, Team, and Enterprise. The provider retains 200K on Pro even when Claude Code reports a 1M-capable variant, because it cannot determine credit availability.

The `fable` alias is offered and separately testable, but it is excluded from the paid release gate. Fable availability, included allocation, and billing vary by subscription tier. It otherwise follows the standard alias path wherever the account allows it. See Anthropic's [Fable plan policy](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan).

**Model identity:** self-identification is generated text, not routing metadata, and Pi's coding-tool prompt and schemas can make Claude name an older Sonnet even when Claude Code served Opus. Use the assistant message's `responseModel` field in Pi's JSON output for the served model; Pi's status line shows the requested alias.

After installation or an upstream update, run:

```text
/pi-claude-code-provider-doctor
```

It names the concrete model each alias is currently served, alongside the resolved versions, runtime, and bridge handshake, without consuming subscription quota.

Run `/pi-claude-code-provider-doctor report` to write a bounded, content-free JSON diagnostic report in a private temporary directory. Inspect the report before sharing it.

The package also registers `pi_claude_code_provider_web_search`, a visible Pi tool that runs Claude with only WebSearch and WebFetch. It is skipped with a warning if another extension already owns that name. Truncated full results are removed at session shutdown.

### Isolated account instances

The default extension remains a single provider named `pi-claude-code-provider` and uses the ambient Claude configuration. A wrapper extension can instead register explicitly named account instances:

```ts
import { createPiClaudeCodeProvider } from "pi-claude-code-provider/extensions/index.ts";

export default createPiClaudeCodeProvider({
  instances: [
    {
      providerId: "claude-primary",
      label: "primary",
      configRoot: "/absolute/physical/path/to/primary-config",
      expectedIdentityFingerprint: "sha256:<64 lowercase hexadecimal digits>",
    },
    {
      providerId: "claude-secondary",
      label: "secondary",
      configRoot: "/absolute/physical/path/to/secondary-config",
      expectedIdentityFingerprint: "sha256:<64 lowercase hexadecimal digits>",
    },
  ],
  failover: {
    providerId: "claude-auto",
    label: "automatic",
    order: ["claude-primary", "claude-secondary"],
  },
});
```

Load the wrapper instead of the package's default manifest entry. Provider IDs and labels are distinct lowercase opaque labels, not emails, account IDs, or display names. Configuration roots must be existing absolute physical directories in canonical form. Relative paths, missing directories, duplicate roots, and any root or ancestor symlink fail before the extension registers anything.

Configured instances require `email` and `orgId` from `claude auth status`. These are undocumented Claude Code fields, so their presence is capability-checked and missing fields fail closed. The version 1 fingerprint is SHA-256 over this exact UTF-8 text, with the email trimmed and lowercased and the organization ID trimmed:

```text
pi-claude-code-provider:claude-auth-identity:v1
<normalized email>
<organization ID>
```

Only the expected hash belongs in configuration. Run `/pi-claude-code-provider-doctor` after changing an account login; its `report` mode is unavailable for configured instances. Rate-limit notices identify the affected label, and the shared web-search tool uses the first configured instance.

The optional `failover` descriptor registers one additional provider backed by the ordered instances. A structured rate-limit rejection switches later requests to the next available account. The rejected request itself is retried only when it produced no assistant-visible output. Exhaustion remains sticky until Claude's reported reset time; without one, it remains sticky for the Pi process. Other failures never switch accounts, and all pool models advertise the most conservative limits shared by every member. The instance-specific providers remain available for direct selection.

See [Account instance binding](DESIGN.md#account-instance-binding) for the validation, identity handling, environment binding, diagnostics, and recheck guarantees.

## Subscription usage

Provider and web-search requests consume Claude subscription capacity. A cancellation received before Claude is launched starts no Claude request; a request already running can consume capacity before termination. Optional usage credits may incur additional spend after plan limits. The package reports Claude's token counts when available and reports zero monetary cost because it cannot determine how a subscription request was billed.

Anthropic documents [`claude -p` / `--print`](https://code.claude.com/docs/en/cli-reference) as its non-interactive CLI interface, explains that [third-party usage draws from subscription limits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), and documents [subscription authentication and usage credits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan). This project uses that public interface without claiming Anthropic endorsement.

Rate-limit warnings and reset times appear as Pi notifications when Claude provides them, including for web-search requests, and each distinct notice, as displayed, is reported once per session. Utilization is displayed using Claude Code's whole-percent convention. Overage status is reported only when it constrains the request, so a plan with usage credits disabled produces no notification while its own limits are healthy.

## Compatibility limitation

Claude Code's public headless protocol cannot accept arbitrary historical assistant and tool-result messages, so the provider sends Pi's complete current history as an append-stable semantic transcript on every request. Pi remains authoritative for branching, compaction, reloads, and provider handoff; the transport is not wire-equivalent to Anthropic's Messages API, consumes additional context, and sets one cache breakpoint of its own, on the last history block. That breakpoint uses a one-hour TTL, which the API's breakpoint ordering requires and which doubles the cache-write rate over the five-minute default; cache keys remain Claude's.

Images remain available to Claude throughout the current Pi context, including after Claude has replied to them. The provider reuses a private, session-stable image path so later image-bearing turns can reuse a cached prompt prefix. Adding an image or changing the context may still cause a cold write; each request retains the 20-image and byte limits. [DESIGN.md](DESIGN.md#request-and-transcript-transport) explains the transport.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM` | Exact platform/architecture (for example `linux/arm64`) whose startup compatibility advisory you acknowledge and wish to hide. Unset by default. Does not mark the platform verified or hide doctor/report metadata, authentication errors, rate-limit notices, or runtime validation failures. |
| `PI_CLAUDE_CODE_PROVIDER_PATH` | Override the `claude` executable path. |
| `PI_CLAUDE_CODE_PROVIDER_METRICS_LOG` | Append content-free request and search metrics as JSONL. |
| `PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS` | Override the five-minute protocol-idle timeout with positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS` | Override the 30-minute total timeout with positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` | Override the five-second tool-catalog readiness timeout with positive milliseconds. |
| `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT` | `on` (default) or `off`. `off` drops the provider's own prompt-cache breakpoint, which loses prompt caching; use it only when a Claude Code release fails requests for carrying too many cache breakpoints. |

Metrics exclude prompts, messages, queries, output, credentials, stderr, and temporary paths. On POSIX, the log is kept at mode 0600; Windows uses the selected location's ACL.

Claude processes receive only an allowlisted environment. Besides locale, proxy, and path variables, it forwards `CLAUDE_CONFIG_DIR` for a relocated Claude Code configuration and `NODE_EXTRA_CA_CERTS` for a TLS-inspecting proxy's CA bundle.

## Security and troubleshooting

Pi packages run with the user's permissions; review the source before installation and treat model-visible context like any other Claude Code prompt. Main requests suppress unmanaged user and project customizations and local tools, validate capabilities, and remove private request state before success. Claude runs in Pi's session working directory, so it sees the same project Pi's tools act on, and every file or shell action it proposes runs as a visible Pi tool call. Its startup Git status collection is disabled, so a project's configured Git filters do not run when it starts. Administrator-managed Claude Code settings, hooks, and MCP policy are organization-trusted and can take effect before validation; abrupt host termination can still leave state behind. See [DESIGN.md](DESIGN.md) for the security model and [SECURITY.md](SECURITY.md) for vulnerability reporting.

- **Provider missing:** run the doctor, correct the reported problem, then run `/reload`.
- **Authentication rejected:** run `claude auth status` and log in with an eligible first-party subscription. Logins made with `claude setup-token` through `CLAUDE_CODE_OAUTH_TOKEN` are not forwarded to Claude and are unsupported.
- **Compatibility warning:** compare the installed versions with [DEVELOPING.md](DEVELOPING.md#compatibility-baseline). To acknowledge an unverified platform without changing its verification status, launch with e.g. `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM=linux/arm64 pi`. This hides that platform's startup advisory only; unset the variable to restore it. It is not evidence that live validation passed.
- **Search unavailable:** allow `pi_claude_code_provider_web_search` in Pi's tool filters and check for a name collision.
- **`pi auth check` reports `provider_not_found`:** that command does not load extensions, so it cannot see any extension-registered provider. Use `/pi-claude-code-provider-doctor` to check readiness.
- **Tool proposals never arrive, or requests fail with `mcp_startup`:** run `/pi-claude-code-provider-doctor`. It reports the exact bridge argument vector and whether the handshake completed. Raising `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` only helps when the handshake succeeds but is slow.
- **Every request fails naming `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT` or too many `cache_control` blocks:** a Claude Code release added a prompt-cache breakpoint of its own and left no room for the provider's. Restart Pi with `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` to keep working without prompt caching, and report the Claude Code version.
- **A request fails because the system prompt alone exceeds the model's context:** Pi's system prompt carries your project context files and one entry per loaded skill, and compaction never shrinks it. Reduce the loaded context or skills, or select a model with a larger context window. There is no separate size ceiling of the provider's own.
- **A request fails with `working_directory`:** Claude runs in Pi's session working directory, and that directory is not absolute, cannot be read (usually because it no longer exists), is not a directory, or no Pi session has started. The provider never runs Claude somewhere else instead. Restart Pi from an existing directory.
- **An image request fails with `image_path`:** the temporary directory's path contains a double quote, which Claude Code's attachment syntax cannot express. Point `TMPDIR` (or `TEMP` on Windows) at a directory without one.
- **Stale Windows state after an abrupt exit or `process_cleanup` failure:** a cleanup failure deliberately retains its marked directory when Claude process death is uncertain. Stop the relevant Pi and Claude processes, locate the temporary directory (`node -p "require('node:os').tmpdir()"`, or `echo %TEMP%` when Pi is the standalone build and Node is absent), inspect package marker files, and remove only confirmed stale directories.

## Development and license

See [DEVELOPING.md](DEVELOPING.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [DESIGN.md](DESIGN.md). Licensed under MIT.
