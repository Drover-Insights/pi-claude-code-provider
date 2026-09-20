# pi-claude-code-provider

A [Pi](https://pi.dev) package that creates a provider for Claude family models from a subscription-authenticated Claude Code installation by launching Anthropic's installed `claude` executable in documented non-interactive print mode. Pi remains fully in charge of the session: branching, compaction, and history behave like any other Pi provider, and every tool runs visibly in Pi — the Claude process can propose tool calls but never execute anything on its own. The goal is simple: the convenience of your Claude subscription in Pi, with the fewest possible surprises.

This package never imitates private OAuth traffic, does not use the Agents SDK, and does not modify Claude's internal session files. It never reads Claude credentials or uses an Anthropic API key.

This project was developed using frontier AI models under human guidance. Almost all of the docs and code were written by machines except for this introductory material. The project may be over-engineered in some respects; that's fine. If you enjoy this package, please star it on github.

## Requirements

- [Pi](https://pi.dev) 0.86.1 or newer, installed from npm or a standalone build
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

Sonnet, Fable, and Opus expose Pi thinking levels that map to Claude's `low`, `medium`, `high`, `xhigh`, and `max` effort values. Haiku has no effort control here; Claude Code may still use its default extended thinking even when Pi displays thinking as off. Opus uses a 200K context window on Pro and 1M on Max, Team, and Enterprise. The provider retains 200K on Pro even when Claude Code reports a 1M-capable variant, because it cannot determine credit availability.

The `fable` alias is offered and separately testable, but it is excluded from the paid release gate. Fable availability, included allocation, and billing vary by subscription tier. It otherwise follows the standard alias path wherever the account allows it. See Anthropic's [Fable plan policy](https://support.claude.com/en/articles/15424964-claude-fable-5-on-your-plan).

**Model identity:** self-identification is generated text, not routing metadata, and Pi's coding-tool prompt and schemas can make Claude name an older Sonnet even when Claude Code served Opus. Use the assistant message's `responseModel` field in Pi's JSON output for the served model; Pi's status line shows the requested alias.

After installation or an upstream update, run:

```text
/pi-claude-code-provider-doctor
```

It names the concrete model each alias is currently served, alongside the resolved versions, runtime, and bridge handshake, without consuming subscription quota. It also reports the last request's prompt-cache reuse, and names a context window Claude Code has stopped serving as configured.

Run `/pi-claude-code-provider-doctor report` to write a bounded, content-free JSON diagnostic report in a private temporary directory. Inspect the report before sharing it.

The package also registers `pi_claude_code_provider_web_search`, a visible Pi tool that runs Claude with only WebSearch and WebFetch. Searches always run Sonnet at medium effort under a three-minute limit, whichever model Pi is set to, so they draw on Sonnet capacity rather than the selected model's. It is skipped with a warning if another extension already owns that name. Truncated full results are removed at session shutdown.

## Subscription usage

Provider and web-search requests consume Claude subscription capacity. A cancellation received before Claude is launched starts no Claude request; a request already running can consume capacity before termination. Optional usage credits may incur additional spend after plan limits. The package reports Claude's token counts when available and reports zero monetary cost because it cannot determine how a subscription request was billed.

Anthropic documents [`claude -p` / `--print`](https://code.claude.com/docs/en/cli-reference) as its non-interactive CLI interface, explains that [third-party usage draws from subscription limits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), and documents [subscription authentication and usage credits](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan). This project uses that public interface without claiming Anthropic endorsement.

Rate-limit warnings and reset times appear as Pi notifications when Claude provides them, including for web-search requests, and each distinct notice, as displayed, is reported once per session. Utilization is displayed using Claude Code's whole-percent convention. Overage status is reported only when it constrains the request, so a plan with usage credits disabled produces no notification while its own limits are healthy.

## Compatibility limitation

Claude Code's public headless protocol cannot accept arbitrary historical assistant and tool-result messages, so the provider sends Pi's complete current history as an append-stable semantic transcript on every request. Pi remains authoritative for branching, compaction, reloads, and provider handoff; the transport is not wire-equivalent to Anthropic's Messages API, consumes additional context, and sets one cache breakpoint of its own, on the last history block. Cache keys remain Claude's; [DESIGN.md](DESIGN.md#compatibility-and-performance) explains the breakpoint's TTL and cost.

Pi hands a provider a normalized transcript, with the system prompt and tool declarations carried by its system messages. The provider uses Pi's own replay helpers to recover the current prompt and active tools, including later section and tool changes, before sending the request to Claude Code. See the [compatibility baseline](DEVELOPING.md#compatibility-baseline) for the versions each release gate has validated.

Images remain available to Claude throughout the current Pi context, including after Claude has replied to them. The provider reuses a private, session-stable image path so later image-bearing turns can reuse a cached prompt prefix. Adding an image or changing the context may still cause a cold write; each request retains the 20-image and byte limits. [DESIGN.md](DESIGN.md#request-and-transcript-transport) explains the transport.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM` | Exact platform/architecture (for example `linux/arm64`) whose startup compatibility advisory you acknowledge and wish to hide. Unset by default. Does not mark the platform verified or hide doctor/report metadata, authentication errors, rate-limit notices, or runtime validation failures. |
| `PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY` | `off` (default) or `on`. `on` lets a tool-bearing request with no registered session or recognized cwd declaration borrow the sole registered session's cwd. This may be the wrong directory for a side Agent; it cannot help when several sessions are registered. |
| `PI_CLAUDE_CODE_PROVIDER_PATH` | Override the `claude` executable path. |
| `PI_CLAUDE_CODE_PROVIDER_METRICS_LOG` | Append content-free request and search metrics as JSONL. |
| `PI_CLAUDE_CODE_PROVIDER_IDLE_TIMEOUT_MS` | Override the five-minute protocol-idle timeout with a positive integer up to 2,147,483,647 milliseconds, capped by the effective total timeout. Provider requests only. |
| `PI_CLAUDE_CODE_PROVIDER_TOTAL_TIMEOUT_MS` | Override the 30-minute total timeout with a positive integer up to 2,147,483,647 milliseconds. Provider requests only; web search keeps its own three-minute limit. |
| `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` | Override the five-second tool-catalog readiness timeout with a positive integer up to 2,147,483,647 milliseconds, capped by the effective total timeout. |
| `PI_CLAUDE_CODE_PROVIDER_THINKING_DISPLAY` | `summarized` (default), `omitted`, or `off`. `omitted` hides thinking text, which reaches the first reply text sooner and keeps later requests smaller. `off` sends no display request at all; use it only if a Claude Code release rejects the option. |
| `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT` | `on` (default) or `off`. `off` drops the provider's own prompt-cache breakpoint, which loses prompt caching; use it only when a Claude Code release fails requests for carrying too many cache breakpoints. |

Metrics exclude prompts, messages, queries, output, credentials, stderr, and temporary paths. On POSIX, the log is kept at mode 0600; Windows uses the selected location's ACL.

Claude processes receive only an allowlisted environment. Besides locale, proxy, and path variables, it forwards `CLAUDE_CONFIG_DIR` for a relocated Claude Code configuration and `NODE_EXTRA_CA_CERTS` for a TLS-inspecting proxy's CA bundle.

## Security and troubleshooting

Pi packages run with the user's permissions; review the source before installation and treat model-visible context like any other Claude Code prompt. Main requests suppress unmanaged user and project customizations and local tools, validate capabilities, and remove private request state before success. Claude runs in Pi's session working directory, so it sees the same project Pi's tools act on, and every file or shell action it proposes runs as a visible Pi tool call. Claude Code performs some startup reads in that directory; [DESIGN.md](DESIGN.md#what-claude-code-adds-on-its-own) records the observed behavior. Administrator-managed Claude Code settings, hooks, and MCP policy are organization-trusted and can take effect before validation; abrupt host termination can still leave state behind. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

For side requests whose session ID this extension did not register, the provider trusts a cwd declaration in the original system prompt. This is a cooperative convention, not authenticated metadata: a caller-controlled prompt can select an existing directory. A tool-bearing direct Agent without a recognized declaration fails by default, even when only one provider session is registered. Pi's provider callback has no per-request cwd field.

- **Provider missing:** run the doctor, correct the reported problem, then run `/reload`.
- **Authentication rejected:** run `claude auth status` and log in with an eligible first-party subscription. Logins made with `claude setup-token` through `CLAUDE_CODE_OAUTH_TOKEN` are not forwarded to Claude and are unsupported.
- **Compatibility warning:** compare the installed versions with [DEVELOPING.md](DEVELOPING.md#compatibility-baseline). To acknowledge an unverified platform without changing its verification status, launch with e.g. `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM=linux/arm64 pi`. This hides that platform's startup advisory only; unset the variable to restore it. It is not evidence that live validation passed.
- **Search unavailable:** allow `pi_claude_code_provider_web_search` in Pi's tool filters and check for a name collision.
- **`pi auth check` reports `provider_not_found`:** that command does not load extensions, so it cannot see any extension-registered provider. Use `/pi-claude-code-provider-doctor` to check readiness.
- **Tool proposals never arrive, or requests fail with `mcp_startup`:** run `/pi-claude-code-provider-doctor`. It reports the exact bridge argument vector and whether the handshake completed. Raising `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` only helps when the handshake succeeds but is slow.
- **Every request fails naming `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT` or too many `cache_control` blocks:** a Claude Code release added a prompt-cache breakpoint of its own and left no room for the provider's. Restart Pi with `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` to keep working without prompt caching, and report the Claude Code version.
- **A turn fails with a mid-response interruption:** Claude Code's API stream was interrupted after the response started. The provider stops and reports it so Pi's own retry can re-run the turn from the same context, which is a prompt-cache hit; the retry is governed by Pi's `retry` settings rather than by this package. A cause that repeating cannot clear, such as a billing error, is reported without a retry.
- **A response ends early with a `length` stop:** it reached the output limit. The text produced up to that point is kept.
- **Every tool round trip is slow in a very large repository:** Claude Code counts the project's files each time it starts, and this provider starts a Claude process per tool round trip. The cost scales with the repository and no option here removes it. See [DESIGN.md](DESIGN.md#what-claude-code-adds-on-its-own).
- **Another extension fails with `No API provider registered for api: pi-claude-code-provider-headless`, or Pi exits when one runs:** an extension running its own agent loop on a provider model reaches Pi-AI's API registry rather than Pi's model runtime. The provider now serves both, so update to this version; the caller still runs its own tools and must identify its cwd for a tool-bearing request.
- **A request fails because the system prompt alone exceeds the model's context:** Pi's system prompt carries your project context files and one entry per loaded skill, and compaction never shrinks it. Reduce the loaded context or skills, or select a model with a larger context window. There is no separate size ceiling of the provider's own.
- **A request fails with `working_directory`:** No Pi session has started; the selected cwd is unusable; or a tool-bearing request has no registered session and no recognized cwd declaration. The provider refuses that last case even with one registered session. The caller should declare its cwd in the system prompt, either as a `<cwd>` section, which is what Pi itself renders, or as a trailing `Current working directory: <absolute path>` line. `PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY=on` restores the older sole-session borrow if you accept that it may run Claude in the wrong tree. A registered session whose prompt names another cwd is also refused.
- **An image request fails with `image_path`:** the temporary directory's path contains a double quote, which Claude Code's attachment syntax cannot express. Point `TMPDIR` (or `TEMP` on Windows) at a directory without one.
- **Stale Windows state after an abrupt exit or `process_cleanup` failure:** a cleanup failure deliberately retains its marked directory when Claude process death is uncertain. Stop the relevant Pi and Claude processes, locate the temporary directory (`node -p "require('node:os').tmpdir()"`, or `echo %TEMP%` when Pi is the standalone build and Node is absent), inspect package marker files, and remove only confirmed stale directories.

## Development and license

See [DEVELOPING.md](DEVELOPING.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [DESIGN.md](DESIGN.md). Licensed under MIT.
