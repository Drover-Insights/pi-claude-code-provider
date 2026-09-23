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

export interface ClaudeFailoverDependencies extends Omit<ClaudeStreamDependencies, "onRateLimitNotice" | "onRateLimitRejection"> {
  readonly onRateLimitNotice?: (providerId: string, notice: RateLimitNotice) => void;
  readonly now?: () => number;
}

export function createClaudeFailoverStream(
  members: readonly ClaudeFailoverMember[],
  dependencies: ClaudeFailoverDependencies = {},
) {
  const exhaustedUntil = new Map<string, number>();
  const now = dependencies.now ?? Date.now;

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
      // Accounts skipped as exhausted or rejected during this request, in order.
      const unavailableLabels: string[] = [];
      for (const member of members) {
        const deadline = exhaustedUntil.get(member.providerId);
        if (deadline !== undefined && deadline > now()) {
          unavailableLabels.push(member.label);
          continue;
        }
        if (deadline !== undefined) exhaustedUntil.delete(member.providerId);

        let rejection: RateLimitNotice | undefined;
        let rateLimitTerminal = false;
        const inner = createClaudeStream(member.installation, {
          ...dependencies,
          workingDirectory: () => requestCwd,
          onRateLimitRejection: () => { rateLimitTerminal = true; },
          onRateLimitNotice: (notice) => {
            if (notice.status === "rejected") {
              rejection = notice;
              // A reported reset instant supersedes the unknown (infinite) deadline of a
              // notice without one; otherwise keep the later of the known instants.
              const currentDeadline = exhaustedUntil.get(member.providerId);
              const deadline = notice.resetsAt === undefined
                ? currentDeadline ?? Number.POSITIVE_INFINITY
                : currentDeadline === undefined || currentDeadline === Number.POSITIVE_INFINITY
                  ? notice.resetsAt
                  : Math.max(currentDeadline, notice.resetsAt);
              exhaustedUntil.set(member.providerId, deadline);
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
            unavailableLabels.push(member.label);
            break;
          }
          if (!published) {
            if (start) outer.push(start);
            published = true;
          }
          outer.push(event);
          if (event.type === "done" || event.type === "error") {
            outer.end();
            return;
          }
        }
        if (published) {
          outer.end();
          return;
        }
      }
      const output = createOutput(model);
      output.stopReason = "error";
      output.errorMessage = `Claude accounts are rate limited: ${unavailableLabels.join(", ")}`;
      outer.push({ type: "error", reason: "error", error: output });
      outer.end();
    })();
    return outer;
  };
}
