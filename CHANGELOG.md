# Changelog

## [Unreleased]

### Changed

- **Breaking.** Pi 0.86.1 is now the minimum supported version, raised from 0.85.1, because Pi 0.86 changed the shape it hands custom providers: the system prompt and tool declarations moved into transcript system messages. Upgrade Pi before upgrading this package. The floor is advisory rather than enforced -- installing and running on an older Pi is not blocked, and `/pi-claude-code-provider-doctor` reports when your Pi falls below it -- but requests on Pi 0.85.1 are no longer supported or tested.
- The validated baseline is now Claude Code 2.1.278; `/pi-claude-code-provider-doctor` reports a matching install as verified rather than untested. The minimum supported version is unchanged at 2.1.270.
- In the optional metrics log, `imageCount` now counts image content blocks rather than the files written for them, so it matches the number an "At most 20 images" rejection actually counted. Identical images are still stored and sent once. The log's schema version is now 5.

### Added


- `PI_CLAUDE_CODE_PROVIDER_BORROW_SOLE_DIRECTORY=on` explicitly restores sole-session cwd borrowing for tool-bearing side requests that provide no recognized cwd. It can run Claude in another Agent's directory and is off by default.
- The doctor reports whether the last request used a registered session, a Pi prompt declaration, a tool-free summary borrow, or the explicit sole-session compatibility borrow.
- `/pi-claude-code-provider-doctor` reports how much of the last request Claude reused from its prompt cache, and says so plainly when an established conversation reused almost nothing. Losing cache reuse is otherwise silent: turns simply get slower and cost more. One low reading is not a diagnosis, and the doctor says that too.
- `/pi-claude-code-provider-doctor` names a model whose context window Claude Code has stopped serving at the size this package advertises. The size checks that reject an over-large request before it is sent use the advertised value, so a quieter window would let a request through that the API then refuses mid-answer.

### Fixed


- Requests now recover the current prompt and active tools from Pi's transcript system messages, including section edits and tool additions/removals. Tool-call argument types also match Pi's new JSON-compatible contract.
- Tool-bearing requests with no registered session or recognized cwd declaration now fail with `working_directory` instead of silently borrowing the only registered session's cwd. This prevents a pi-subagents child watchdog in another worktree from running Claude in the parent checkout; its separate review remains unavailable until pi-subagents passes a recognized cwd, or the operator explicitly enables compatibility borrowing. Ordinary child turns retain Pi's generated cwd route.
- A tool-free request that gains tools in `before_provider_request` is refused before launch regardless of session count, including requests using Pi's transcript system messages.
- Session-backed image requests reject a quoted temporary path before creating or writing the image store; correcting the temporary root lets the same session attach images.
- The doctor bridge probe requires a clean child exit and reports termination failures while retaining marked state when liveness is unknown.
- Provider timeout settings above Node's maximum timer delay now fail before launch instead of silently becoming approximately 1 ms.
- Failed process-tree cleanup now retains private request state and session images even when the Claude leader has already exited. POSIX stale recovery also checks the remaining process group before reclaiming that state.
- Stale image recovery now inspects all package directories and limits deletion attempts separately, so more than 256 leftover image stores no longer prevent recovery from making progress.
- Quitting Pi while a turn is running no longer waits for that turn to finish. Pi asks its extensions to shut down before it stops the turn, and waits for them, so this package's image-store cleanup was waiting for a request nothing had yet cancelled: `/quit`, Ctrl+D and a terminated Pi all hung until Claude finished answering or the request timed out. Shutdown now leaves the session's image directory to the request still writing to it, and that request removes it when it finishes.
- Starting a session no longer reports an extension error in Pi's RPC mode. Pi loads extensions twice for a new, resumed, forked or cloned session there, and the second pass hit this package's own check that a session had closed before the next one opened. Nothing was lost — the first pass had already registered the session — but the error was reported on every one of those transitions.
- A reply that reached the output limit is no longer discarded when Claude Code finishes and exits on its own first. It ended the turn with "output limit handoff exited unexpectedly" in that case, throwing away a complete answer you had already paid for.
- Another extension running its own agent loop on a provider model no longer exits Pi. Those calls, and `completeSimple`, resolve the model through Pi-AI's API registry, which this provider did not serve, and Pi does not catch the resulting failure. They now reach the same provider and cwd routing rules; the calling extension still runs any tool itself. Pi-AI describes the entrypoint carrying that registry as temporary, so a Pi release that removes it costs only these side requests rather than the whole provider.
- A Pi session ending no longer fails a request that was already running elsewhere. With several sessions in one process, a request placed on a session's image store could fail with `image_path` when that session exited while the request was still being prepared — even when the request carried no images.
- Requests from parallel Pi sessions now each run in their own working directory. With more than one session in a process — most visibly another extension running its own agent loop — requests could run Claude in another session's project while Pi's own tools worked in theirs, and a session outliving the one that registered the provider stopped working altogether. Each session's image store and rate-limit notices are now its own too. A caller with a Pi cwd declaration runs in that directory; markerless tool-bearing requests now fail by default as described above.
- Thinking is visible again. Claude 5, Opus, and Haiku returned thinking blocks with no text in them, so a turn spent reasoning tokens Pi could not show; the provider now asks for summarized thinking. `PI_CLAUDE_CODE_PROVIDER_THINKING_DISPLAY=omitted` hides thinking text again, which reaches the first reply text sooner and keeps later requests smaller.
- Compaction, branch summaries, and turn-prefix summaries no longer pay for a prompt-cache entry nothing reads. Pi asks the provider not to cache these one-shots; the provider ignored that and wrote a one-hour entry for the whole summarized conversation, at twice the usual cache-write rate.
- A turn interrupted mid-response is retried instead of lost. When Claude Code's API stream failed after the response had started, the request failed with `Claude emitted duplicate message_start` or `Claude result arrived with unclosed content blocks`, which Pi could not recognize as retryable. The provider now stops Claude and reports the interruption in wording Pi's `retry` settings act on, so Pi re-runs the turn from the same context; the replay is a prompt-cache hit, so only the reply is produced twice. A cause that repeating cannot clear, such as a billing error, is still reported without a retry.
- A response that reaches the output limit now ends with a `length` stop and keeps its text. It previously failed the same way, because Claude Code answers the limit with a continuation turn of its own.
- An API error that arrives with an unfinished content block reports the API error instead of `Claude result arrived with unclosed content blocks`, which hid it.
- A connection dropped inside a tool call's streamed arguments is reported as the interruption it is, rather than as invalid tool arguments, so it is retried too.

## [0.3.0] - 2026-09-13

### Added

- `PI_CLAUDE_CODE_PROVIDER_TRANSCRIPT_BREAKPOINT=off` turns off the provider's prompt-cache marker. It is an escape hatch in case a future Claude Code release rejects requests for carrying too many cache markers; that error names this setting.
- `CLAUDE_CONFIG_DIR` and `NODE_EXTRA_CA_CERTS` are passed to Claude when set, so a relocated Claude Code configuration and TLS-inspecting proxies work. Logins through `CLAUDE_CODE_OAUTH_TOKEN` remain unsupported.
- For development: `PI_CLAUDE_CODE_PROVIDER_DEV_PI` selects the npm-installed Pi that checks and tests use, `npm run capture:claude-breakpoints` inspects prompt-cache markers without using quota, and the paid release gate adds Haiku and image-cache stages.

### Changed

- Claude now starts in Pi's session working directory, the project Pi's tools work in, instead of a private temporary directory. Private request files stay separate, and `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1` stops Claude Code's startup Git status collection, so a project's Git filters don't run. If that directory is deleted while Pi is running, requests fail with `working_directory`; restart Pi from an existing directory.
- Conversations with images now reuse Claude's prompt cache, because each image keeps the same private path for the whole Pi session. The 20-image and size limits are unchanged.
- The first request after upgrading builds a fresh prompt cache, because the transcript format is now `pi-claude-code-provider-context-v4`.
- The minimum supported Claude Code version is now 2.1.270. Older versions still run, and `/pi-claude-code-provider-doctor` flags them.
- `/pi-claude-code-provider-doctor` prints one fact per line.
- Pi's startup `[Extensions]` list shows `pi-claude-code-provider` instead of `pi-claude-code-provider:pi-claude-code-provider.ts`.
- The package summary on npm and pi.dev now reads: "The convenience of your Claude subscription in Pi, with the fewest possible surprises. Uses Claude Code's CLI under the hood."
- Web-search rate-limit errors include the overage-disabled reason, as provider requests already did.
- A Pi `modelOverrides` entry with a missing or non-positive `contextWindow` now fails with `context_window` instead of skipping the context check. The provider's own models are unaffected.
- Invalid request content, for example from another extension's payload hook, reports `content_shape`, `content_type`, or an image error category instead of `payload_invalid`.
- An image request fails with `image_path` if the temporary directory's path contains a double quote; point `TMPDIR` (or `TEMP` on Windows) at another directory.

### Fixed

- On Claude Code 2.1.268 and later, Claude no longer proposes tool calls into the provider's private directory, which made those calls fail.
- Prompt caching works again on Claude Code 2.1.268 and later: later turns reuse about 97–99% of the conversation instead of rewriting it.
- Large system prompts, for example from many skills or context files, are no longer refused by a fixed 120 KiB limit; only the model's context window applies ([#4](https://github.com/chem/pi-claude-code-provider/issues/4)).
- Pi tools whose names contain characters such as `.` no longer make every request fail with `isolation_tools`.
- Pi no longer stalls while a large tool call, such as a big `write`, streams in, and the call preview fills in as it arrives.
- A rate-limit warning that looks the same is shown once per session instead of on every tool round trip.
- Error messages include a short, path-redacted excerpt of Claude Code's error output instead of up to 64 KiB of it.
- Web search no longer counts discarded partial messages against its 2 MiB output limit.

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
