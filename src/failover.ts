import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createOutput } from "./output.ts";
import { createClaudeStream, type ClaudeStreamDependencies } from "./provider.ts";
import type { RateLimitNotice } from "./claude-protocol.ts";
import type { ClaudeInstallation } from "./types.ts";

export interface ClaudeFailoverMember {
  readonly providerId: string;
  readonly label: string;
  readonly installation: ClaudeInstallation;
}

/**
 * Why an account was unavailable to a request that ended with every account unavailable. `rejected` means it
 * was contacted during this request; `benched` and `recovering` mean it was skipped without contact. Only the
 * opaque label appears: no identity, root, prompt or response content.
 */
export type FailoverExhaustionOutcome =
  | { readonly label: string; readonly outcome: "rejected" | "benched"; readonly reset: "known" | "unknown"; readonly until: number }
  | { readonly label: string; readonly outcome: "recovering" };

export interface ClaudeFailoverDependencies extends Omit<ClaudeStreamDependencies, "onRateLimitNotice" | "onRateLimitRejection"> {
  readonly onRateLimitNotice?: (providerId: string, notice: RateLimitNotice) => void;
  /** Called once for each request that ends because no account was available. */
  readonly onExhausted?: (outcomes: readonly FailoverExhaustionOutcome[]) => void;
  readonly now?: () => number;
}

const UNKNOWN_RESET_BASE_MS = 15 * 60_000;
const UNKNOWN_RESET_CAP_MS = 5 * 60 * 60_000;

/** The bench after the `streak`-th consecutive rejection without a usable reset: 15 minutes, doubling, at most 5 hours. */
export function unknownResetBenchMs(streak: number): number {
  return Math.min(UNKNOWN_RESET_BASE_MS * 2 ** Math.max(0, streak - 1), UNKNOWN_RESET_CAP_MS);
}

export function formatFailoverExhaustion(outcomes: readonly FailoverExhaustionOutcome[]): string {
  return `Claude accounts unavailable: ${outcomes.map((entry) => {
    if (entry.outcome === "recovering") return `${entry.label} skipped, a recovery attempt is in flight`;
    const reset = entry.reset === "known" ? "reported reset" : "reset unknown";
    const state = entry.outcome === "rejected" ? "rejected now" : "skipped";
    return `${entry.label} ${state}, benched until ${new Date(entry.until).toISOString()} (${reset})`;
  }).join("; ")}`;
}

interface MemberState {
  /** No request contacts the account before this instant. */
  benchedUntil?: number;
  /** Whether benchedUntil is Claude's reported reset rather than a resetless bench. */
  resetKnown: boolean;
  /** Rejections without a usable reset since the account's last confirmed success. */
  unknownStreak: number;
  /** A request is contacting the account after its bench expired. */
  recovering: boolean;
}

export function createClaudeFailoverStream(
  members: readonly ClaudeFailoverMember[],
  dependencies: ClaudeFailoverDependencies = {},
) {
  // Process-local and per closure: the single-flight bound and the benches cover only requests served by this
  // closure. Whether Pi can have two closures for one account in a process (for example across a reload) is not
  // established here; a new closure starts with no benches.
  const states = new Map<string, MemberState>();
  const now = dependencies.now ?? Date.now;
  const stateFor = (providerId: string): MemberState => {
    let state = states.get(providerId);
    if (!state) states.set(providerId, state = { resetKnown: false, unknownStreak: 0, recovering: false });
    return state;
  };

  return (model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const outer = createAssistantMessageEventStream();
    // Read once when Pi starts the request, so a session switch between attempts
    // cannot move a retry to another directory.
    const requestCwd = dependencies.workingDirectory?.();
    void (async () => {
      let payloadCalled = false;
      let payloadReplacement: unknown;
      let responseCalled = false;
      let responsePromise: Promise<void> | undefined;
      const attemptOptions: SimpleStreamOptions | undefined = options === undefined ? undefined : {
        ...options,
        onPayload: options.onPayload === undefined ? undefined : async (payload, hookModel) => {
          if (!payloadCalled) {
            payloadCalled = true;
            payloadReplacement = await options.onPayload?.(payload, hookModel);
          }
          return payloadReplacement;
        },
        onResponse: options.onResponse === undefined ? undefined : async (response, hookModel) => {
          if (!responseCalled) {
            responseCalled = true;
            responsePromise = Promise.resolve(options.onResponse?.(response, hookModel)).then(() => {});
          }
          await responsePromise;
        },
      };
      // Accounts skipped or rejected during this request, in order.
      const outcomes: FailoverExhaustionOutcome[] = [];
      for (const member of members) {
        const label = member.label;
        const current = states.get(member.providerId);
        if (current?.recovering) {
          outcomes.push({ label, outcome: "recovering" });
          continue;
        }
        if (current?.benchedUntil !== undefined && current.benchedUntil > now()) {
          outcomes.push({ label, outcome: "benched", reset: current.resetKnown ? "known" : "unknown", until: current.benchedUntil });
          continue;
        }
        // The bench expired: this real request is the account's single recovery attempt in this process.
        const recovery = current?.benchedUntil !== undefined ? current : undefined;
        if (current) {
          current.benchedUntil = undefined;
          current.resetKnown = false;
        }
        if (recovery) recovery.recovering = true;
        try {
          let rejection: RateLimitNotice | undefined;
          let rateLimitTerminal = false;
          const inner = createClaudeStream(member.installation, {
            ...dependencies,
            workingDirectory: () => requestCwd,
            onRateLimitRejection: () => { rateLimitTerminal = true; },
            onRateLimitNotice: (notice) => {
              if (notice.status === "rejected") {
                rejection = notice;
                const state = stateFor(member.providerId);
                const benched = state.benchedUntil !== undefined && state.benchedUntil > now();
                if (notice.resetsAt !== undefined) {
                  // A reported reset replaces a resetless bench and is never shortened by another notice.
                  state.benchedUntil = state.resetKnown && state.benchedUntil !== undefined
                    ? Math.max(state.benchedUntil, notice.resetsAt)
                    : notice.resetsAt;
                  state.resetKnown = true;
                } else if (!benched) {
                  // A rejection that lands while the account is already benched (a concurrent attempt or a
                  // repeated notice) does not lengthen the streak.
                  state.unknownStreak += 1;
                  state.benchedUntil = now() + unknownResetBenchMs(state.unknownStreak);
                }
              }
              dependencies.onRateLimitNotice?.(member.providerId, notice);
            },
          })(model, context, attemptOptions);
          let start: AssistantMessageEvent | undefined;
          let published = false;
          for await (const event of inner) {
            if (!published && event.type === "start") {
              start = structuredClone(event);
              continue;
            }
            if (!published && event.type === "error" && rejection && rateLimitTerminal && options?.signal?.aborted !== true) {
              const state = stateFor(member.providerId);
              outcomes.push({ label, outcome: "rejected", reset: state.resetKnown ? "known" : "unknown", until: state.benchedUntil ?? now() });
              break;
            }
            if (!published) {
              if (start) outer.push(start);
              published = true;
            }
            outer.push(event);
            if (event.type === "done" && rejection === undefined) {
              // Only a confirmed success ends the resetless streak; a non-quota error does not.
              const state = states.get(member.providerId);
              if (state) {
                state.unknownStreak = 0;
                if (state.benchedUntil === undefined) states.delete(member.providerId);
              }
            }
            if (event.type === "done" || event.type === "error") {
              outer.end();
              return;
            }
          }
          if (published) {
            outer.end();
            return;
          }
        } finally {
          if (recovery) recovery.recovering = false;
        }
      }
      const output = createOutput(model);
      output.stopReason = "error";
      output.errorMessage = `Claude accounts are rate limited: ${outcomes.map((entry) => entry.label).join(", ")}`;
      outer.push({ type: "error", reason: "error", error: output });
      outer.end();
      // Diagnostics are advisory: a failing callback (such as a stale session UI) must not affect the request.
      try {
        dependencies.onExhausted?.(outcomes);
      } catch {
        // Ignored by design.
      }
    })();
    return outer;
  };
}
