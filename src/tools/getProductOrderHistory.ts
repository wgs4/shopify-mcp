/**
 * get-product-order-history: per-SKU / per-product unit counts on each
 * event's own clock, fail-closed at the 60-day order wall.
 *
 * Why this exists: royalty, commission, and acceptance checks need
 * "how many of SKU X shipped (or refunded, or returned) in this shop-local
 * window", not "orders created in this window". Mixing those clocks, or
 * silently dropping pre-horizon orders, produces numbers that look
 * authoritative and are wrong. This tool is the MCP surface: validate
 * input, enforce the wall, fetch, count, return a self-describing payload.
 *
 * Pipeline:
 *
 *   skus XOR productId, since, until
 *        |
 *        v
 *   scopes + shop tz + shop-local window
 *        |
 *        +-- no read_all_orders, no allow_incomplete
 *        |      before horizon -> ScopeHorizonError (before_horizon)
 *        |      any window    -> ScopeHorizonError (visibility_indeterminate)
 *        |      (an older order shipped/refunded in-window would be missed)
 *        +-- allow_incomplete -> completeness.partial + INCOMPLETE warning
 *        \-- read_all_orders  -> completeness.complete
 *        |
 *        v
 *   fetchCandidates -> lineMatches -> fetchOrderDetails -> countUnits
 *        |
 *        v
 *   top-level totals + horizon + source + warnings
 */

import type { GraphQLClient } from "graphql-request";
import { z } from "zod";

import { getAccessScopes, hasScope } from "../lib/accessScopes.js";
import {
  fetchCandidates,
  fetchOrderDetails,
  getOldestVisibleOrderCreatedAt,
  getShopTimezone,
  candidateMatches,
  hasFulfillmentOrderDetailScopes,
  missingFulfillmentOrderScopes,
  type OrderHistoryFetchDeps,
} from "../lib/orderHistoryFetch.js";
import {
  READ_ALL_ORDERS,
  ScopeHorizonError,
  assertRangeVisible,
  completenessInfo,
  earliestAcceptedBoundAdvice,
  horizonInfo,
} from "../lib/orderWall.js";
import {
  countUnits,
  type Basis,
  type GroupBy,
} from "../lib/productOrderHistory.js";
import {
  buildShopWindow,
  inWindow,
  isValidDate,
  localDate,
  monthKey,
  monthsBetween,
} from "../lib/shopTime.js";
import { handleToolError } from "../lib/toolUtils.js";

const GetProductOrderHistoryObjectSchema = z.object({
  skus: z
    .array(z.string().min(1))
    .min(1)
    .max(20)
    .optional()
    .describe(
      "Exact, case-insensitive match on each line item's recorded SKU (not the variant's current SKU); pass every historical SKU of the product, max 20",
    ),
  productId: z
    .string()
    .min(1)
    .optional()
    .describe("Numeric or gid product id; matches lineItem.product.id"),
  since: z
    .string()
    .refine((value) => isValidDate(value), {
      message: "since must be a valid YYYY-MM-DD date",
    })
    .describe("YYYY-MM-DD in the shop timezone, inclusive"),
  until: z
    .string()
    .refine((value) => isValidDate(value), {
      message: "until must be a valid YYYY-MM-DD date",
    })
    .describe("YYYY-MM-DD in the shop timezone, inclusive"),
  basis: z
    .enum(["fulfillment", "order", "refund"])
    .default("fulfillment")
    .describe(
      "Which event dates an order into `orders` (unit totals are unaffected): fulfillment = a SUCCESS fulfillment containing the SKU, order = order createdAt, refund = a refund containing the SKU",
    ),
  group_by: z
    .enum(["none", "month", "channel"])
    .default("none")
    .describe(
      "month = every metric bucketed by its own event month in the shop timezone, zero-filled; channel = order.sourceName",
    ),
  include_test_orders: z
    .boolean()
    .default(false)
    .describe("Count test orders (default: exclude them)"),
  include_orders: z
    .boolean()
    .default(false)
    .describe(
      "Return per-order evidence rows (capped at 500; see orders_truncated and matched_orders)",
    ),
  allow_incomplete: z
    .boolean()
    .default(false)
    .describe(
      "Without read_all_orders the tool fails closed; set true to run anyway with completeness.status=partial and horizon_ok=false (never use such output as historical acceptance)",
    ),
  force_bulk: z
    .boolean()
    .default(false)
    .describe("Use a bulk operation even when the window is 90 days or less"),
});

const GetProductOrderHistoryInputSchema =
  GetProductOrderHistoryObjectSchema.refine(
    (value) => {
      const hasSkus = Array.isArray(value.skus) && value.skus.length > 0;
      const hasProduct =
        typeof value.productId === "string" && value.productId.length > 0;
      return hasSkus !== hasProduct;
    },
    { message: "exactly one of skus or productId is required" },
  ).refine((value) => value.until >= value.since, {
    message: "until must be >= since",
  });

type GetProductOrderHistoryInput = z.infer<
  typeof GetProductOrderHistoryInputSchema
>;

let shopifyClient: GraphQLClient;

function visibilityIndeterminateError(
  scopes: string[],
  since: string,
  until: string,
  tz: string,
  nowMs: number,
): ScopeHorizonError {
  const info = horizonInfo(scopes, nowMs, tz);
  const err = new ScopeHorizonError({
    missing: READ_ALL_ORDERS,
    horizon: info.horizon,
    horizonShopDate: info.horizon_shop_date,
    requestedSince: since,
    requestedUntil: until,
    reason: "visibility_indeterminate",
    visibleFrom: info.horizon,
  });
  err.message =
    `ScopeHorizonError: read_all_orders is missing, so orders created before ${info.first_visible_date} are hidden ` +
    `and any window can be incomplete (an older order shipped or refunded ` +
    `inside the window would be missed). Pass allow_incomplete=true to run ` +
    `anyway with completeness.status=partial. ` +
    earliestAcceptedBoundAdvice(info.horizon);
  return err;
}

const getProductOrderHistory = {
  name: "get-product-order-history",
  description:
    "Count units ordered, shipped, cancelled, refunded, returned, and unfulfilled for specific SKUs or one product over a shop-local date window. " +
    "Each metric uses its OWN clock: units_ordered on order createdAt, units_shipped on SUCCESS fulfillment createdAt, units_refunded on refund createdAt, units_cancelled on cancelledAt, units_returned on CLOSED return createdAt. " +
    "The window [since, until] is inclusive calendar dates in the shop timezone (shop.ianaTimezone), never UTC and never hardcoded. " +
    "Without read_all_orders, orders created more than 60 days ago are invisible (HTTP 200, empty). This tool fails closed with ScopeHorizonError unless allow_incomplete=true, in which case completeness.status is partial and warnings[0] starts with INCOMPLETE. An older order that shipped or refunded inside the window would still be missed. " +
    "units_returned is null when the token lacks read_returns (refunds are still reported). Pass include_orders=true for per-order evidence. force_bulk uses a Shopify bulk operation instead of cursor pagination.",
  schema: GetProductOrderHistoryObjectSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (
    input: Record<string, unknown> | GetProductOrderHistoryInput,
    deps?: OrderHistoryFetchDeps,
  ) => {
    try {
      const nowMs = Date.now();
      const parsed = GetProductOrderHistoryInputSchema.parse(input);
      const {
        skus,
        productId,
        since,
        until,
        basis,
        group_by: groupBy,
        include_test_orders: includeTestOrders,
        include_orders: includeOrders,
        allow_incomplete: allowIncomplete,
        force_bulk: forceBulk,
      } = parsed;

      const scopes = await getAccessScopes(shopifyClient);
      const tz = await getShopTimezone(shopifyClient);
      const window = buildShopWindow(since, until, tz);
      const asOf = new Date(nowMs).toISOString();

      let completeness: {
        status: "complete" | "partial";
        reason: "read_all_orders_missing" | null;
        visible_from: string | null;
      };
      const leadWarnings: string[] = [];

      if (!hasScope(scopes, READ_ALL_ORDERS)) {
        if (!allowIncomplete) {
          assertRangeVisible({
            scopes,
            sinceIso: window.startIso,
            untilIso: window.endIso,
            nowMs,
            tz,
            requestedSince: since,
            requestedUntil: until,
          });
          throw visibilityIndeterminateError(scopes, since, until, tz, nowMs);
        }
        completeness = completenessInfo(scopes, nowMs);
        const visibleFrom = completeness.visible_from ?? "the 60-day horizon";
        leadWarnings.push(
          `INCOMPLETE: read_all_orders missing; orders created before ${visibleFrom} are invisible; counts are partial and must not be used as historical acceptance`,
        );
      } else {
        completeness = { status: "complete", reason: null, visible_from: null };
      }

      const scan = await fetchCandidates(
        shopifyClient,
        { since, until, tz, forceBulk },
        deps,
      );

      const matching = scan.orders.filter((order) =>
        candidateMatches(order, skus, productId),
      );

      const details = await fetchOrderDetails(
        shopifyClient,
        matching,
        scopes,
        deps,
      );

      const foComplete = hasFulfillmentOrderDetailScopes(scopes);
      const result = countUnits(details.orders, {
        skus,
        productId,
        since,
        until,
        tz,
        basis: basis as Basis,
        groupBy: groupBy as GroupBy,
        includeTestOrders,
        evidenceLimit: 500,
        time: {
          localDate: (iso) => localDate(iso, tz),
          monthKey: (iso) => monthKey(iso, tz),
          inWindow: (iso) => inWindow(iso, window),
          months: () => monthsBetween(since, until),
        },
        asOf,
        fulfillmentOrderScopesComplete: foComplete,
        missingFulfillmentOrderScopes: missingFulfillmentOrderScopes(scopes),
        returnsScopeComplete: hasScope(scopes, "read_returns"),
      });

      const warnings = leadWarnings.concat(result.warnings);
      const oldestVisible = await getOldestVisibleOrderCreatedAt(
        shopifyClient,
        { nowMs },
      );
      const horizon = {
        ...horizonInfo(scopes, nowMs, tz),
        oldest_visible_order_created_at: oldestVisible,
      };

      const response: Record<string, unknown> = {
        store: process.env.MYSHOPIFY_DOMAIN ?? "",
      };
      if (skus) {
        response.skus = skus;
      } else {
        response.product_id = productId;
      }
      response.since = since;
      response.until = until;
      response.timezone = tz;
      response.basis = basis;
      response.group_by = groupBy;
      response.units_ordered = result.totals.units_ordered;
      response.units_ordered_current = result.totals.units_ordered_current;
      response.units_shipped = result.totals.units_shipped;
      response.units_cancelled = result.totals.units_cancelled;
      response.units_refunded = result.totals.units_refunded;
      response.refunded_amount = result.totals.refunded_amount;
      response.units_returned = result.totals.units_returned;
      response.units_unfulfilled = result.totals.units_unfulfilled;
      response.orders = result.totals.orders;
      response.matched_orders = result.matched_orders;
      response.horizon_ok = completeness.status === "complete";
      response.completeness = completeness;
      response.horizon = horizon;
      response.source = {
        kind: scan.kind,
        bulk_operation_id: scan.bulkOperationId,
        candidate_orders: scan.orders.length,
        requests: scan.requests + details.requests,
        query: scan.query,
        max_requested_query_cost: Math.max(
          scan.maxRequestedQueryCost,
          details.maxRequestedQueryCost,
        ),
      };
      response.reconciliation = result.reconciliation;
      response.buckets = result.buckets;
      response.warnings = warnings;
      if (includeOrders) {
        response.orders_evidence = result.orders_evidence;
      }
      response.orders_truncated = result.orders_truncated;
      return response;
    } catch (error) {
      handleToolError("compute product order history", error);
    }
  },
};

export { getProductOrderHistory };
