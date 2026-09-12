import { fileURLToPath } from "node:url";
import { basename } from "node:path";
import { scriptLaunch, type ScriptLaunch } from "./host-runtime.ts";
import type { PreparedRequest } from "./types.ts";

// Empty setting sources plus explicit settings preserve subscription authentication
// while suppressing user and project customizations. --bare would disable OAuth,
// and --safe-mode would disable the proposal MCP server.
// Claude Code 2.1.233 added a changing terminal token reminder that breaks
// append-only cache reuse across this provider's fresh print-mode processes.
const SETTINGS = JSON.stringify({ disableAllHooks: true, autoMemoryEnabled: false, totalTokensReminder: "off" });
const EMPTY_MCP = JSON.stringify({ mcpServers: {} });
export const BRIDGE_PATH = fileURLToPath(new URL("../bridge/mcp-proposal-server.js", import.meta.url));

// Claude Code 2.1.268 moved the final cache breakpoint off the transcript and onto
// a trailing message it appends itself, leaving no reusable entry inside the history
// this provider replays in full every request. Marking the last history block
// restores that entry. The TTL must be 1h rather than the five-minute default: the
// API requires breakpoints in longest-TTL-first order, and Claude Code's own
// markers, including the one it now places after this one, are all 1h. Earlier
// builds normalize the field away and keep only their own marker, so this is inert
// there rather than version-gated. Haiku 4.5 is not helped, because it receives the
// same appended content ahead of the transcript, which no marker placement reaches.
const TRANSCRIPT_CACHE_CONTROL = { type: "ephemeral", ttl: "1h" } as const;

interface PromptBlock {
  type: "text";
  text: string;
  cache_control?: typeof TRANSCRIPT_CACHE_CONTROL;
}

/** The single owner of how the proposal bridge is launched on either Pi distribution. */
export function bridgeLaunch(bunConfigPath?: string): ScriptLaunch {
  return scriptLaunch(BRIDGE_PATH, [], bunConfigPath);
}

/** Exact argv Claude Code receives for the proposal bridge. */
export function bridgeArgv(bunConfigPath?: string): string[] {
  const launch = bridgeLaunch(bunConfigPath);
  return [launch.command, ...launch.args];
}

export function formatBridgeArgv(argv: readonly string[]): string {
  return JSON.stringify(argv);
}

export function baseClaudeArgs(): string[] {
  return [
    "-p",
    "--setting-sources",
    "",
    "--settings",
    SETTINGS,
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--no-chrome",
    "--no-session-persistence",
    "--prompt-suggestions",
    "false",
  ];
}

export function providerArgs(
  prepared: PreparedRequest,
  model: string,
  effort: string,
): { args: string[]; prompt: PromptBlock[] } {
  const imageRefs = prepared.attachmentPaths.map((path) => `@./${basename(path)}`).join(" ");
  const imageInstruction = imageRefs
    ? ` Generated image attachments for image_attachment blocks: ${imageRefs}.`
    : "";
  // Keep the growing attachment list after unchanged history, and outside the
  // breakpoint, so adding an image does not invalidate the cached transcript.
  const lastHistoryBlock = prepared.transcriptBlocks.length - 1;
  const prompt: PromptBlock[] = [
    ...prepared.transcriptBlocks.map((text, index) => ({
      type: "text" as const,
      text,
      ...(index === lastHistoryBlock ? { cache_control: TRANSCRIPT_CACHE_CONTROL } : {}),
    })),
    ...(imageInstruction ? [{ type: "text" as const, text: imageInstruction.trim() }] : []),
  ];
  const bridge = bridgeLaunch(prepared.bunConfigPath);
  const mcpConfig = prepared.catalogPath
    ? JSON.stringify({
        mcpServers: {
          pi: {
            command: bridge.command,
            args: bridge.args,
            env: {
              ...bridge.env,
              PI_CLAUDE_TOOL_CATALOG: prepared.catalogPath,
              PI_CLAUDE_TOOL_VIOLATION: prepared.violationPath,
              PI_CLAUDE_TOOL_READY: prepared.readyPath,
            },
          },
        },
      })
    : EMPTY_MCP;
  // Keep the system prompt out of process arguments and avoid command-line size limits.
  const args = [
    ...baseClaudeArgs(),
    "--mcp-config",
    mcpConfig,
    "--tools",
    "",
    "--model",
    model,
    "--effort",
    effort,
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--system-prompt-file",
    prepared.systemPromptPath,
  ];
  return { args, prompt };
}
