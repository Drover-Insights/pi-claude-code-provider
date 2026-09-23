import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, VERSION, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { inspectClaudeInstallation } from "../src/auth.ts";
import { providerModelsForSubscription } from "../src/catalog.ts";
import { bridgeArgv } from "../src/claude-args.ts";
import { readClaudeModelAliases } from "../src/claude-models.ts";
import { readConfiguredProviderFile } from "../src/configured-instance-file.ts";
import {
  validateConfigurationRoots,
  validateFailoverDescriptor,
  validateInstanceDescriptors,
  type ConfiguredProviderFailover,
  type ConfiguredProviderInstance,
} from "../src/configured-instances.ts";
import { MINIMUM_VERSIONS, VERIFIED_VERSIONS, platformStatus, startupPlatformWarning, versionStatus } from "../src/compatibility.ts";
import { writeDiagnosticReport } from "../src/diagnostics.ts";
import { errorText, normalizeClaudeOverflow } from "../src/errors.ts";
import { formatDoctorSummary, probeBridge } from "../src/doctor.ts";
import { flushMetricsLog, getLastRequestMetrics, getLastSearchMetrics, getMetricsLogError } from "../src/metrics.ts";
import { createClaudeFailoverStream } from "../src/failover.ts";
import { createClaudeStream } from "../src/provider.ts";
import { cleanupStaleRuntimeDirectories, createRuntimeDirectory } from "../src/runtime-directories.ts";
import { SessionImageStore } from "../src/session-image-store.ts";
import { searchWithClaude } from "../src/web-search.ts";
import type { RateLimitNotice } from "../src/claude-protocol.ts";
import type { RuntimeCleanupResult } from "../src/runtime-directories.ts";
import type { ClaudeInstallation } from "../src/types.ts";

const PROVIDER = "pi-claude-code-provider";
const SEARCH_TOOL = "pi_claude_code_provider_web_search";
const NOTICE_PREFIX = "[pi-claude-code-provider]";
const MAX_TRACKED_RATE_LIMIT_NOTICES = 64;
const MAX_CONFIGURED_DOCTOR_OUTPUT = 16 * 1024;
const MAX_CONFIGURED_DOCTOR_SECTION = 4 * 1024;
const MAX_CONFIGURED_DOCTOR_LABEL = 128;
const CONFIGURATION_FILE_ENVIRONMENT_VARIABLE = "PI_CLAUDE_CODE_PROVIDER_CONFIG";

export default async function piClaudeCodeProvider(pi: ExtensionAPI): Promise<void> {
  const configurationPath = process.env[CONFIGURATION_FILE_ENVIRONMENT_VARIABLE];
  // Like PI_CLAUDE_CODE_PROVIDER_PATH, an empty or whitespace value means unset.
  if (configurationPath === undefined || !configurationPath.trim()) return initializePiClaudeCodeProvider(pi);
  const configuration = await readConfiguredProviderFile(configurationPath);
  return initializePiClaudeCodeProvider(pi, configuration.instances, configuration.failover);
}

export async function initializePiClaudeCodeProvider(
  pi: ExtensionAPI,
  instances?: readonly ConfiguredProviderInstance[],
  failover?: ConfiguredProviderFailover,
): Promise<void> {
  if (instances === undefined && failover !== undefined) {
    throw new Error("Claude Code failover requires configured provider instances");
  }
  if (instances !== undefined) {
    const descriptors = validateInstanceDescriptors(instances);
    failover = failover === undefined ? undefined : validateFailoverDescriptor(failover, descriptors);
    const rootResults = await validateConfigurationRoots(descriptors.map((instance) => instance.configRoot));
    const failures = rootResults.flatMap((result, index) => {
      if (result?.ok !== false) return [];
      const instance = descriptors[index];
      return instance === undefined
        ? []
        : [`${formatConfiguredDoctorLabel(instance.label)}: ${result.reason}`];
    });
    if (failures.length > 0) throw new Error(failures.join("; "));
    instances = Object.freeze(descriptors.map((instance, index) => {
      const result = rootResults[index];
      if (result?.ok !== true) throw new Error("Configured Claude Code root validation did not complete");
      return Object.freeze({ ...instance, configRoot: result.configRoot });
    }));
  }
  const runtimeCleanup = await cleanupStaleRuntimeDirectories();
  registerDoctorCommand(pi, runtimeCleanup, instances);

  let providers: Array<{
    providerId: string;
    name: string;
    notificationLabel?: string;
    installation: ClaudeInstallation;
  }>;
  try {
    if (instances === undefined) {
      providers = [{ providerId: PROVIDER, name: "Claude Code Subscription", installation: await inspectClaudeInstallation() }];
    } else {
      const inspections = await Promise.allSettled(instances.map((instance) =>
        inspectClaudeInstallation(instance.configRoot, instance.expectedIdentityFingerprint)));
      const failures = inspections.flatMap((result, index) => {
        if (result.status === "fulfilled") return [];
        const instance = instances[index];
        if (instance === undefined) return [];
        return [`${formatConfiguredDoctorLabel(instance.label)}\nClaude Code check failed: ${redactConfiguredRoots(errorText(result.reason), instances)}`];
      });
      if (failures.length > 0) {
        registerUnavailableNotice(pi, formatConfiguredDoctorSummary(failures));
        return;
      }
      providers = instances.map((instance, index) => {
        const result = inspections[index];
        if (result?.status !== "fulfilled") throw new Error("Configured Claude Code preflight did not complete");
        return {
          providerId: instance.providerId,
          name: `Claude Code Subscription (${instance.label})`,
          notificationLabel: instance.label,
          installation: result.value,
        };
      });
    }
  } catch (error) {
    const reason = instances === undefined
      ? errorText(error)
      : redactConfiguredRoots(errorText(error), instances);
    registerUnavailableNotice(pi, reason);
    return;
  }
  const firstProvider = providers[0];
  if (firstProvider === undefined) return;
  const providerIds = new Set(providers.map((provider) => provider.providerId));
  if (failover) providerIds.add(failover.providerId);
  const currentPlatform = platformStatus();
  const searchOutputs = createSearchOutputOwner();
  const imageStore = new SessionImageStore();
  let searchRegistrationAttempted = false;
  let activeRateLimitNotifiers: ReadonlyMap<string, (notice: RateLimitNotice) => void> | undefined;
  // Pi's session directory, not process.cwd(): a resumed session takes its cwd
  // from the session file, and Pi's tools resolve paths against that one.
  let sessionCwd: string | undefined;

  for (const provider of providers) {
    pi.registerProvider(provider.providerId, {
      name: provider.name,
      baseUrl: "pi-claude-code-provider://local",
      apiKey: "pi-claude-code-provider-subscription",
      api: "pi-claude-code-provider-headless",
      models: providerModelsForSubscription(provider.installation.subscriptionType),
      streamSimple: createClaudeStream(provider.installation, {
        onRateLimitNotice: (notice) => activeRateLimitNotifiers?.get(provider.providerId)?.(notice),
        workingDirectory: () => sessionCwd,
        imageStore,
      }),
    });
  }

  if (failover) {
    const providersById = new Map(providers.map((provider) => [provider.providerId, provider]));
    const members = failover.order.map((providerId) => {
      const provider = providersById.get(providerId);
      if (!provider) throw new Error("Claude Code failover member validation did not complete");
      return { providerId, label: provider.notificationLabel ?? providerId, installation: provider.installation };
    });
    const memberCatalogs = members.map((member) =>
      providerModelsForSubscription(member.installation.subscriptionType));
    const models = memberCatalogs[0]!
      .filter((model) => memberCatalogs.every((catalog) => catalog.some((candidate) => candidate.id === model.id)))
      .map((model) => {
        const variants = memberCatalogs.map((catalog) => catalog.find((candidate) => candidate.id === model.id)!);
        return {
          ...model,
          contextWindow: Math.min(...variants.map((candidate) => candidate.contextWindow)),
          maxTokens: Math.min(...variants.map((candidate) => candidate.maxTokens)),
        };
      });
    if (models.length === 0) throw new Error("Claude Code failover members have no models in common");
    pi.registerProvider(failover.providerId, {
      name: `Claude Code Subscription (${failover.label})`,
      baseUrl: "pi-claude-code-provider://local",
      apiKey: "pi-claude-code-provider-subscription",
      api: "pi-claude-code-provider-headless",
      models,
      streamSimple: createClaudeFailoverStream(members, {
        onRateLimitNotice: (providerId, notice) => activeRateLimitNotifiers?.get(providerId)?.(notice),
        workingDirectory: () => sessionCwd,
        imageStore,
      }),
    });
  }

  pi.on("session_start", (_event, ctx) => {
    searchOutputs.open();
    imageStore.open();
    sessionCwd = ctx.cwd;
    // The provider starts a process per tool round-trip; session scope prevents
    // Claude's repeated notice from surfacing throughout one Pi turn.
    activeRateLimitNotifiers = new Map(providers.map((provider) => [
      provider.providerId,
      createRateLimitNotifier(
        (message) => ctx.ui.notify(message, "warning"),
        provider.notificationLabel,
      ),
    ]));
    const platformWarning = startupPlatformWarning(currentPlatform);
    if (platformWarning) ctx.ui.notify(`${NOTICE_PREFIX} ${platformWarning}`, "warning");
    if (searchRegistrationAttempted) return;
    searchRegistrationAttempted = true;
    registerWebSearchTool(
      pi,
      // Search as the account that owns the active model; other models keep the first account.
      (modelProvider) => providers.find((provider) => provider.providerId === modelProvider) ?? firstProvider,
      searchOutputs.retain,
      (providerId, notice) => activeRateLimitNotifiers?.get(providerId)?.(notice),
      (message) => ctx.ui.notify(message, "warning"),
    );
  });

  pi.on("session_shutdown", async () => {
    activeRateLimitNotifiers = undefined;
    sessionCwd = undefined;
    try {
      await Promise.all([searchOutputs.close(), imageStore.close()]);
    } finally {
      await flushMetricsLog();
    }
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const assistant = message as AssistantMessage;
    if (!providerIds.has(assistant.provider) && !providerIds.has(ctx.model?.provider ?? "")) return;
    const errorMessage = assistant.errorMessage ?? "";
    const normalized = normalizeClaudeOverflow(errorMessage);
    if (normalized === errorMessage) return;
    return { message: { ...assistant, errorMessage: normalized } };
  });
}

function registerDoctorCommand(
  pi: ExtensionAPI,
  runtimeCleanup: RuntimeCleanupResult,
  instances?: readonly ConfiguredProviderInstance[],
): void {
  pi.registerCommand("pi-claude-code-provider-doctor", {
    description: "Check Claude Code compatibility or write a diagnostic report",
    handler: async (args, ctx) => {
      try {
        const command = args.trim();
        if (command && command !== "report") {
          ctx.ui.notify("Usage: /pi-claude-code-provider-doctor [report]", "error");
          return;
        }
        const currentPlatform = platformStatus();
        const piStatus = versionStatus("Pi", VERSION, VERIFIED_VERSIONS.pi, MINIMUM_VERSIONS.pi);
        // Version and path checks can pass even when the proposal bridge cannot
        // start, so prove it with a real dependency-free handshake.
        const bridgeProbe = await probeBridge().catch((error: unknown) => ({
          ok: false,
          argv: bridgeArgv(),
          detail: errorText(error),
        }));
        if (instances !== undefined) {
          if (command === "report") {
            ctx.ui.notify(
              "Diagnostic report files are not available for configured Claude Code instances; no ambient account was inspected",
              "error",
            );
            return;
          }
          const rootResults = await validateConfigurationRoots(instances.map((instance) => instance.configRoot));
          const checks = await Promise.all(instances.map(async (instance, index) => {
            const label = formatConfiguredDoctorLabel(instance.label);
            const rootResult = rootResults[index];
            if (rootResult?.ok !== true) {
              return {
                section: `${label}\nClaude Code check failed: ${rootResult?.reason ?? "configuration root validation did not complete"}`,
                healthy: false,
              };
            }
            try {
              const current = await inspectClaudeInstallation(
                instance.configRoot,
                instance.expectedIdentityFingerprint,
              );
              const claudeStatus = versionStatus(
                "Claude Code",
                current.version,
                VERIFIED_VERSIONS.claudeCode,
                MINIMUM_VERSIONS.claudeCode,
              );
              const summary = formatDoctorSummary({
                platformStatus: currentPlatform,
                piStatus,
                claudeStatus,
                installation: current,
                modelIds: providerModelsForSubscription(current.subscriptionType).map((model) => model.id),
                modelVersions: await readClaudeModelAliases(current).catch(() => undefined),
                metrics: getLastRequestMetrics(),
                metricsLogError: getMetricsLogError(),
                runtimeCleanup,
                includeProcessState: false,
                bridgeProbe,
              });
              return {
                section: `${label}\n${redactConfiguredRoots(summary, instances)}`,
                healthy: bridgeProbe.ok && claudeStatus.isVerified && piStatus.isVerified && currentPlatform.isVerified,
              };
            } catch (error) {
              return {
                section: `${label}\nClaude Code check failed: ${redactConfiguredRoots(errorText(error), instances)}`,
                healthy: false,
              };
            }
          }));
          ctx.ui.notify(
            formatConfiguredDoctorSummary(checks.map((check) => check.section)),
            checks.every((check) => check.healthy) ? "info" : "warning",
          );
          return;
        }
        if (command === "report") {
          let current: ClaudeInstallation | undefined;
          let preflightError: unknown;
          try { current = await inspectClaudeInstallation(); } catch (error) { preflightError = error; }
          const modelVersions = current ? await readClaudeModelAliases(current).catch(() => undefined) : undefined;
          const path = await writeDiagnosticReport({
            platformStatus: currentPlatform,
            piStatus,
            claudeStatus: current ? versionStatus("Claude Code", current.version, VERIFIED_VERSIONS.claudeCode, MINIMUM_VERSIONS.claudeCode) : undefined,
            installation: current,
            modelVersions,
            preflightError,
            metrics: getLastRequestMetrics(),
            searchMetrics: getLastSearchMetrics(),
            metricsLogError: getMetricsLogError(),
            runtimeCleanup,
            bridgeProbe,
          });
          ctx.ui.notify(
            `Claude Code diagnostic report written to ${path}${preflightError ? "; preflight failed, so installation details may be incomplete" : ""}`,
            preflightError ? "warning" : "info",
          );
          return;
        }
        const current = await inspectClaudeInstallation();
        const claudeStatus = versionStatus("Claude Code", current.version, VERIFIED_VERSIONS.claudeCode, MINIMUM_VERSIONS.claudeCode);
        ctx.ui.notify(formatDoctorSummary({
          platformStatus: currentPlatform,
          piStatus,
          claudeStatus,
          installation: current,
          modelIds: providerModelsForSubscription(current.subscriptionType).map((model) => model.id),
          // Diagnostic only, and fail-soft: a doctor run must never fail
          // because Claude Code moved an undocumented internal table.
          modelVersions: await readClaudeModelAliases(current).catch(() => undefined),
          metrics: getLastRequestMetrics(),
          metricsLogError: getMetricsLogError(),
          runtimeCleanup,
          bridgeProbe,
        }), bridgeProbe.ok && claudeStatus.isVerified && piStatus.isVerified && currentPlatform.isVerified ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");
      }
    },
  });
}

function formatConfiguredDoctorLabel(label: string): string {
  const compact = label.replace(/\s+/g, " ").trim().slice(0, MAX_CONFIGURED_DOCTOR_LABEL);
  return compact || "(unnamed instance)";
}

function redactConfiguredRoots(value: string, instances: readonly ConfiguredProviderInstance[]): string {
  return [...instances]
    .sort((left, right) => right.configRoot.length - left.configRoot.length)
    .reduce(
      (redacted, instance) => replaceConfiguredRoot(redacted, instance.configRoot),
      value,
    );
}

function replaceConfiguredRoot(value: string, configRoot: string): string {
  if (process.platform !== "win32") return value.split(configRoot).join("[configuration root]");
  const lowerValue = value.toLowerCase();
  const lowerRoot = configRoot.toLowerCase();
  let output = "";
  let start = 0;
  for (;;) {
    const index = lowerValue.indexOf(lowerRoot, start);
    if (index === -1) return `${output}${value.slice(start)}`;
    output += `${value.slice(start, index)}[configuration root]`;
    start = index + configRoot.length;
  }
}

function formatConfiguredDoctorSummary(sections: readonly string[]): string {
  let output = "";
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index].slice(0, MAX_CONFIGURED_DOCTOR_SECTION);
    const separator = output ? "\n\n" : "";
    if (output.length + separator.length + section.length <= MAX_CONFIGURED_DOCTOR_OUTPUT) {
      output += `${separator}${section}`;
      continue;
    }
    const omitted = sections.length - index;
    const suffix = `\n\n${omitted} additional configured instance${omitted === 1 ? "" : "s"} omitted from this bounded summary`;
    return `${output.slice(0, Math.max(0, MAX_CONFIGURED_DOCTOR_OUTPUT - suffix.length))}${suffix}`;
  }
  return output || "No configured Claude Code instances";
}

function createRateLimitNotifier(
  notify: (message: string) => void,
  label?: string,
): (notice: RateLimitNotice) => void {
  const emitted = new Set<string>();
  return (notice) => {
    // Key on the displayed text: utilization arrives as a fraction that changes
    // between events while the notice shows whole percent, so keying on the raw
    // notice would repeat an identical-looking warning on every round trip.
    const message = formatRateLimitNotice(notice, label);
    if (emitted.has(message)) return;
    if (emitted.size >= MAX_TRACKED_RATE_LIMIT_NOTICES) {
      const [oldest] = emitted;
      if (oldest !== undefined) emitted.delete(oldest);
    }
    emitted.add(message);
    notify(message);
  };
}

function createSearchOutputOwner() {
  let closing = true;
  const retained = new Set<string>();
  const pending = new Set<Promise<{ directory: string; path: string } | undefined>>();
  const retain = (result: string): Promise<{ directory: string; path: string } | undefined> => {
    if (closing) return Promise.resolve(undefined);
    const retention = (async () => {
      const directory = await createRuntimeDirectory("web_search_output");
      const path = join(directory, "result.md");
      try {
        await writeFile(path, result, { mode: 0o600, flag: "wx" });
        if (closing) {
          await rm(directory, { recursive: true, force: true });
          return undefined;
        }
        retained.add(directory);
        return { directory, path };
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    })();
    // Track before awaiting anything so shutdown owns a directory whose
    // asynchronous creation has begun but has not completed.
    pending.add(retention);
    void retention.finally(() => pending.delete(retention)).catch(() => undefined);
    return retention;
  };
  return {
    open: () => { closing = false; },
    retain,
    async close(): Promise<void> {
      closing = true;
      await Promise.allSettled([...pending]);
      while (retained.size > 0) {
        const directories = [...retained];
        retained.clear();
        await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
      }
    },
  };
}

function registerWebSearchTool(
  pi: ExtensionAPI,
  searchAccount: (modelProvider: string | undefined) => { providerId: string; installation: ClaudeInstallation },
  retainOutput: (result: string) => Promise<{ directory: string; path: string } | undefined>,
  onRateLimitNotice: (providerId: string, notice: RateLimitNotice) => void,
  notify: (message: string) => void,
): void {
  if (pi.getAllTools().some((tool) => tool.name === SEARCH_TOOL)) {
    notify(`${NOTICE_PREFIX} ${SEARCH_TOOL} was not registered because that tool name is already occupied`);
    return;
  }
  pi.registerTool({
    name: SEARCH_TOOL,
    label: "Web Search",
    description: `Search the current web through Claude Code and return a concise synthesis with source URLs. Output is truncated to ${formatSize(DEFAULT_MAX_BYTES)} or ${DEFAULT_MAX_LINES} lines.`,
    promptSnippet: "Search the current web and return sourced results",
    promptGuidelines: [`Use ${SEARCH_TOOL} when current external information or online sources are required.`],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "Search query" }),
      focus: Type.Optional(Type.String({ description: "Optional guidance about what to prioritize" })),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      onUpdate?.({ content: [{ type: "text", text: `Searching the web for: ${params.query}` }], details: { status: "searching" } });
      const account = searchAccount(ctx?.model?.provider);
      const result = await searchWithClaude(
        account.installation,
        { query: params.query, focus: params.focus, signal },
        { onRateLimitNotice: (notice) => onRateLimitNotice(account.providerId, notice) },
      );
      const truncated = truncateHead(result, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
      let text = truncated.content;
      let fullOutputPath: string | undefined;
      if (truncated.truncated) {
        const output = await retainOutput(result);
        if (output) {
          fullOutputPath = output.path;
          text += `\n\n[Web-search output truncated to ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). Full output: ${fullOutputPath}]`;
        }
      }
      return { content: [{ type: "text", text }], details: { truncated: truncated.truncated, fullOutputPath } };
    },
  });
}

/**
 * Claude reports an absolute reset instant, and windows run as long as seven
 * days, so a bare wall-clock time is ambiguous rather than merely terse.
 */
function formatResetInstant(resetsAt: number): string {
  return new Date(resetsAt).toLocaleString();
}

function formatRateLimitNotice(notice: RateLimitNotice, label?: string): string {
  const account = label === undefined ? "" : `${formatConfiguredDoctorLabel(label)}: `;
  const reset = notice.resetsAt === undefined
    ? ""
    : `; resets at ${formatResetInstant(notice.resetsAt)}`;
  // An overage-typed notice reports the overage reset as its primary reset, so
  // the mapper never supplies a separate overage reset in that case.
  const overageReset = notice.overageResetsAt === undefined
    ? ""
    : `; overage resets at ${formatResetInstant(notice.overageResetsAt)}`;
  const overage = notice.overageStatus === undefined
    ? ""
    : `; overage ${notice.overageStatus}${notice.overageDisabledReason ? ` (${notice.overageDisabledReason})` : ""}`;
  const usingOverage = notice.isUsingOverage ? "; using overage" : "";
  if (notice.status === "rejected") {
    return `${NOTICE_PREFIX} ${account}Claude rate limited (${notice.rateLimitType})${reset}${overageReset}${overage}${usingOverage}`;
  }
  const usage = notice.utilization === undefined
    ? "usage is approaching the limit"
    : `${Math.floor(notice.utilization * 100)}% used`;
  // Match Claude Code's current whole-percent display while preserving the
  // fractional utilization in the protocol mapper for future consumers.
  return `${NOTICE_PREFIX} ${account}Claude rate limit warning: ${usage} (${notice.rateLimitType})${reset}${overageReset}${overage}${usingOverage}`;
}

function registerUnavailableNotice(pi: ExtensionAPI, reason: string): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify(
      `${NOTICE_PREFIX} Claude Code provider is unavailable: ${reason}. Run /pi-claude-code-provider-doctor, then /reload after correcting the problem.`,
      "error",
    );
  });
}
