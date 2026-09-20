import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ConfiguredProviderFailover, ConfiguredProviderInstance } from "./configured-instances.ts";

const MAX_CONFIGURATION_BYTES = 64 * 1024;

export interface ConfiguredProviderDocument {
  readonly instances: readonly ConfiguredProviderInstance[];
  readonly failover?: ConfiguredProviderFailover;
}

export async function readConfiguredProviderFile(path: string): Promise<ConfiguredProviderDocument> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("Claude Code provider configuration must use a canonical absolute file path");
  }
  let physicalPath: string;
  try {
    physicalPath = await realpath(path);
  } catch {
    throw new Error("Claude Code provider configuration file is unavailable");
  }
  const pathsMatch = process.platform === "win32"
    ? physicalPath.toLowerCase() === path.toLowerCase()
    : physicalPath === path;
  if (!pathsMatch) throw new Error("Claude Code provider configuration file must not use symlinks");

  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
    throw new Error("Claude Code provider configuration file is unavailable");
  });
  try {
    const [fileStat, currentStat] = await Promise.all([handle.stat(), stat(path)]).catch(() => {
      throw new Error("Claude Code provider configuration file is unavailable");
    });
    if (!fileStat.isFile() || fileStat.dev !== currentStat.dev || fileStat.ino !== currentStat.ino) {
      throw new Error("Claude Code provider configuration must be one stable regular file");
    }
    if (process.platform !== "win32" && (fileStat.mode & 0o777) !== 0o600) {
      throw new Error("Claude Code provider configuration file must have mode 0600");
    }
    if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) {
      throw new Error("Claude Code provider configuration file must be owned by the current user");
    }
    if (fileStat.size > MAX_CONFIGURATION_BYTES) {
      throw new Error("Claude Code provider configuration file is too large");
    }
    const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIGURATION_BYTES) {
      throw new Error("Claude Code provider configuration file is too large");
    }
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new Error("Claude Code provider configuration file must contain valid UTF-8");
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      throw new Error("Claude Code provider configuration file must contain valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Claude Code provider configuration must be an object");
    }
    const document = value as Record<string, unknown>;
    if (Object.keys(document).some((field) => field !== "instances" && field !== "failover")) {
      throw new Error("Claude Code provider configuration contains an unknown field");
    }
    if (!Array.isArray(document.instances)) {
      throw new Error("Claude Code provider configuration must contain an instances array");
    }
    for (const instance of document.instances) {
      requireAllowedFields(
        instance,
        ["providerId", "label", "configRoot", "expectedIdentityFingerprint"],
        "instance descriptor",
      );
    }
    if (document.failover !== undefined) {
      requireAllowedFields(document.failover, ["providerId", "label", "order"], "failover descriptor");
    }
    return Object.freeze({
      instances: document.instances as readonly ConfiguredProviderInstance[],
      ...(document.failover === undefined ? {} : { failover: document.failover as ConfiguredProviderFailover }),
    });
  } finally {
    await handle.close();
  }
}

function requireAllowedFields(value: unknown, allowedFields: readonly string[], label: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Claude Code provider ${label} must be an object`);
  }
  const allowed = new Set(allowedFields);
  if (Object.keys(value).some((field) => !allowed.has(field))) {
    throw new Error(`Claude Code provider ${label} contains an unknown field`);
  }
}
