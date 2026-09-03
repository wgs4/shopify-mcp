import type { GraphQLClient } from "graphql-request";
import type { z } from "zod";

// ── Shared Shopify types ──────────────────────────────────────────────

export interface ShopifyUserError {
  field: string;
  message: string;
  code?: string;
}

export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyEdge<T> {
  node: T;
}

export interface ShopifyConnection<T> {
  edges: ShopifyEdge<T>[];
  pageInfo?: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
}

// ── Tool registry interface ───────────────────────────────────────────

export interface ShopifyTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  initialize(client: GraphQLClient): void;
  execute(args: Record<string, unknown>): Promise<unknown>;
}

// ── Utility functions ─────────────────────────────────────────────────

/**
 * Throw a formatted error if Shopify userErrors array is non-empty.
 */
export function checkUserErrors(
  errors: ShopifyUserError[],
  operation: string,
): void {
  if (errors.length > 0) {
    throw new Error(
      `Failed to ${operation}: ${errors
        .map((e) => `${e.field}: ${e.message}`)
        .join(", ")}`,
    );
  }
}

const TYPED_ERROR_NAMES = new Set([
  "ScopeHorizonError",
  "MissingScopeError",
  "BulkOperationError",
]);

const TYPED_ERROR_CODES = new Set([
  "SCOPE_HORIZON",
  "MISSING_SCOPE",
  "INVALID",
  "LIMIT_REACHED",
  "OPERATION_IN_PROGRESS",
  "FAILED",
  "CANCELED",
  "EXPIRED",
  "TIMEOUT",
  "ACCESS_DENIED",
  "TOO_MANY_OBJECTS",
  "DOWNLOAD_FAILED",
  "DEADLINE",
]);

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * True for typed errors that the MCP host should see unwrapped: named
 * ScopeHorizonError / MissingScopeError / BulkOperationError, or an
 * object whose `code` is one of the explicit allow-list values. Network
 * codes such as ECONNREFUSED are NOT typed and get wrapped.
 */
function isTypedToolError(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return false;
  }
  const rec = error as { name?: unknown; code?: unknown };
  if (typeof rec.name === "string" && TYPED_ERROR_NAMES.has(rec.name)) {
    return true;
  }
  return typeof rec.code === "string" && TYPED_ERROR_CODES.has(rec.code);
}

/**
 * Network / 5xx / 429 failures that are safe to retry on idempotent reads.
 * GraphQL validation, ACCESS_DENIED, and max-cost errors are not transient.
 */
export function isTransientError(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return false;
  }
  const rec = error as {
    code?: unknown;
    name?: unknown;
    message?: unknown;
    response?: { status?: unknown };
  };
  if (typeof rec.code === "string" && TRANSIENT_NETWORK_CODES.has(rec.code)) {
    return true;
  }
  if (rec.name === "FetchError") {
    return true;
  }
  const message = typeof rec.message === "string" ? rec.message : "";
  if (/fetch failed|socket hang up/i.test(message)) {
    return true;
  }
  const status = rec.response?.status;
  if (typeof status === "number" && (status >= 500 || status === 429)) {
    return true;
  }
  return false;
}

export interface TransientRetryOptions {
  attempts: number;
  delaysMs: number[];
  sleep: (ms: number) => Promise<void>;
}

/**
 * Retry an idempotent read a bounded number of times on transient
 * network / 5xx / 429 failures. Does not retry GraphQL validation,
 * ACCESS_DENIED, or max-cost errors.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  opts: TransientRetryOptions,
): Promise<T> {
  const attempts = Math.max(1, opts.attempts);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || i === attempts - 1) {
        throw err;
      }
      const delay =
        opts.delaysMs[Math.min(i, opts.delaysMs.length - 1)] ?? 0;
      await opts.sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Catch handler that doesn't re-wrap errors already thrown by checkUserErrors.
 * Fixes the double-wrapping bug where "Failed to X: Failed to X: actual message"
 * was produced by every mutation tool.
 *
 * Typed errors (ScopeHorizonError, MissingScopeError, BulkOperationError, or
 * an error whose `code` is in the allow-list) are re-thrown untouched so the
 * MCP host sees the original name, code, and self-contained message.
 */
export function handleToolError(operation: string, error: unknown): never {
  // If the error already has our "Failed to" prefix, re-throw as-is
  if (error instanceof Error && error.message.startsWith("Failed to ")) {
    throw error;
  }
  if (isTypedToolError(error)) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`Failed to ${operation}: ${message}`);
}

/**
 * Extract nodes from a Shopify connection's edges array.
 */
export function edgesToNodes<T>(connection: ShopifyConnection<T>): T[] {
  return connection.edges.map((edge) => edge.node);
}

/**
 * Extract shopMoney from a Shopify MoneyBag (e.g. totalPriceSet.shopMoney).
 */
export function shopMoney(
  moneyBag: { shopMoney: ShopifyMoney } | null | undefined,
): ShopifyMoney | null {
  return moneyBag?.shopMoney ?? null;
}
