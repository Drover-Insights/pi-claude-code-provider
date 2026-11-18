import {
  validateClaudeInitialization, summarizeClaudeInitialization,
  type ClaudeInitializationExpectation,
} from "./claude-protocol.ts";
import { ClaudeCodeError } from "./errors.ts";

// Source-only record adapter. It cannot spawn, approve an operation, publish
// assistant/tool events, claim process death or complete a managed capture.
const MAX_LINE_BYTES = 64 * 1024;
const GUARD_CODES = new Set([
  "protocol_init", "protocol_shape", "isolation_tools", "isolation_permissions",
  "isolation_customizations", "isolation_auth", "isolation_mcp",
]);
export type InitObservation =
  | Readonly<{ state: "pending" }>
  | Readonly<{ state: "inconclusive"; initialization: "not_evaluated"; reason: "capture_limit" | "malformed_input" | "no_init" }>
  | Readonly<{ state: "rejected"; initialization: "not_evaluated"; guard: "protocol_order" | "protocol_shape" }>
  | Readonly<{ state: "observed"; initialization: "accepted" | "rejected"; guard?: string; counts: Readonly<Record<string, number | boolean>> }>;

export class ReviewerInitObservation {
  #expectation: ClaudeInitializationExpectation;
  #pending = Buffer.alloc(MAX_LINE_BYTES);
  #length = 0;
  #maximum = 0;
  #terminal = false;
  #result: InitObservation = Object.freeze({ state: "pending" });

  constructor(expectation: ClaudeInitializationExpectation) {
    this.#expectation = {
      tools: new Set(expectation.tools), mcpServer: expectation.mcpServer,
      privatePaths: [...(expectation.privatePaths ?? [])],
    };
  }
  get result(): InitObservation { return this.#result; }
  get maxBufferedBytes(): number { return this.#maximum; }
  get terminal(): boolean { return this.#terminal; }

  push(chunk: Buffer): void {
    if (this.#terminal) return;
    if (!Buffer.isBuffer(chunk)) { this.#inconclusive("malformed_input"); return; }
    let start = 0;
    while (start < chunk.length && !this.#terminal) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (this.#length + end - start > MAX_LINE_BYTES) { this.#inconclusive("capture_limit"); return; }
      chunk.copy(this.#pending, this.#length, start, end);
      this.#length += end - start;
      this.#maximum = Math.max(this.#maximum, this.#length);
      if (newline < 0) return;
      this.#line(); start = newline + 1;
    }
  }
  end(): void {
    if (this.#terminal) return;
    this.#line();
    if (!this.#terminal) this.#inconclusive("no_init");
  }
  #latch(): void {
    this.#terminal = true;
    this.#pending.fill(0); this.#length = 0;
  }
  #inconclusive(reason: "capture_limit" | "malformed_input" | "no_init"): void {
    this.#latch();
    this.#result = Object.freeze({ state: "inconclusive", initialization: "not_evaluated", reason });
  }
  #line(): void {
    const text = this.#pending.toString("utf8", 0, this.#length);
    this.#pending.fill(0, 0, this.#length); this.#length = 0;
    if (!text.trim()) return;
    let value: unknown;
    try { value = JSON.parse(text); } catch { this.#inconclusive("malformed_input"); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.#latch();
      this.#result = Object.freeze({ state: "rejected", initialization: "not_evaluated", guard: "protocol_shape" });
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.type === "system" && record.subtype !== "init") return;
    if (record.type !== "system" || record.subtype !== "init") {
      this.#latch();
      this.#result = Object.freeze({ state: "rejected", initialization: "not_evaluated", guard: "protocol_order" });
      return;
    }
    // Latch synchronously BEFORE validation/projection. Following records in the
    // same chunk cannot reach any body handler; there is no async observer here.
    this.#latch();
    let initialization: "accepted" | "rejected" = "accepted";
    let guard: string | undefined;
    try { validateClaudeInitialization(record, this.#expectation); }
    catch (error) {
      initialization = "rejected";
      guard = error instanceof ClaudeCodeError && GUARD_CODES.has(error.code) ? error.code : "unclassified_guard";
    }
    const counts = summarizeClaudeInitialization(record);
    this.#result = Object.freeze({ state: "observed", initialization, ...(guard === undefined ? {} : { guard }), counts });
  }
}
