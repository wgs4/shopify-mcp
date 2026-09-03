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

/**
 * True for typed errors that the MCP host should see unwrapped: named
 * ScopeHorizonError / MissingScopeError / BulkOperationError, or any
 * object with a string `code` property (the typed-error convention used
 * by those classes and by missingScopeError).
 */
function isTypedToolError(error: unknown): boolean {
  if (error == null || typeof error !== "object") {
    return false;
  }
  const rec = error as { name?: unknown; code?: unknown };
  if (typeof rec.name === "string" && TYPED_ERROR_NAMES.has(rec.name)) {
    return true;
  }
  return typeof rec.code === "string";
}

/**
 * Catch handler that doesn't re-wrap errors already thrown by checkUserErrors.
 * Fixes the double-wrapping bug where "Failed to X: Failed to X: actual message"
 * was produced by every mutation tool.
 *
 * Typed errors (ScopeHorizonError, MissingScopeError, BulkOperationError, or
 * any error with a string `code`) are re-thrown untouched so the MCP host
 * sees the original name, code, and self-contained message.
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
