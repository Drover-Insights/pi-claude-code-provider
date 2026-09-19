import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ConfiguredProviderFailover, ConfiguredProviderInstance } from "../src/configured-instances.ts";
import piClaudeCodeProvider, { initializePiClaudeCodeProvider } from "./pi-claude-code-provider.ts";

export type ClaudeCodeProviderInstance = ConfiguredProviderInstance;
export type ClaudeCodeProviderFailover = ConfiguredProviderFailover;

export interface PiClaudeCodeProviderOptions {
  readonly instances: readonly ClaudeCodeProviderInstance[];
  readonly failover?: ClaudeCodeProviderFailover;
}

export function createPiClaudeCodeProvider(
  options: PiClaudeCodeProviderOptions,
): (pi: ExtensionAPI) => Promise<void> {
  return async (pi: ExtensionAPI): Promise<void> => {
    await initializePiClaudeCodeProvider(pi, options.instances, options.failover);
  };
}

// Pi's startup [Extensions] list appends a package entry's filename to the
// package name unless the entry is an index file, so the manifest points here
// to show plain "pi-claude-code-provider". The implementation keeps its name.
export default piClaudeCodeProvider;
