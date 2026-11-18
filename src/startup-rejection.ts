import { summarizeClaudeInitialization } from "./claude-protocol.ts";
import { ClaudeCodeError } from "./errors.ts";

/** Denial-only detail for the existing mapper. No raw record or inventory value escapes. */
export function initializationRejectionDetail(error: unknown, record: Record<string, unknown>): unknown {
  if (!(error instanceof ClaudeCodeError) || error.code !== "isolation_customizations") return error;
  try {
    const counts = summarizeClaudeInitialization(record);
    const categories: string[] = [];
    if (typeof counts.slashCommandsCount === "number" && counts.slashCommandsCount > 0) categories.push("slash-commands");
    if (typeof counts.skillsCount === "number" && counts.skillsCount > 0) categories.push("skills");
    if (counts.builtinPluginsOnly === false) categories.push("plugins");
    if (categories.length === 0) return error;
    return new ClaudeCodeError("isolation_customizations",
      `Claude Code loaded unexpected customizations [inventory: ${categories.join(",")}]`);
  } catch {
    // Projection is never acceptance and must not replace the original refusal.
    return error;
  }
}
