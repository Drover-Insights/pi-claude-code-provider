import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { validPid } from "./process-utils.ts";

const MARKER_NAME = ".pi-claude-code-provider-runtime.json";
const MARKER_SCHEMA = "pi-claude-code-provider-runtime-v1";
const MINIMUM_STALE_AGE_MS = 60 * 60_000;
const MAX_DELETION_ATTEMPTS = 256;

export type RuntimeDirectoryKind = "provider_request" | "provider_image_store" | "web_search_request" | "web_search_output";

const PREFIXES: Record<RuntimeDirectoryKind, string> = {
  provider_request: "pi-claude-code-provider-request-",
  provider_image_store: "pi-claude-code-provider-images-",
  web_search_request: "pi-claude-code-provider-search-",
  web_search_output: "pi-claude-code-provider-search-output-",
};

interface RuntimeMarker {
  schema: typeof MARKER_SCHEMA;
  kind: RuntimeDirectoryKind;
  ownerPid: number;
  childPid?: number;
  createdAt: string;
}

interface CreateRuntimeDirectoryOptions {
  temporaryRoot?: string;
  ownerPid?: number;
  now?: number;
}

interface CleanupRuntimeDirectoryOptions {
  temporaryRoot?: string;
  currentUid?: number;
  now?: number;
  minimumAgeMs?: number;
  maxDeletionAttempts?: number;
  /** Existence probe: negative IDs identify POSIX process groups. */
  processAlive?: (pid: number) => boolean;
  /** Internal seams for deterministic filesystem-failure tests. */
  inspectDirectory?: typeof lstat;
  removeDirectory?: typeof removeRuntimeDirectory;
}

export interface RuntimeCleanupResult {
  removed: number;
  failures: number;
}

export async function removeRuntimeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function createRuntimeDirectory(
  kind: RuntimeDirectoryKind,
  options: CreateRuntimeDirectoryOptions = {},
): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), PREFIXES[kind]));
  try {
    const directory = await realpath(temporaryDirectory);
    await chmod(directory, 0o700);
    const marker: RuntimeMarker = {
      schema: MARKER_SCHEMA,
      kind,
      ownerPid: options.ownerPid ?? process.pid,
      createdAt: new Date(options.now ?? Date.now()).toISOString(),
    };
    await writeFile(markerPath(directory), `${JSON.stringify(marker)}\n`, { mode: 0o600, flag: "wx" });
    return directory;
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function recordRuntimeChild(directory: string, childPid: number): Promise<void> {
  if (!validPid(childPid)) throw new Error("Claude Code child process has no valid process ID");
  const marker = await readMarker(directory);
  if (!marker) throw new Error("Private runtime directory marker is missing or invalid");
  await writeFile(markerPath(directory), `${JSON.stringify({ ...marker, childPid })}\n`, { mode: 0o600 });
  await chmod(markerPath(directory), 0o600);
}

/** Best-effort recovery for state left by an abruptly terminated Pi process. */
export async function cleanupStaleRuntimeDirectories(
  options: CleanupRuntimeDirectoryOptions = {},
): Promise<RuntimeCleanupResult> {
  const currentUid = options.currentUid ?? process.getuid?.();
  if (currentUid === undefined) return { removed: 0, failures: 0 };
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const now = options.now ?? Date.now();
  const minimumAgeMs = options.minimumAgeMs ?? MINIMUM_STALE_AGE_MS;
  const maxDeletionAttempts = options.maxDeletionAttempts ?? MAX_DELETION_ATTEMPTS;
  if (maxDeletionAttempts <= 0) return { removed: 0, failures: 0 };
  const processAlive = options.processAlive ?? isProcessAlive;
  const inspectDirectory = options.inspectDirectory ?? lstat;
  const removeDirectory = options.removeDirectory ?? removeRuntimeDirectory;
  const childAlive = (marker: RuntimeMarker): boolean => marker.childPid !== undefined &&
    (processAlive(marker.childPid) || processAlive(-marker.childPid));
  let entries;
  try {
    entries = await readdir(temporaryRoot, { withFileTypes: true });
  } catch {
    return { removed: 0, failures: 1 };
  }
  const eligible = entries.filter((entry) => entry.isDirectory() && runtimeKind(entry.name) !== undefined)
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  // Inspect all ownership before deleting: a request beyond the deletion budget
  // can protect images earlier in the ordering. Budget deletions, not inspection,
  // so an accumulation of stale images can drain across successive passes.
  const candidates: Array<{ directory: string; marker: RuntimeMarker }> = [];
  const ownersWithLiveProviderChildren = new Set<number>();
  let ownershipIncomplete = false;
  let removed = 0;
  let failures = 0;
  for (const entry of eligible) {
    const directory = join(temporaryRoot, entry.name);
    try {
      const info = await inspectDirectory(directory);
      if (!info.isDirectory() || info.uid !== currentUid) continue;
      const marker = await readMarker(directory);
      const kind = runtimeKind(entry.name);
      if (!marker || marker.kind !== kind) continue;
      candidates.push({ directory, marker });
      if (kind === "provider_request" && childAlive(marker)) ownersWithLiveProviderChildren.add(marker.ownerPid);
    } catch {
      if (runtimeKind(entry.name) === "provider_request") ownershipIncomplete = true;
      failures += 1;
    }
  }
  let attempts = 0;
  for (const { directory, marker } of candidates) {
    if (attempts >= maxDeletionAttempts) break;
    try {
      if (marker.kind === "provider_image_store" && (ownershipIncomplete || ownersWithLiveProviderChildren.has(marker.ownerPid))) continue;
      const createdAt = Date.parse(marker.createdAt);
      if (!Number.isFinite(createdAt) || now - createdAt < minimumAgeMs) continue;
      if (processAlive(marker.ownerPid) || childAlive(marker)) continue;
      const current = await inspectDirectory(directory);
      if (!current.isDirectory() || current.uid !== currentUid) continue;
      attempts += 1;
      await removeDirectory(directory);
      removed += 1;
    } catch {
      // Report only an aggregate count: cleanup diagnostics must not expose paths.
      failures += 1;
    }
  }
  return { removed, failures };
}

function runtimeKind(name: string): RuntimeDirectoryKind | undefined {
  // Prefixes nest: a web_search_output name also starts with the
  // web_search_request prefix. Longest match keeps each kind distinguishable,
  // because a misread kind is discarded by the marker comparison in cleanup.
  return (Object.entries(PREFIXES) as Array<[RuntimeDirectoryKind, string]>)
    .filter(([, prefix]) => name.startsWith(prefix))
    .sort(([, left], [, right]) => right.length - left.length)[0]?.[0];
}

async function readMarker(directory: string): Promise<RuntimeMarker | undefined> {
  try {
    const path = markerPath(directory);
    const info = await lstat(path);
    if (!info.isFile() || info.size > 1024) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<RuntimeMarker>;
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      value.schema !== MARKER_SCHEMA ||
      !isRuntimeKind(value.kind) ||
      !validPid(value.ownerPid) ||
      (value.childPid !== undefined && !validPid(value.childPid)) ||
      typeof value.createdAt !== "string" ||
      !basename(directory).startsWith(PREFIXES[value.kind])
    ) return undefined;
    return value as RuntimeMarker;
  } catch (error) {
    // Missing/invalid markers grant no deletion authority. Other filesystem
    // errors must reach the ownership scan so it cannot silently delete images.
    if (error instanceof SyntaxError || (error && typeof error === "object" && "code" in error && error.code === "ENOENT")) return undefined;
    throw error;
  }
}

function markerPath(directory: string): string {
  return join(directory, MARKER_NAME);
}

function isRuntimeKind(value: unknown): value is RuntimeDirectoryKind {
  return typeof value === "string" && value in PREFIXES;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}
