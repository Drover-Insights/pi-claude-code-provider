export class ClaudeCodeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ClaudeCodeError";
    this.code = code;
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The string `code` of a Node system error or ClaudeCodeError, if present. */
export function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export function appendCleanupFailure(primary: string | undefined, subject: string, cleanupError: unknown): string {
  const cleanup = `${subject} cleanup failed: ${errorText(cleanupError)}`;
  return primary ? `${primary}; ${cleanup}` : cleanup;
}

const CLAUDE_OVERFLOW = /(?:prompt is too long|prompt too long|context window exceeded|context length exceeded)/i;

/** Normalize only Claude-specific overflow wording; leave rate limits and unrelated failures untouched. */
export function normalizeClaudeOverflow(errorMessage: string): string {
  if (errorMessage.includes("context_length_exceeded") || !CLAUDE_OVERFLOW.test(errorMessage)) return errorMessage;
  return `context_length_exceeded: ${errorMessage}`;
}
