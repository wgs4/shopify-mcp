/**
 * I/O for product-order-history: shop timezone, candidate scan, details.
 *
 * Why this exists: get-product-order-history has two GraphQL phases that
 * must not live in the tool file. Phase 1 finds candidate orders whose
 * created_at / updated_at window can produce an in-window event (a
 * 2024 order that shipped today still has to show up). Phase 2 loads
 * fulfillment / refund / return / fulfillment-order lines only for the
 * SKUs that actually match. The counting engine in productOrderHistory.ts
 * is pure; this module is the only one that talks to Shopify.
 *
 * The 60-day `read_orders` wall still applies. Callers must have already
 * decided to run (read_all_orders, or allow_incomplete). We never cancel
 * a bulk operation (see bulkOperations.ts).
 *
 * Pipeline:
 *
 *   since, until, tz
 *        |
 *        v
 *   filter = created_at:<'until+1 midnight' updated_at:>='since midnight'
 *        |
 *        +-- force_bulk OR daysBetween > 90 --> bulkOperationRunQuery
 *        |                                         attachChildren(LineItem)
 *        \-- else --> cursor pages of 25, rawRequest + throttle gate
 *                     lineItems.hasNextPage --> OrderLineItemsPage (never
 *                     undercount: a failed page throws)
 *        |
 *        v
 *   CandidateOrder[]  --lineMatches--> matching ids
 *        |
 *        v
 *   nodes(ids) in batches of 20, document picked by scopes:
 *     none | returns | fulfillmentOrders | both
 *        |
 *        +-- fulfillments/refunds length >= 50 OR any nested hasNextPage
 *        |      --> throw (refusing to undercount)
 *        +-- ACCESS_DENIED --> missingScopeError(field, guessed scope)
 *        \-- else --> RawOrder[] for countUnits
 *
 * Throttle: before each paged rawRequest, if currentlyAvailable is below
 * last requestedQueryCost * 2 + 200, sleep ceil(deficit / restoreRate)
 * seconds (cap 30s). A GraphQL error whose message contains "Throttled"
 * retries up to 3 times at 2s / 4s / 8s.
 */

import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";

import {
  FULFILLMENT_ORDER_SCOPES,
  SCOPE_CACHE_TTL_MS,
  hasScope,
  isAccessDeniedError,
  missingScopeError,
} from "./accessScopes.js";
import {
  attachChildren,
  runBulkQuery,
  type BulkRunResult,
} from "./bulkOperations.js";
import {
  lineMatches,
  type CountParams,
  type RawFulfillment,
  type RawFulfillmentOrder,
  type RawLineItem,
  type RawOrder,
  type RawRefund,
  type RawReturn,
} from "./productOrderHistory.js";
import {
  daysBetween,
  nextDay,
  shopDayStartOffsetIso,
} from "./shopTime.js";

// ── Public constants ────────────────────────────────────────────────────

export const CANDIDATE_PAGE_SIZE = 25;
export const LINE_ITEMS_PAGE_SIZE = 100;
export const DETAILS_BATCH_SIZE = 20;
export const NESTED_LIST_PAGE_LIMIT = 50;
export const THROTTLE_MAX_SLEEP_MS = 30_000;
export const THROTTLE_RETRY_BACKOFF_MS = [2_000, 4_000, 8_000] as const;

export const FO_DETAIL_SCOPES = [
  "read_merchant_managed_fulfillment_orders",
  "read_assigned_fulfillment_orders",
  "read_third_party_fulfillment_orders",
] as const;

const ORDER_FILTER_PLACEHOLDER = "__ORDER_FILTER__";

// ── Deps / test hooks ───────────────────────────────────────────────────

export interface OrderHistoryFetchDeps {
  runBulkQuery?: (
    client: GraphQLClient,
    innerQuery: string,
  ) => Promise<BulkRunResult>;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveDeps(deps: OrderHistoryFetchDeps = {}): {
  runBulkQuery: (
    client: GraphQLClient,
    innerQuery: string,
  ) => Promise<BulkRunResult>;
  sleep: (ms: number) => Promise<void>;
} {
  return {
    runBulkQuery: deps.runBulkQuery ?? runBulkQuery,
    sleep: deps.sleep ?? defaultSleep,
  };
}

// ── Shop timezone cache (WeakMap + TTL, same idea as accessScopes) ──────

const SHOP_TIMEZONE_QUERY = gql`
  #graphql
  query ShopTimezone {
    shop {
      ianaTimezone
    }
  }
`;

interface ShopTimezoneQueryResult {
  shop: { ianaTimezone: string } | null;
}

interface TimezoneCacheEntry {
  tz: string;
  fetchedAt: number;
}

let timezoneCache = new WeakMap<GraphQLClient, TimezoneCacheEntry>();

/** Test hook: drop every cached client. */
export function _resetForTest(): void {
  timezoneCache = new WeakMap();
}

export function invalidateShopTimezone(client: GraphQLClient): void {
  timezoneCache.delete(client);
}

/**
 * Shop IANA timezone (`shop.ianaTimezone`), memoized per GraphQLClient
 * with the same 10-minute TTL as getAccessScopes. Errors propagate; a
 * failed fetch must never look like a hardcoded zone.
 */
export async function getShopTimezone(
  client: GraphQLClient,
  opts?: { force?: boolean; nowMs?: number },
): Promise<string> {
  const nowMs = opts?.nowMs ?? Date.now();
  if (!opts?.force) {
    const hit = timezoneCache.get(client);
    if (hit && nowMs - hit.fetchedAt < SCOPE_CACHE_TTL_MS) {
      return hit.tz;
    }
  }
  const data = await client.request<ShopTimezoneQueryResult>(SHOP_TIMEZONE_QUERY);
  const tz = data?.shop?.ianaTimezone;
  if (typeof tz !== "string" || tz.length === 0) {
    throw new Error("shop.ianaTimezone missing from Shopify response");
  }
  timezoneCache.set(client, { tz, fetchedAt: nowMs });
  return tz;
}

// ── Filter / bulk-vs-cursor selection ───────────────────────────────────

/**
 * Candidate search filter: anything created before the shop-local day
 * after `until` and updated on or after shop-local midnight of `since`.
 * Catches an older order that shipped or refunded inside the window.
 */
export function buildCandidateFilter(
  since: string,
  until: string,
  tz: string,
): string {
  const createdBefore = shopDayStartOffsetIso(nextDay(until), tz);
  const updatedFrom = shopDayStartOffsetIso(since, tz);
  return `created_at:<'${createdBefore}' updated_at:>='${updatedFrom}'`;
}

/** Bulk when forceBulk is set or the inclusive day span is greater than 90. */
export function shouldUseBulk(
  since: string,
  until: string,
  forceBulk: boolean,
): boolean {
  return forceBulk || daysBetween(since, until) > 90;
}

/** Escape double quotes in a search filter before splicing into the bulk query. */
export function escapeBulkFilter(filter: string): string {
  return filter.replace(/"/g, '\\"');
}

export function applyOrderFilter(document: string, filter: string): string {
  return document.split(ORDER_FILTER_PLACEHOLDER).join(escapeBulkFilter(filter));
}

export function chunkIds(
  ids: string[],
  size: number = DETAILS_BATCH_SIZE,
): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

export function hasReturnsScope(scopes: string[]): boolean {
  return hasScope(scopes, "read_returns");
}

export function hasFulfillmentOrderDetailScopes(scopes: string[]): boolean {
  return FO_DETAIL_SCOPES.every((handle) => hasScope(scopes, handle));
}

export function missingFulfillmentOrderScopes(scopes: string[]): string[] {
  return FO_DETAIL_SCOPES.filter((handle) => !hasScope(scopes, handle));
}

// ── Throttle ────────────────────────────────────────────────────────────

export interface ThrottleGate {
  lastRequestedQueryCost: number;
  currentlyAvailable: number;
  restoreRate: number;
  requests: number;
}

export function newThrottleGate(): ThrottleGate {
  return {
    lastRequestedQueryCost: 0,
    currentlyAvailable: Number.POSITIVE_INFINITY,
    restoreRate: 50,
    requests: 0,
  };
}

/**
 * Sleep (ms) before the next paged call. Zero when the budget is enough.
 * Caps at 30 seconds. restoreRate <= 0 is treated as "sleep the cap".
 */
export function throttleDelayMs(
  currentlyAvailable: number,
  lastRequestedQueryCost: number,
  restoreRate: number,
): number {
  const needed = lastRequestedQueryCost * 2 + 200;
  if (currentlyAvailable >= needed) {
    return 0;
  }
  if (!(restoreRate > 0)) {
    return THROTTLE_MAX_SLEEP_MS;
  }
  const seconds = Math.ceil((needed - currentlyAvailable) / restoreRate);
  return Math.min(Math.max(seconds, 0), 30) * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

export function readThrottleExtensions(extensions: unknown): {
  requestedQueryCost: number;
  currentlyAvailable: number;
  restoreRate: number;
} | null {
  const ext = asRecord(extensions);
  const cost = asRecord(ext?.cost);
  if (!cost) {
    return null;
  }
  const requestedQueryCost = Number(cost.requestedQueryCost);
  if (!Number.isFinite(requestedQueryCost)) {
    return null;
  }
  const throttle = asRecord(cost.throttleStatus);
  const currentlyAvailable = Number(throttle?.currentlyAvailable);
  const restoreRate = Number(throttle?.restoreRate);
  return {
    requestedQueryCost,
    currentlyAvailable: Number.isFinite(currentlyAvailable)
      ? currentlyAvailable
      : Number.POSITIVE_INFINITY,
    restoreRate: Number.isFinite(restoreRate) ? restoreRate : 50,
  };
}

function updateThrottleGate(gate: ThrottleGate, extensions: unknown): void {
  const read = readThrottleExtensions(extensions);
  if (!read) {
    return;
  }
  gate.lastRequestedQueryCost = read.requestedQueryCost;
  gate.currentlyAvailable = read.currentlyAvailable;
  gate.restoreRate = read.restoreRate;
}

function mapAccessDenied(field: string | null): Error {
  if (field === "returns") {
    return missingScopeError("returns", "read_returns");
  }
  if (field === "fulfillmentOrders") {
    return missingScopeError("fulfillmentOrders", [...FULFILLMENT_ORDER_SCOPES]);
  }
  return missingScopeError(
    field ?? "the requested field",
    "the required read scope",
  );
}

interface RawRequestResult<T> {
  data?: T;
  extensions?: unknown;
  errors?: Array<{ message?: string }>;
}

function isMissingScopeError(err: unknown): boolean {
  if (err == null || typeof err !== "object") {
    return false;
  }
  const rec = err as { name?: unknown; code?: unknown };
  return rec.name === "MissingScopeError" || rec.code === "MISSING_SCOPE";
}

function throwIfAccessDenied(err: unknown): void {
  const denied = isAccessDeniedError(err);
  if (denied) {
    throw mapAccessDenied(denied.field);
  }
}

async function throttledRawRequest<T>(
  client: GraphQLClient,
  query: string,
  variables: Record<string, unknown> | undefined,
  gate: ThrottleGate,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let retries = 0;
  while (true) {
    const delay = throttleDelayMs(
      gate.currentlyAvailable,
      gate.lastRequestedQueryCost,
      gate.restoreRate,
    );
    if (delay > 0) {
      await sleep(delay);
    }

    let result: RawRequestResult<T>;
    try {
      result = (await client.rawRequest(query, variables)) as RawRequestResult<T>;
    } catch (err) {
      gate.requests += 1;
      if (isMissingScopeError(err)) {
        throw err;
      }
      throwIfAccessDenied(err);
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Throttled") && retries < 3) {
        await sleep(THROTTLE_RETRY_BACKOFF_MS[retries]);
        retries += 1;
        continue;
      }
      throw err;
    }

    gate.requests += 1;
    updateThrottleGate(gate, result.extensions);

    if (Array.isArray(result.errors) && result.errors.length > 0) {
      const message = result.errors
        .map((entry) => entry?.message ?? "GraphQL error")
        .join("; ");
      throwIfAccessDenied({
        message,
        response: { errors: result.errors },
      });
      if (message.includes("Throttled") && retries < 3) {
        await sleep(THROTTLE_RETRY_BACKOFF_MS[retries]);
        retries += 1;
        continue;
      }
      throw new Error(message);
    }
    if (result.data === undefined) {
      throw new Error("GraphQL rawRequest returned no data");
    }
    return result.data;
  }
}

// ── GraphQL documents ───────────────────────────────────────────────────

/**
 * Bulk candidate query. `__ORDER_FILTER__` is replaced at run time.
 * Nested connections (lineItems) become separate JSONL rows; list fields
 * (fulfillments, refunds) stay inlined on the order line.
 */
export const BULK_ORDERS_QUERY = gql`
  #graphql
  query OrderHistoryBulkCandidates {
    orders(query: "__ORDER_FILTER__", sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          createdAt
          processedAt
          updatedAt
          cancelledAt
          cancelReason
          sourceName
          test
          tags
          lineItems {
            edges {
              node {
                id
                sku
                title
                quantity
                currentQuantity
                unfulfilledQuantity
                refundableQuantity
                nonFulfillableQuantity
                product { id }
              }
            }
          }
          fulfillments {
            id
            status
            createdAt
          }
          refunds {
            id
            createdAt
          }
        }
      }
    }
  }
`;

export const ORDER_HISTORY_CANDIDATES_QUERY = gql`
  #graphql
  query OrderHistoryCandidates($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      edges {
        node {
          id
          name
          createdAt
          processedAt
          updatedAt
          cancelledAt
          cancelReason
          sourceName
          test
          tags
          lineItems(first: 25) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                sku
                title
                quantity
                currentQuantity
                unfulfilledQuantity
                refundableQuantity
                nonFulfillableQuantity
                product { id }
              }
            }
          }
          fulfillments {
            id
            status
            createdAt
          }
          refunds {
            id
            createdAt
          }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export const ORDER_LINE_ITEMS_PAGE_QUERY = gql`
  #graphql
  query OrderLineItemsPage($id: ID!, $after: String) {
    order(id: $id) {
      lineItems(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            sku
            title
            quantity
            currentQuantity
            unfulfilledQuantity
            refundableQuantity
            nonFulfillableQuantity
            product { id }
          }
        }
      }
    }
  }
`;

// Four tagged documents so codegen can validate each variant statically.
// Fragments are interpolated at module load; the emitted string is complete.

export const ORDER_HISTORY_DETAILS_NONE = gql`
  #graphql
  query OrderHistoryDetailsNone($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
  fulfillments(first: 50) {
    id
    status
    createdAt
    fulfillmentLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          lineItem { id }
        }
      }
    }
  }
  refunds(first: 50) {
    id
    createdAt
    totalRefundedSet { shopMoney { amount } }
    refundLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          restockType
          subtotalSet { shopMoney { amount } }
          lineItem { id }
        }
      }
    }
  }
      }
    }
  }
`;

export const ORDER_HISTORY_DETAILS_RETURNS = gql`
  #graphql
  query OrderHistoryDetailsReturns($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
  fulfillments(first: 50) {
    id
    status
    createdAt
    fulfillmentLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          lineItem { id }
        }
      }
    }
  }
  refunds(first: 50) {
    id
    createdAt
    totalRefundedSet { shopMoney { amount } }
    refundLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          restockType
          subtotalSet { shopMoney { amount } }
          lineItem { id }
        }
      }
    }
  }
  returns(first: 50) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        status
        createdAt
        returnLineItems(first: 100) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              quantity
              ... on ReturnLineItem {
                fulfillmentLineItem {
                  lineItem { id }
                }
              }
            }
          }
        }
      }
    }
  }
      }
    }
  }
`;

export const ORDER_HISTORY_DETAILS_FO = gql`
  #graphql
  query OrderHistoryDetailsFulfillmentOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
  fulfillments(first: 50) {
    id
    status
    createdAt
    fulfillmentLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          lineItem { id }
        }
      }
    }
  }
  refunds(first: 50) {
    id
    createdAt
    totalRefundedSet { shopMoney { amount } }
    refundLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          restockType
          subtotalSet { shopMoney { amount } }
          lineItem { id }
        }
      }
    }
  }
  fulfillmentOrders(first: 50) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        status
        lineItems(first: 100) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              sku
              totalQuantity
              remainingQuantity
              lineItem { id }
            }
          }
        }
      }
    }
  }
      }
    }
  }
`;

export const ORDER_HISTORY_DETAILS_BOTH = gql`
  #graphql
  query OrderHistoryDetailsBoth($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
  fulfillments(first: 50) {
    id
    status
    createdAt
    fulfillmentLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          lineItem { id }
        }
      }
    }
  }
  refunds(first: 50) {
    id
    createdAt
    totalRefundedSet { shopMoney { amount } }
    refundLineItems(first: 100) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          quantity
          restockType
          subtotalSet { shopMoney { amount } }
          lineItem { id }
        }
      }
    }
  }
  returns(first: 50) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        status
        createdAt
        returnLineItems(first: 100) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              quantity
              ... on ReturnLineItem {
                fulfillmentLineItem {
                  lineItem { id }
                }
              }
            }
          }
        }
      }
    }
  }
  fulfillmentOrders(first: 50) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        status
        lineItems(first: 100) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              sku
              totalQuantity
              remainingQuantity
              lineItem { id }
            }
          }
        }
      }
    }
  }
      }
    }
  }
`;

export function selectDetailsDocument(scopes: string[]): string {
  const returns = hasReturnsScope(scopes);
  const fo = hasFulfillmentOrderDetailScopes(scopes);
  if (returns && fo) {
    return ORDER_HISTORY_DETAILS_BOTH;
  }
  if (returns) {
    return ORDER_HISTORY_DETAILS_RETURNS;
  }
  if (fo) {
    return ORDER_HISTORY_DETAILS_FO;
  }
  return ORDER_HISTORY_DETAILS_NONE;
}

// ── Candidate shapes ────────────────────────────────────────────────────

export interface CandidateOrder {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string;
  updatedAt?: string;
  cancelledAt: string | null;
  cancelReason?: string | null;
  sourceName: string | null;
  test: boolean;
  tags: string[];
  lineItems: RawLineItem[];
  fulfillments: Array<{ id: string; status: string; createdAt: string }>;
  refunds: Array<{ id: string; createdAt: string | null }>;
}

export interface CandidateScanResult {
  orders: CandidateOrder[];
  kind: "bulk" | "cursor";
  bulkOperationId: string | null;
  requests: number;
  query: string;
}

export interface FetchCandidatesArgs {
  since: string;
  until: string;
  tz: string;
  forceBulk?: boolean;
}

interface PageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface Connection<T> {
  pageInfo?: PageInfo | null;
  edges?: Array<{ node?: T | null } | null> | null;
}

function connectionNodes<T>(conn: Connection<T> | null | undefined): T[] {
  const edges = conn?.edges;
  if (!Array.isArray(edges)) {
    return [];
  }
  const nodes: T[] = [];
  for (const edge of edges) {
    if (edge?.node != null) {
      nodes.push(edge.node);
    }
  }
  return nodes;
}

function asNullableString(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  return String(value);
}

function asString(value: unknown, fallback = ""): string {
  if (value == null) {
    return fallback;
  }
  return String(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asNullableNumber(value: unknown): number | null {
  if (value == null || value === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry));
}

function moneyAmount(
  bag: { shopMoney?: { amount?: unknown } } | null | undefined,
): number | null {
  return asNullableNumber(bag?.shopMoney?.amount);
}

export function normalizeLineItem(raw: Record<string, unknown>): RawLineItem {
  const productRaw = asRecord(raw.product);
  return {
    id: asString(raw.id),
    sku: asNullableString(raw.sku),
    title: raw.title == null ? undefined : String(raw.title),
    quantity: asNumber(raw.quantity),
    currentQuantity: asNumber(raw.currentQuantity),
    unfulfilledQuantity: asNumber(raw.unfulfilledQuantity),
    refundableQuantity:
      raw.refundableQuantity == null
        ? undefined
        : asNumber(raw.refundableQuantity),
    nonFulfillableQuantity:
      raw.nonFulfillableQuantity == null
        ? undefined
        : asNumber(raw.nonFulfillableQuantity),
    product:
      productRaw && productRaw.id != null
        ? { id: String(productRaw.id) }
        : null,
  };
}

function lineItemsFromUnknown(value: unknown): RawLineItem[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry != null)
      .map(normalizeLineItem);
  }
  const conn = value as Connection<Record<string, unknown>> | null | undefined;
  return connectionNodes(conn).map((node) => normalizeLineItem(node));
}

function stubFulfillments(
  value: unknown,
): Array<{ id: string; status: string; createdAt: string }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const rec = asRecord(entry) ?? {};
    return {
      id: asString(rec.id),
      status: asString(rec.status),
      createdAt: asString(rec.createdAt),
    };
  });
}

function stubRefunds(
  value: unknown,
): Array<{ id: string; createdAt: string | null }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const rec = asRecord(entry) ?? {};
    return {
      id: asString(rec.id),
      createdAt: asNullableString(rec.createdAt),
    };
  });
}

export function normalizeCandidate(raw: Record<string, unknown>): CandidateOrder {
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    createdAt: asString(raw.createdAt),
    processedAt:
      raw.processedAt == null ? undefined : String(raw.processedAt),
    updatedAt: raw.updatedAt == null ? undefined : String(raw.updatedAt),
    cancelledAt: asNullableString(raw.cancelledAt),
    cancelReason:
      raw.cancelReason == null ? undefined : asNullableString(raw.cancelReason),
    sourceName: asNullableString(raw.sourceName),
    test: Boolean(raw.test),
    tags: asStringArray(raw.tags),
    lineItems: lineItemsFromUnknown(raw.lineItems),
    fulfillments: stubFulfillments(raw.fulfillments),
    refunds: stubRefunds(raw.refunds),
  };
}

/**
 * lineMatches only reads skus / productId. A partial CountParams is enough
 * for candidate matching; dummy fields satisfy the type.
 */
export function matchingLineParams(
  skus?: string[],
  productId?: string,
): CountParams {
  return {
    skus,
    productId,
    since: "1970-01-01",
    until: "1970-01-01",
    tz: "UTC",
    basis: "order",
    groupBy: "none",
    includeTestOrders: true,
    time: {
      localDate: () => "1970-01-01",
      monthKey: () => "1970-01",
      inWindow: () => false,
      months: () => [],
    },
    asOf: "1970-01-01T00:00:00.000Z",
    fulfillmentOrderScopesComplete: false,
  };
}

export function candidateMatches(
  order: CandidateOrder,
  skus?: string[],
  productId?: string,
): boolean {
  const params = matchingLineParams(skus, productId);
  return order.lineItems.some((line) => lineMatches(line, params));
}

// ── Phase 1: candidates ─────────────────────────────────────────────────

interface CandidateNode {
  id?: unknown;
  name?: unknown;
  createdAt?: unknown;
  processedAt?: unknown;
  updatedAt?: unknown;
  cancelledAt?: unknown;
  cancelReason?: unknown;
  sourceName?: unknown;
  test?: unknown;
  tags?: unknown;
  lineItems?: Connection<Record<string, unknown>>;
  fulfillments?: unknown;
  refunds?: unknown;
}

interface CandidatesQueryData {
  orders?: {
    edges?: Array<{ node?: CandidateNode | null } | null> | null;
    pageInfo?: PageInfo | null;
  } | null;
}

interface LineItemsPageData {
  order?: {
    lineItems?: Connection<Record<string, unknown>> | null;
  } | null;
}

async function fetchRemainingLineItems(
  client: GraphQLClient,
  orderId: string,
  after: string,
  gate: ThrottleGate,
  sleep: (ms: number) => Promise<void>,
): Promise<RawLineItem[]> {
  const extra: RawLineItem[] = [];
  let cursor: string | null = after;
  while (cursor) {
    const data: LineItemsPageData = await throttledRawRequest<LineItemsPageData>(
      client,
      ORDER_LINE_ITEMS_PAGE_QUERY,
      { id: orderId, after: cursor },
      gate,
      sleep,
    );
    if (data.order == null) {
      throw new Error(
        `Order ${orderId} disappeared while paging line items; refusing to undercount`,
      );
    }
    extra.push(...lineItemsFromUnknown(data.order.lineItems));
    const pageInfo: PageInfo | null | undefined = data.order.lineItems?.pageInfo;
    if (pageInfo?.hasNextPage) {
      if (!pageInfo.endCursor) {
        throw new Error(
          `Order ${orderId} lineItems hasNextPage is true but endCursor is missing; refusing to undercount`,
        );
      }
      cursor = pageInfo.endCursor;
    } else {
      cursor = null;
    }
  }
  return extra;
}

async function fetchCandidatesCursor(
  client: GraphQLClient,
  filter: string,
  sleep: (ms: number) => Promise<void>,
): Promise<{ orders: CandidateOrder[]; requests: number }> {
  const gate = newThrottleGate();
  const orders: CandidateOrder[] = [];
  let after: string | null = null;

  while (true) {
    const variables: Record<string, unknown> = {
      first: CANDIDATE_PAGE_SIZE,
      query: filter,
    };
    if (after) {
      variables.after = after;
    }
    const data = await throttledRawRequest<CandidatesQueryData>(
      client,
      ORDER_HISTORY_CANDIDATES_QUERY,
      variables,
      gate,
      sleep,
    );
    const connection = data.orders;
    if (!connection) {
      throw new Error("OrderHistoryCandidates returned no orders connection");
    }
    for (const edge of connection.edges ?? []) {
      const node = edge?.node;
      if (!node) {
        continue;
      }
      const candidate = normalizeCandidate(node as Record<string, unknown>);
      const pageInfo = node.lineItems?.pageInfo;
      if (pageInfo?.hasNextPage) {
        if (!pageInfo.endCursor) {
          throw new Error(
            `Order ${candidate.name} lineItems hasNextPage is true but endCursor is missing; refusing to undercount`,
          );
        }
        const rest = await fetchRemainingLineItems(
          client,
          candidate.id,
          pageInfo.endCursor,
          gate,
          sleep,
        );
        candidate.lineItems = candidate.lineItems.concat(rest);
      }
      orders.push(candidate);
    }
    if (!connection.pageInfo?.hasNextPage) {
      break;
    }
    if (!connection.pageInfo.endCursor) {
      throw new Error(
        "orders pageInfo.hasNextPage is true but endCursor is missing; refusing to undercount",
      );
    }
    after = connection.pageInfo.endCursor;
  }

  return { orders, requests: gate.requests };
}

async function fetchCandidatesBulk(
  client: GraphQLClient,
  filter: string,
  runBulk: (
    client: GraphQLClient,
    innerQuery: string,
  ) => Promise<BulkRunResult>,
): Promise<{
  orders: CandidateOrder[];
  bulkOperationId: string;
  requests: number;
}> {
  const innerQuery = applyOrderFilter(BULK_ORDERS_QUERY, filter);
  const result = await runBulk(client, innerQuery);
  const attached = attachChildren<Record<string, unknown>>(
    result.rows,
    "lineItems",
    "LineItem",
  );
  return {
    orders: attached.map(normalizeCandidate),
    bulkOperationId: result.id,
    requests: result.polls,
  };
}

export async function fetchCandidates(
  client: GraphQLClient,
  args: FetchCandidatesArgs,
  deps?: OrderHistoryFetchDeps,
): Promise<CandidateScanResult> {
  const resolved = resolveDeps(deps);
  const filter = buildCandidateFilter(args.since, args.until, args.tz);
  const useBulk = shouldUseBulk(args.since, args.until, args.forceBulk === true);
  if (useBulk) {
    const bulk = await fetchCandidatesBulk(
      client,
      filter,
      resolved.runBulkQuery,
    );
    return {
      orders: bulk.orders,
      kind: "bulk",
      bulkOperationId: bulk.bulkOperationId,
      requests: bulk.requests,
      query: filter,
    };
  }
  const cursor = await fetchCandidatesCursor(client, filter, resolved.sleep);
  return {
    orders: cursor.orders,
    kind: "cursor",
    bulkOperationId: null,
    requests: cursor.requests,
    query: filter,
  };
}

// ── Phase 2: details ────────────────────────────────────────────────────

interface DetailFulfillmentNode {
  id?: unknown;
  status?: unknown;
  createdAt?: unknown;
  fulfillmentLineItems?: Connection<{
    quantity?: unknown;
    lineItem?: { id?: unknown } | null;
  }> | null;
}

interface DetailRefundNode {
  id?: unknown;
  createdAt?: unknown;
  totalRefundedSet?: { shopMoney?: { amount?: unknown } } | null;
  refundLineItems?: Connection<{
    quantity?: unknown;
    restockType?: unknown;
    subtotalSet?: { shopMoney?: { amount?: unknown } } | null;
    lineItem?: { id?: unknown } | null;
  }> | null;
}

interface DetailReturnNode {
  id?: unknown;
  status?: unknown;
  createdAt?: unknown;
  returnLineItems?: Connection<{
    quantity?: unknown;
    fulfillmentLineItem?: { lineItem?: { id?: unknown } | null } | null;
  }> | null;
}

interface DetailFoNode {
  id?: unknown;
  status?: unknown;
  lineItems?: Connection<{
    sku?: unknown;
    totalQuantity?: unknown;
    remainingQuantity?: unknown;
    lineItem?: { id?: unknown } | null;
  }> | null;
}

export interface DetailOrderNode {
  id?: unknown;
  name?: unknown;
  fulfillments?: DetailFulfillmentNode[] | null;
  refunds?: DetailRefundNode[] | null;
  returns?: Connection<DetailReturnNode> | null;
  fulfillmentOrders?: Connection<DetailFoNode> | null;
}

interface DetailsQueryData {
  nodes?: Array<DetailOrderNode | null> | null;
}

function pageHasNext(pageInfo?: PageInfo | null): boolean {
  return pageInfo?.hasNextPage === true;
}

function nestedPageError(orderName: string): Error {
  return new Error(
    `Order ${orderName} has more nested records than one page; refusing to undercount`,
  );
}

export function assertSingleDetailsPage(
  orderName: string,
  detail: DetailOrderNode,
): void {
  const fulfillments = detail.fulfillments ?? [];
  const refunds = detail.refunds ?? [];
  if (
    fulfillments.length >= NESTED_LIST_PAGE_LIMIT ||
    refunds.length >= NESTED_LIST_PAGE_LIMIT
  ) {
    throw nestedPageError(orderName);
  }
  for (const fulfillment of fulfillments) {
    if (pageHasNext(fulfillment.fulfillmentLineItems?.pageInfo)) {
      throw nestedPageError(orderName);
    }
  }
  for (const refund of refunds) {
    if (pageHasNext(refund.refundLineItems?.pageInfo)) {
      throw nestedPageError(orderName);
    }
  }
  if (detail.returns) {
    if (pageHasNext(detail.returns.pageInfo)) {
      throw nestedPageError(orderName);
    }
    for (const node of connectionNodes(detail.returns)) {
      if (pageHasNext(node.returnLineItems?.pageInfo)) {
        throw nestedPageError(orderName);
      }
    }
  }
  if (detail.fulfillmentOrders) {
    if (pageHasNext(detail.fulfillmentOrders.pageInfo)) {
      throw nestedPageError(orderName);
    }
    for (const node of connectionNodes(detail.fulfillmentOrders)) {
      if (pageHasNext(node.lineItems?.pageInfo)) {
        throw nestedPageError(orderName);
      }
    }
  }
}

function mapFulfillments(nodes: DetailFulfillmentNode[] | null | undefined): RawFulfillment[] {
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes.map((node) => ({
    id: asString(node.id),
    status: asString(node.status),
    createdAt: asString(node.createdAt),
    lineItems: connectionNodes(node.fulfillmentLineItems).map((li) => ({
      quantity: asNullableNumber(li.quantity),
      lineItemId: asString(li.lineItem?.id),
    })),
  }));
}

function mapRefunds(nodes: DetailRefundNode[] | null | undefined): RawRefund[] {
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes.map((node) => ({
    id: asString(node.id),
    createdAt: asNullableString(node.createdAt),
    totalRefundedAmount: moneyAmount(node.totalRefundedSet),
    lineItems: connectionNodes(node.refundLineItems).map((li) => ({
      quantity: asNumber(li.quantity),
      restockType: asString(li.restockType),
      lineItemId: asString(li.lineItem?.id),
      subtotalAmount: moneyAmount(li.subtotalSet),
    })),
  }));
}

function mapReturns(conn: Connection<DetailReturnNode> | null | undefined): RawReturn[] {
  return connectionNodes(conn).map((node) => ({
    id: asString(node.id),
    status: asString(node.status),
    createdAt: asString(node.createdAt),
    lineItems: connectionNodes(node.returnLineItems).map((li) => ({
      quantity: asNumber(li.quantity),
      lineItemId: asNullableString(li.fulfillmentLineItem?.lineItem?.id),
    })),
  }));
}

function mapFulfillmentOrders(
  conn: Connection<DetailFoNode> | null | undefined,
): RawFulfillmentOrder[] {
  return connectionNodes(conn).map((node) => ({
    id: asString(node.id),
    status: asString(node.status),
    lineItems: connectionNodes(node.lineItems).map((li) => ({
      lineItemId: asString(li.lineItem?.id),
      sku: asNullableString(li.sku),
      totalQuantity: asNumber(li.totalQuantity),
      remainingQuantity: asNumber(li.remainingQuantity),
    })),
  }));
}

export function mapDetailNodeToRawOrder(
  candidate: CandidateOrder,
  detail: DetailOrderNode,
  opts: { includeReturns: boolean; includeFulfillmentOrders: boolean },
): RawOrder {
  return {
    id: candidate.id,
    name: candidate.name,
    createdAt: candidate.createdAt,
    processedAt: candidate.processedAt,
    cancelledAt: candidate.cancelledAt,
    cancelReason: candidate.cancelReason,
    sourceName: candidate.sourceName,
    test: candidate.test,
    tags: candidate.tags,
    lineItems: candidate.lineItems,
    fulfillments: mapFulfillments(detail.fulfillments),
    refunds: mapRefunds(detail.refunds),
    returns: opts.includeReturns ? mapReturns(detail.returns) : null,
    fulfillmentOrders: opts.includeFulfillmentOrders
      ? mapFulfillmentOrders(detail.fulfillmentOrders)
      : null,
  };
}

export interface OrderDetailsResult {
  orders: RawOrder[];
  requests: number;
}

export async function fetchOrderDetails(
  client: GraphQLClient,
  orders: CandidateOrder[],
  scopes: string[],
  deps?: OrderHistoryFetchDeps,
): Promise<OrderDetailsResult> {
  if (orders.length === 0) {
    return { orders: [], requests: 0 };
  }
  const resolved = resolveDeps(deps);
  const document = selectDetailsDocument(scopes);
  const includeReturns = hasReturnsScope(scopes);
  const includeFulfillmentOrders = hasFulfillmentOrderDetailScopes(scopes);
  const gate = newThrottleGate();
  const byId = new Map<string, DetailOrderNode>();
  const ids = orders.map((order) => order.id);

  for (const chunk of chunkIds(ids, DETAILS_BATCH_SIZE)) {
    const data = await throttledRawRequest<DetailsQueryData>(
      client,
      document,
      { ids: chunk },
      gate,
      resolved.sleep,
    );
    const nodes = data.nodes ?? [];
    for (const node of nodes) {
      if (node && node.id != null) {
        byId.set(String(node.id), node);
      }
    }
  }

  const rawOrders: RawOrder[] = [];
  for (const candidate of orders) {
    const detail = byId.get(candidate.id);
    if (!detail) {
      throw new Error(
        `Order ${candidate.name} missing from details response; refusing to undercount`,
      );
    }
    assertSingleDetailsPage(candidate.name, detail);
    rawOrders.push(
      mapDetailNodeToRawOrder(candidate, detail, {
        includeReturns,
        includeFulfillmentOrders,
      }),
    );
  }

  return { orders: rawOrders, requests: gate.requests };
}
