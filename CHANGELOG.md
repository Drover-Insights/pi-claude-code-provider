# Changelog

## [Unreleased]

### Fixed

- On Claude Code 2.1.268 and later, Claude no longer proposes Pi tool calls into the provider's private request directory. Those builds tell the model that their own process directory is its primary working directory, and the provider started Claude in a per-request temporary directory, contradicting the working directory in Pi's system prompt. The model then wrote files there, which the provider rejects as a private-transport violation, and could describe a git project as not being a repository. In a project path resembling the private directory, 10 of 11 requests failed before and 0 of 11 after.

- Restore prompt-cache reuse broken by Claude Code 2.1.268, which moved the final `cache_control` marker off the replayed transcript and onto content it appends after it, so every turn rewrote the whole history instead of reading it back. No flag or setting restores it. The transport now marks the last history block itself, measured at 97.1% and 96.8% reuse on turns 2 and 3 against 0.0% before. Earlier builds normalize the marker away, so the verified baseline is unaffected. Sonnet, Opus and Fable recover. Haiku 4.5, which receives that content ahead of the transcript, recovers once the content stops varying between requests, because Claude now runs in Pi's session directory: 99.2% and 99.0% on turns 2 and 3.

- Removed the fixed 120 KiB system prompt ceiling, which refused an ordinary Pi session before Claude was launched and could not be cleared by changing the model or thinking level. Claude Code documents no size limit for `--system-prompt-file`, and the prompt has always reached it by path rather than through the argument vector the flag exists to avoid. A system prompt is now bounded only by the served model's context window, checked before any private request state is created and reported without context-overflow wording, because compaction cannot shrink a system prompt ([#4](https://github.com/chem/pi-claude-code-provider/issues/4)).

- Pi tools whose names contain characters other than letters, digits, `_`, and `-`, such as `.`, no longer fail every request with `isolation_tools`. Claude Code replaces those characters when it names an MCP tool, so such names now receive a digest alias instead of being preserved.

- Streaming a large tool call no longer re-parses its whole argument string on every delta, which cost time quadratic in the argument size and could stall Pi while a large `write` arrived. Partial arguments are previewed with Pi's streaming JSON parser at geometrically spaced points, and previews now show partial values instead of staying empty until the call completes.

- A rate-limit warning is reported once per session per displayed text. Utilization changes by fractions between events while the notice shows whole percent, so identical-looking warnings previously repeated on every tool round trip.

- Web search no longer requests partial messages it discards, which counted toward its 2 MiB capture limit.

- Error messages carry at most a 1,000-character tail of Claude Code's stderr with the private request directory replaced, instead of up to 64 KiB of raw stderr. For web search that message reaches the model as a tool result.

### Added

- `npm run capture:claude-breakpoints` reports where Claude Code places prompt-cache breakpoints in the request this provider builds, using the provider's own arguments against a loopback server. It spends no quota, takes two captures so a per-request varying prefix is visible at all, and exits non-zero unless the shape can actually be reused.
- `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` drops the provider's own prompt-cache breakpoint. Every Claude 5 alias already carries the API's maximum of four, so a Claude Code release that adds one would fail every request; the provider now recognizes that rejection, names the setting in the error, and records `cache_breakpoint_limit`.
- Claude processes receive `CLAUDE_CONFIG_DIR` and `NODE_EXTRA_CA_CERTS` when set, so a relocated Claude Code configuration and a TLS-inspecting proxy's CA bundle work. Logins through `CLAUDE_CODE_OAUTH_TOKEN` remain unsupported.

### Changed

- Claude runs in Pi's session working directory instead of the private request directory. The directory comes from the Pi session, not Pi's process directory, and the system prompt, tool catalog, image attachments and markers stay in the private directory. A request fails with `working_directory`, before anything is launched, when that directory is missing or is not a directory, or when no Pi session has started. The provider never substitutes another directory. Web search keeps its private directory.
- Claude processes receive `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`. It stops the git status and log collection Claude Code performs at startup for a system prompt this provider replaces; in a project, that status could execute a configured Git clean filter before any Pi tool call. What reaches the model is unchanged.
- Image attachments are referenced by quoted absolute path. A temporary directory whose path contains a double quote cannot be referenced that way, so an image request made from one fails with `image_path`.
- The paid release gate adds `npm run test:paid:cache-haiku`. Both cache stages also require each reuse turn to write less than a quarter of turn 1's cache write.
- The verified Claude Code baseline advances to 2.1.270; the minimum supported version stays 2.1.261.
- `npm run capture:claude-breakpoints` runs Claude in a disposable git project. It reports BROKEN on startup side effects, on a working directory other than the project, and on private paths reaching the model outside attachment narration.
- A model must now report a usable context window. A missing or non-positive `contextWindow` previously skipped the context-budget check silently, leaving the request unbounded; it now fails with `context_window`. Pi validates this when a custom model is defined but not when a per-model override sets it, so an override is the reachable cause and the message says so. Fractional values are accepted, since the window is only compared.
- Malformed messages, content blocks, and tools in a request context now fail with transcript preparation's `content_shape`, `content_type`, or image error categories instead of `payload_invalid`, which remains for a payload with an invalid top-level shape. Two layers previously checked the same rules. A non-boolean thinking `redacted` flag or a non-string image `mimeType` still fails, now with `content_shape`.
- Web-search rate-limit rejections now include the overage-disabled reason, matching provider requests.
- An image is attached to a request only until Claude has replied to it: images from the latest user message onward, and from any messages sent since the preceding assistant reply, are attached. Any attachment makes a request uncached, so an image anywhere in history previously disabled prompt caching for the rest of the branch. Answered images keep their transcript records but are no longer shown to Claude, and no longer count toward the per-request image limits. The context protocol is now `pi-claude-code-provider-context-v4`, so the first request after upgrading does not reuse an earlier cache entry.
- `/pi-claude-code-provider-doctor` prints one labeled fact per line.

## [0.2.0] - 2026-09-05

### Removed

- **Breaking.** Removed the `default` model alias. It sent no `--model` flag, so the served model was chosen by Claude Code account state that varies between accounts — observed as Sonnet on one and Opus on another — and never reflected the model selected in the user's own Claude Code settings, which this provider does not load. Pi reports an unknown model for a saved `pi --model pi-claude-code-provider/default` or profile entry.

### Added

- `/pi-claude-code-provider-doctor` and the diagnostic report name the model each alias resolves to, without consuming subscription quota. Values that cannot be read report `unavailable` and never affect model selection.
- Minimum supported Pi and Claude Code versions in `README.md`, reported by the doctor. They are advisory: an older installation is not blocked and may still run.
- `PI_CLAUDE_CODE_PROVIDER_ACKNOWLEDGED_PLATFORM` suppresses one named platform's startup advisory without changing its verification status ([#3](https://github.com/chem/pi-claude-code-provider/pull/3)).
- `npm run capture:claude-surface`, which captures `claude --help` verbatim for the capability tests.

### Changed

- The verified baseline advances to Pi 0.85.1 and Claude Code 2.1.261, and CI installs the Pi version the baseline names.
- macOS is recognized as verified on both architectures, with community-reported live coverage recorded in `DEVELOPING.md` ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)). It no longer raises a startup platform advisory.
- The paid model matrix asserts model families instead of dated model ids, so upstream model refreshes no longer fail it.
- `DESIGN.md` records what Claude Code adds to the model's view that this package cannot remove, the effect of dropping the user's Claude Code setting sources, and why the prompt-cache setting is pinned.

### Fixed

- Preflight no longer decides whether the provider can run by scraping `claude --help` for `--system-prompt-file`, which is documented but absent from the help screen. A minimum supported version covers it instead.
- npm Pi installations whose CLI lives in `dist/bundle/cli.js` resolve by locating the owning package rather than assuming its depth ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)).
- Paid validation is isolated from personal Pi settings, extensions, skills, and context files without moving user files ([#2](https://github.com/chem/pi-claude-code-provider/pull/2)).

## [0.1.4] - 2026-08-23

### Fixed

- Restore prompt-cache reuse broken by Claude Code 2.1.233's undocumented, changing token reminder. The provider now applies the maintainer-recommended `totalTokensReminder: "off"` setting; the cache gate verifies reuse across fresh processes.
- Honor Pi's per-request output limit, including compact 2,048-token branch-summary requests, while clamping it to the model maximum and reserving the same amount in context checks.
- Fail clearly on sanitized MCP initialization errors, malformed provider-hook payloads, near-match CLI options, oversized in-flight bridge requests, and process-tree termination failures. Cleanup errors now preserve the original failure, settle promptly, and retain the owned marker when process liveness is unknown.

### Changed

- Simplify transport guidance and child configuration, report bridge launches as structured argument vectors, and share Claude protocol/runtime helpers across provider, search, diagnostics, and tests.
- Update the verified baseline to Pi 0.84.2 and Claude Code 2.1.241.

## [0.1.3] - 2026-08-20

### Fixed

- Launch the proposal bridge through Pi's actual host runtime. Standalone Pi builds now use their embedded Bun runtime with a neutral pinned `bunfig.toml`, fixing tool proposals and preventing working-directory preload configuration.

### Added

- Add a real bridge handshake to the doctor and diagnostic report.
- Add npm and standalone bridge live gates, selectable with `PI_CLAUDE_CODE_PROVIDER_PI_BIN`.

### Changed

- Include dates in rate-limit reset notices.
- Add resolved bridge and bounded stderr context to MCP startup failures.
- Diagnose standalone Pi as a supported runtime but unsupported development host.
- Verify Pi 0.84.2, Claude Code 2.1.237, and standalone Pi on Linux x64.

## [0.1.2] - 2026-08-09

### Fixed

- Report a rate limit only when one constrains the request. A rejected overage no longer overrides a healthy plan window, so a subscription with usage credits disabled at the account level no longer warns on every request, and the reported window name and utilization are preserved.
- Report each distinct rate-limit notice once per session rather than once per Claude process, which this transport starts for every tool round-trip.

## [0.1.1] - 2026-08-08

### Added

- Add `PI_CLAUDE_CODE_PROVIDER_MCP_READY_TIMEOUT_MS` to override the five-second MCP tool-catalog readiness timeout.

### Changed

- Verify the existing `opus` alias resolves to Claude Opus 5, retain its safe 200K Pro context limit, and update the verified baseline to Pi 0.84.1 and Claude Code 2.1.226.
- Improve provider and web-search rate-limit notifications with whole-percent utilization, reset times, and overage status.
- Align with Pi's provider lifecycle: stream partial responses as `pending` and invoke and await `after_provider_response` observers before publishing content.

### Fixed

- Improve web-search cancellation and cleanup: do not launch Claude for a pre-cancelled request, and recover stale private output left by abrupt exits.
- Tolerate newer Claude Code result, stop-reason, and advisory rate-limit envelopes while preserving useful error diagnostics.

## [0.1.0] - 2026-07-19

Initial public release.
