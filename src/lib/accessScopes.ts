/**
 * App access-scope cache and implication helpers.
 *
 * Why this exists: every order-history call needs to know whether
 * `read_all_orders` (and fulfillment-order / returns scopes) are granted.
 * `currentAppInstallation { accessScopes { handle } }` is the source of
 * truth, but it is an extra Admin API round-trip. We memoize per
 * GraphQLClient in a WeakMap with a 10-minute TTL so a burst of list
 * tools in one session does not stampede the endpoint. Errors propagate
 * (a failed scope fetch must never look like "no scopes").
 *
 * Implication: Shopify may return `write_orders` without `read_orders`;
 * a write_* handle implies its read_* twin. `read_all_orders` has no
 * write twin.
 *
 * Pipeline:
 *
 *   getAccessScopes(client)
 *        |
 *        +-- WeakMap hit and nowMs - fetchedAt < TTL --> cached handles
 *        +-- miss / force / expired ------------------> request CurrentAccessScopes
 *                                                       store { handles, fetchedAt }
 *
 *   hasScope(handles, "read_X")
 *        +-- "read_X" in handles ----> true
 *        +-- "write_X" in handles ---> true
 *        \-- else -------------------> false
 */

import type { GraphQLClient } from "graphql-request";

export interface AccessScopesResult {
  handles: string[];
  fetchedAt: number;
}

export const SCOPE_CACHE_TTL_MS = 10 * 60 * 1000;

export const FULFILLMENT_ORDER_SCOPES = [
  "read_merchant_managed_fulfillment_orders",
  "read_assigned_fulfillment_orders",
  "read_third_party_fulfillment_orders",
] as const;

const CURRENT_ACCESS_SCOPES_QUERY = `#graphql
 query CurrentAccessScopes { currentAppInstallation { accessScopes { handle } } }`;

interface AccessScopesQueryResult {
  currentAppInstallation: {
    accessScopes: Array<{ handle: string }>;
  } | null;
}

let cache = new WeakMap<GraphQLClient, AccessScopesResult>();

/** Test hook: drop every cached client. */
export function _resetForTest(): void {
  cache = new WeakMap();
}

export function invalidateAccessScopes(client: GraphQLClient): void {
  cache.delete(client);
}

export async function getAccessScopes(
  client: GraphQLClient,
  opts?: { force?: boolean; nowMs?: number },
): Promise<string[]> {
  const nowMs = opts?.nowMs ?? Date.now();
  if (!opts?.force) {
    const hit = cache.get(client);
    if (hit && nowMs - hit.fetchedAt < SCOPE_CACHE_TTL_MS) {
      return hit.handles;
    }
  }
  const data = await client.request<AccessScopesQueryResult>(
    CURRENT_ACCESS_SCOPES_QUERY,
  );
  if (
    data == null ||
    data.currentAppInstallation == null ||
    !Array.isArray(data.currentAppInstallation.accessScopes)
  ) {
    throw new Error(
      "currentAppInstallation.accessScopes missing from Shopify response",
    );
  }
  const handles = data.currentAppInstallation.accessScopes.map(
    (row) => row.handle,
  );
  cache.set(client, { handles, fetchedAt: nowMs });
  return handles;
}

/**
 * True if `handle` is granted, or if it is a read_* handle whose write_*
 * twin is granted.
 */
export function hasScope(handles: string[], handle: string): boolean {
  if (handles.includes(handle)) {
    return true;
  }
  if (handle.startsWith("read_")) {
    const writeTwin = `write_${handle.slice("read_".length)}`;
    return handles.includes(writeTwin);
  }
  return false;
}

export function hasAnyScope(
  handles: string[],
  candidates: readonly string[],
): boolean {
  return candidates.some((handle) => hasScope(handles, handle));
}

export function missingScopeError(
  field: string,
  scopes: string | string[],
): Error {
  const isList = Array.isArray(scopes);
  const list = isList ? scopes.join(", ") : scopes;
  const message =
    isList && scopes.length > 1
      ? `Access denied for ${field}: this app's token lacks the fulfillment-order scopes (${list}). Add them to app shop-wgs-mcp-8-6-26 and re-authorize the store.`
      : `Access denied for ${field}: this app's token lacks ${list}. Add the scope to app shop-wgs-mcp-8-6-26 and re-authorize the store.`;
  const err = new Error(message);
  err.name = "MissingScopeError";
  (err as Error & { code: string }).code = "MISSING_SCOPE";
  return err;
}

interface GraphQLErrorLike {
  message?: string;
  extensions?: { code?: string };
}

interface ClientErrorLike {
  message?: string;
  response?: { errors?: GraphQLErrorLike[] };
}

function fieldFromAccessDeniedMessage(message: string): string | null {
  const match = /^Access denied for (.+?) field\.?$/i.exec(message.trim());
  return match ? match[1] : null;
}

function inspectAccessDeniedMessage(
  message: string,
  code?: string,
): { field: string | null } | null {
  if (code === "ACCESS_DENIED" || message.startsWith("Access denied for")) {
    return { field: fieldFromAccessDeniedMessage(message) };
  }
  return null;
}

/**
 * Duck-types graphql-request ClientError: `err.response.errors[]` with
 * extensions.code === "ACCESS_DENIED" or a message starting
 * "Access denied for". Returns the field parsed from
 * "Access denied for X field." when possible.
 */
export function isAccessDeniedError(
  err: unknown,
): { field: string | null } | null {
  if (err == null || typeof err !== "object") {
    return null;
  }
  const like = err as ClientErrorLike;
  const errors = like.response?.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const message = typeof entry?.message === "string" ? entry.message : "";
      const code = entry?.extensions?.code;
      const hit = inspectAccessDeniedMessage(message, code);
      if (hit) {
        return hit;
      }
    }
  }
  if (typeof like.message === "string") {
    return inspectAccessDeniedMessage(like.message);
  }
  return null;
}