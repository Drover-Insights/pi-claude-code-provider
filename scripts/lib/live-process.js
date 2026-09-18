import { JsonlParser } from "../../src/jsonl.ts";
import { terminateProcessGroup } from "../../src/process-utils.ts";

export function superviseLiveProcess(child, { timeoutMs, label }) {
  let timedOut = false;
  let terminationPromise;
  const terminate = () => {
    terminationPromise ??= terminateProcessGroup(child);
    return terminationPromise;
  };
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    void terminate().catch(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
  }, timeoutMs);

  return {
    terminate,
    async wait() {
      try {
        const outcome = await result;
        if (timedOut) throw new Error(`${label} exceeded ${timeoutMs}ms`);
        return outcome;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export async function closeLiveRpcProcess(child, supervisor, closed, graceMs = 2_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    const result = await closed;
    return { result, graceful: result.code === 0 && result.signal === null };
  }

  const stdin = child.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    await supervisor.terminate();
    return { result: await closed, graceful: false };
  }

  // RPC stdin EOF is Pi's cross-platform graceful-shutdown path. Keep a no-op
  // error listener until close so a concurrent child exit cannot surface EPIPE.
  const ignoreStdinError = () => {};
  stdin.on("error", ignoreStdinError);
  stdin.end();

  let timer;
  try {
    const outcome = await Promise.race([
      closed.then((result) => ({ result, graceful: true })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs);
      }),
    ]);
    if (outcome) return outcome;
    await supervisor.terminate();
    return { result: await closed, graceful: false };
  } finally {
    if (timer) clearTimeout(timer);
    stdin.removeListener("error", ignoreStdinError);
  }
}

/**
 * The final assistant message among Pi's events. A turn that ended in a provider
 * error (usage credits off, a rate limit, a lost login) carries no text, so its
 * error is reported by name instead of failing a reply assertion on "".
 *
 * Every live and paid stage reads its replies through here, so the empty-thinking
 * check belongs here rather than at each call site: the model matrix runs it for
 * every alias and effort, which is the surface the defect appeared on.
 */
export function assistantReply(events, label) {
  const message = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").at(-1)?.message;
  if (!message) throw new Error(`${label} returned no assistant message`);
  if (message.stopReason === "error") throw new Error(`${label}: ${message.errorMessage ?? "unknown assistant error"}`);
  // Claude Code returns thinking blocks carrying a signature and no text unless
  // the request asks for summarized display, which spends reasoning tokens Pi
  // cannot show. The request succeeds either way, so nothing else would notice a
  // release that stopped honouring the option. Redacted thinking is the one
  // legitimate empty block: its payload lives in the signature.
  const empty = thinkingBlocks(message).filter((block) => block.redacted !== true && !block.thinking?.trim());
  if (empty.length > 0) {
    throw new Error(`${label}: ${empty.length} thinking block(s) arrived with no text; is --thinking-display still honoured?`);
  }
  return message;
}

function thinkingBlocks(message) {
  return (message?.content ?? []).filter((block) => block.type === "thinking");
}

/**
 * Whether a reply carried visible thinking text at all. Adaptive thinking may
 * skip a turn, so the check above cannot be unconditional; stages report this so
 * a run that never exercised it is distinguishable from one that passed.
 */
export function thinkingTextSeen(message) {
  return thinkingBlocks(message).some((block) => block.redacted !== true && Boolean(block.thinking?.trim()));
}

export function consumeJsonl(stream, onValue, onError) {
  const parser = new JsonlParser(onValue);
  let failed = false;
  const fail = (error) => {
    if (failed) return;
    failed = true;
    onError(error instanceof Error ? error : new Error(String(error)));
  };
  stream.on("data", (chunk) => {
    if (failed) return;
    try {
      parser.push(chunk);
    } catch (error) {
      fail(error);
    }
  });
  stream.on("end", () => {
    if (failed) return;
    try {
      parser.end();
    } catch (error) {
      fail(error);
    }
  });
}
