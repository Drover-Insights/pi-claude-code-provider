import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface ConfiguredProviderInstance {
  readonly providerId: string;
  readonly label: string;
  readonly configRoot: string;
  readonly expectedIdentityFingerprint: string;
}

export function validateInstanceDescriptors(
  instances: readonly ConfiguredProviderInstance[],
): readonly ConfiguredProviderInstance[] {
  if (!Array.isArray(instances) || instances.length === 0 || instances.length > 16) {
    throw new Error("Claude Code provider configuration must contain between 1 and 16 configured instances");
  }
  const providerIds = new Set<string>();
  const labels = new Set<string>();
  const validated: ConfiguredProviderInstance[] = [];
  for (const instance of instances) {
    if (typeof instance !== "object" || instance === null) {
      throw new Error("Each Claude Code configured instance must be an object descriptor");
    }
    const providerId = instance.providerId;
    const label = instance.label;
    const configRoot = instance.configRoot;
    const expectedIdentityFingerprint = instance.expectedIdentityFingerprint;
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(providerId)) {
      throw new Error("Each Claude Code provider ID must be a lowercase opaque label");
    }
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(label)) {
      throw new Error("Each Claude Code instance must use a lowercase opaque label");
    }
    if (typeof expectedIdentityFingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedIdentityFingerprint)) {
      throw new Error("Each Claude Code instance must use a lowercase sha256 identity fingerprint");
    }
    if (providerIds.has(providerId)) {
      throw new Error("Each Claude Code provider ID must identify one configured instance");
    }
    if (labels.has(label)) {
      throw new Error("Each Claude Code instance must use a distinct opaque label");
    }
    providerIds.add(providerId);
    labels.add(label);
    validated.push(Object.freeze({ providerId, label, configRoot, expectedIdentityFingerprint }));
  }
  return Object.freeze(validated);
}

export type ConfigurationRootValidation =
  | { readonly ok: true; readonly configRoot: string }
  | { readonly ok: false; readonly reason: string };

type InspectedConfigurationRoot =
  | { readonly ok: true; readonly configRoot: string; readonly physicalRoot: string }
  | { readonly ok: false; readonly reason: string };

export async function validateConfigurationRoots(
  configRoots: readonly string[],
): Promise<readonly ConfigurationRootValidation[]> {
  const inspected: InspectedConfigurationRoot[] = await Promise.all(configRoots.map(inspectConfigurationRoot));
  const indicesByPhysicalRoot = new Map<string, number[]>();
  for (let index = 0; index < inspected.length; index += 1) {
    const result = inspected[index];
    if (result?.ok !== true) continue;
    const key = pathComparisonKey(result.physicalRoot);
    const indices = indicesByPhysicalRoot.get(key) ?? [];
    indices.push(index);
    indicesByPhysicalRoot.set(key, indices);
  }
  for (const indices of indicesByPhysicalRoot.values()) {
    if (indices.length < 2) continue;
    for (const index of indices) {
      inspected[index] = {
        ok: false,
        reason: "Each Claude Code provider instance must use a distinct configuration root",
      };
    }
  }
  return Object.freeze(inspected.map((result) => result.ok
    ? Object.freeze({ ok: true as const, configRoot: result.configRoot })
    : Object.freeze({ ok: false as const, reason: result.reason })));
}

async function inspectConfigurationRoot(configRoot: string): Promise<InspectedConfigurationRoot> {
  if (typeof configRoot !== "string" || !configRoot || !isAbsolute(configRoot)) {
    return { ok: false, reason: "Each Claude Code provider instance must use a non-empty absolute configuration root" };
  }
  if (resolve(configRoot) !== configRoot) {
    return { ok: false, reason: "Each Claude Code provider instance must use a canonical configuration root" };
  }
  let physicalRoot: string;
  try {
    const rootStat = await stat(configRoot);
    if (!rootStat.isDirectory()) throw new Error("not_directory");
    physicalRoot = await realpath(configRoot);
  } catch {
    return { ok: false, reason: "Each Claude Code provider instance must use an existing configuration root directory" };
  }
  if (!pathsEqual(configRoot, physicalRoot)) {
    return { ok: false, reason: "Each Claude Code provider instance must use a canonical configuration root without symlink ambiguity" };
  }
  return { ok: true, configRoot, physicalRoot };
}

function pathsEqual(left: string, right: string): boolean {
  return pathComparisonKey(left) === pathComparisonKey(right);
}

function pathComparisonKey(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}
