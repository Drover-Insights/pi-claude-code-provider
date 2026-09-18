import type { RateLimitNoticeSink } from "./claude-protocol.ts";
import type { SessionImageStore } from "./session-image-store.ts";

/** The per-session state a request needs, owned by the instance that started that session. */
export interface SessionEntry {
  cwd: string;
  imageStore: SessionImageStore;
  onRateLimitNotice: RateLimitNoticeSink;
}

/** Where the working directory came from, recorded in metrics. */
export type SessionResolution = "registered" | "prompt" | "single" | "oneshot";

export interface ResolvedSession extends SessionEntry {
  resolution: SessionResolution;
}

export interface SessionRequest {
  sessionId?: string;
  systemPrompt?: string;
  hasTools: boolean;
}

// Process-global rather than module-scoped: a background subagent runner resets
// the extension cache for each child, so every child re-imports this module and
// re-runs the extension factory while the other children stay live.
const REGISTRY_KEY = Symbol.for("pi-claude-code-provider.sessions.v1");

export function sessionRegistry(): Map<string, SessionEntry> {
  const host = globalThis as Record<symbol, unknown>;
  const existing = host[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Map<string, SessionEntry>;
  const registry = new Map<string, SessionEntry>();
  host[REGISTRY_KEY] = registry;
  return registry;
}

/**
 * The working directory Pi states for this request, or undefined when its prompt
 * names none. Best effort by construction: Pi renders it as a trailing
 * `Current working directory:` line up to 0.85.1 and as a `<cwd>` section after
 * that, and an extension that forces the system prompt suppresses it entirely.
 *
 * Both readings take Pi's *last* statement, and that is load-bearing rather than
 * incidental. Pi renders project context -- the repository's own instruction
 * files, which this provider does not author -- ahead of the directory in both
 * renderings, so matching the last section and anchoring the 0.85.1 line to the
 * end of the prompt is what keeps a repository from naming the directory Claude
 * runs in. Preferring an earlier match would hand that choice to project files:
 * directly for a request whose session is unknown, where this is the only source
 * of truth, and as a refusal for one whose session is known, where a disagreeing
 * prompt fails the request.
 */
export function promptWorkingDirectory(systemPrompt: string | undefined): string | undefined {
  if (!systemPrompt) return undefined;
  const sections = [...systemPrompt.matchAll(/<cwd>\r?\n([^\n]+)\r?\n<\/cwd>/g)];
  const stated = sections.at(-1)?.[1] ?? /\r?\nCurrent working directory: ([^\n]+)\s*$/.exec(systemPrompt)?.[1];
  return stated?.trim() || undefined;
}

/**
 * Resolve the session a request belongs to, never silently substituting another
 * session's directory. `undefined` means no session is live at all, which the
 * caller reports as Pi's own "not started" failure.
 */
export function resolveSession(
  registry: ReadonlyMap<string, SessionEntry>,
  request: SessionRequest,
): ResolvedSession | { error: string } | undefined {
  const stated = promptWorkingDirectory(request.systemPrompt);
  const registered = request.sessionId === undefined ? undefined : registry.get(request.sessionId);
  if (registered) {
    if (stated !== undefined && !sameDirectory(stated, registered.cwd)) {
      return {
        error: `Pi's system prompt names ${stated} as the working directory but this request's session runs in ${registered.cwd}; refusing to run Claude in another session's directory`,
      };
    }
    return { ...registered, resolution: "registered" };
  }
  const live = [...registry.values()];
  if (live.length === 0) return undefined;
  if (stated !== undefined) {
    // A session this instance never started, reached through a provider another
    // session registered: a Pi subagent child with its own directory or
    // worktree. Pi states where the request belongs, so run there rather than in
    // the inherited session's tree, which the child's own tools never touch.
    // The rest of the session state is borrowed, preferring a live session
    // already in that directory; both are private temporary state.
    const host = live.findLast((entry) => sameDirectory(entry.cwd, stated)) ?? live[live.length - 1];
    return { ...host, cwd: stated, resolution: "prompt" };
  }
  if (live.length === 1) return { ...live[0], resolution: "single" };
  // Pi's compaction and branch summaries arrive with a freshly generated session
  // id and no tools. Nothing can be misdirected without a tool to propose, and
  // their prompt carries no directory, so the newest live session hosts them
  // rather than failing /compact whenever several sessions share a process.
  if (!request.hasTools) return { ...live[live.length - 1], resolution: "oneshot" };
  return {
    error: `this request's Pi session (${request.sessionId ?? "no session id"}) was never started through this provider and ${live.length} sessions are live, so its working directory is unknown`,
  };
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (path: string) => {
    const separated = path.replace(/\\/g, "/").replace(/\/+$/, "");
    // Pi renders the directory with forward slashes on every platform, so the
    // comparison is separator-insensitive; Windows paths are also case-folded.
    return process.platform === "win32" ? separated.toLowerCase() : separated;
  };
  return normalize(left) === normalize(right);
}
