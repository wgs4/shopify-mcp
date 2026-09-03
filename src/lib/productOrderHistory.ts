/**
 * Pure per-SKU / per-product unit counting engine.
 *
 * Why this exists: product-order-history tools need one place that turns a
 * pile of already-fetched orders into units ordered / shipped / cancelled /
 * refunded / returned / unfulfilled, with each metric on its OWN clock. The
 * Shopify Admin order graph mixes those clocks on a single Order node
 * (createdAt vs fulfillment.createdAt vs refund.createdAt vs cancelledAt),
 * and shop-local calendar days are not UTC. This module stays independent
 * of GraphQL, I/O, and the timezone helper: a TimeAdapter is injected so
 * every date decision is deferred to the caller. The engine never parses
 * instants with Date and never hardcodes a shop timezone.
 *
 * Pipeline (window is half-open [since 00:00, until+1 00:00) in shop tz):
 *
 *   RawOrder[]
 *        |  drop test orders unless includeTestOrders
 *        |  drop orders with no lineMatches() line
 *        v
 *   matched orders --------------------------------+
 *        |                                         |
 *        |  per matching line / nested event       |  evidence (capped)
 *        v                                         v
 *   +----------+----------+----------+      OrderEvidence[]
 *   | created  | SUCCESS  | refund/  |
 *   |  clock   | fulfill  | return   |
 *   |          |  clock   |  clock   |
 *   +----------+----------+----------+
 *        |          |          |
 *        +-----+----+-----+----+
 *              v          v
 *           totals    buckets (none | month via TimeAdapter.months | channel)
 *              |
 *              v
 *        reconciliation
 *          cancel-after-ship (min(shipped_gross in window, refunds ANY date))
 *          unattributed shipped / refunded
 *          FO remaining cross-check (only with complete scopes + data)
 *
 * Cancel-after-ship is an order-level adjustment, not a fulfillment-status
 * change: a SUCCESS fulfillment stays in shipped_gross even if the order is
 * later cancelled; units_shipped subtracts min(that order's in-window gross,
 * matching refund units known as of query time). A refund dated AFTER the
 * window still reduces units_shipped.
 */

// ── Time ────────────────────────────────────────────────────────────────

export interface TimeAdapter {
  /** YYYY-MM-DD in shop tz. */
  localDate(iso: string): string;
  /** YYYY-MM in shop tz. */
  monthKey(iso: string): string;
  /**
   * Half-open [since 00:00, until+1 00:00) shop-local.
   * null / undefined -> false.
   */
  inWindow(iso: string | null | undefined): boolean;
  /** Every YYYY-MM from since to until inclusive. */
  months(): string[];
}

// ── Raw input shapes ────────────────────────────────────────────────────

export interface RawLineItem {
  id: string;
  sku: string | null;
  title?: string;
  quantity: number;
  currentQuantity: number;
  unfulfilledQuantity: number;
  refundableQuantity?: number;
  nonFulfillableQuantity?: number;
  product?: { id: string } | null;
}

export interface RawFulfillmentLineItem {
  quantity: number | null;
  lineItemId: string;
}

export interface RawFulfillment {
  id: string;
  status: string;
  createdAt: string;
  lineItems: RawFulfillmentLineItem[];
}

export interface RawRefundLineItem {
  quantity: number;
  restockType: string;
  lineItemId: string;
  subtotalAmount: number | null;
}

export interface RawRefund {
  id: string;
  createdAt: string | null;
  totalRefundedAmount: number | null;
  lineItems: RawRefundLineItem[];
}

export interface RawReturnLineItem {
  quantity: number;
  lineItemId: string | null;
}

export interface RawReturn {
  id: string;
  status: string;
  createdAt: string;
  lineItems: RawReturnLineItem[];
}

export interface RawFulfillmentOrderLineItem {
  lineItemId: string;
  sku: string | null;
  totalQuantity: number;
  remainingQuantity: number;
}

export interface RawFulfillmentOrder {
  id: string;
  status: string;
  lineItems: RawFulfillmentOrderLineItem[];
}

export interface RawOrder {
  id: string;
  name: string;
  createdAt: string;
  processedAt?: string;
  cancelledAt: string | null;
  cancelReason?: string | null;
  sourceName: string | null;
  test: boolean;
  tags?: string[];
  lineItems: RawLineItem[];
  fulfillments: RawFulfillment[];
  refunds: RawRefund[];
  returns: RawReturn[] | null;
  fulfillmentOrders: RawFulfillmentOrder[] | null;
}

// ── Query / result shapes ───────────────────────────────────────────────

export type Basis = "fulfillment" | "order" | "refund";
export type GroupBy = "none" | "month" | "channel";

export interface CountParams {
  skus?: string[];
  productId?: string;
  since: string;
  until: string;
  tz: string;
  basis: Basis;
  groupBy: GroupBy;
  includeTestOrders: boolean;
  evidenceLimit?: number;
  time: TimeAdapter;
  asOf: string;
  fulfillmentOrderScopesComplete: boolean;
  missingFulfillmentOrderScopes?: string[];
}

export interface UnitCounts {
  units_ordered: number;
  units_ordered_current: number;
  units_shipped: number;
  units_cancelled: number;
  units_refunded: number;
  refunded_amount: number;
  units_returned: number | null;
  units_unfulfilled: number;
  orders: number;
}

export interface Reconciliation {
  shipped_gross: number;
  shipped_then_cancelled_and_refunded: number;
  shipped_unattributed: number;
  refunded_by_restock_type: Record<string, number>;
  refunds_unattributed: number;
  refunded_amount_unattributed: number;
  returns_in_progress: number | null;
  refunded_without_return: number | null;
  returned_without_refund: number | null;
  unfulfilled_crosscheck: {
    fulfillment_order_remaining: number;
    matches: boolean;
  } | null;
  unfulfilled_crosscheck_missing_scopes: string[] | null;
  as_of: string;
  unfulfilled_as_of: string;
}

export interface Bucket extends UnitCounts {
  key: string;
}

export interface OrderEvidence {
  id: string;
  name: string;
  created_at: string;
  created_shop_date: string;
  cancelled_at: string | null;
  source_name: string | null;
  test: boolean;
  matched_line_items: Array<{
    id: string;
    sku: string | null;
    quantity: number;
    current_quantity: number;
    unfulfilled_quantity: number;
  }>;
  shipped: number;
  refunded: number;
  returned: number | null;
  refunded_amount: number;
}

export interface CountResult {
  totals: UnitCounts;
  reconciliation: Reconciliation;
  buckets: Bucket[];
  warnings: string[];
  matched_orders: number;
  orders_evidence: OrderEvidence[];
  orders_truncated: boolean;
}

// ── Internals ───────────────────────────────────────────────────────────

const FO_REMAINING_STATUSES = new Set([
  "OPEN",
  "IN_PROGRESS",
  "SCHEDULED",
  "ON_HOLD",
]);

const DEFAULT_EVIDENCE_LIMIT = 500;

interface MutableCounts {
  units_ordered: number;
  units_ordered_current: number;
  units_shipped: number;
  units_cancelled: number;
  units_refunded: number;
  refunded_amount: number;
  units_returned: number;
  units_unfulfilled: number;
  orders: number;
}

interface ShipEvent {
  iso: string;
  qty: number;
}

function emptyMutable(): MutableCounts {
  return {
    units_ordered: 0,
    units_ordered_current: 0,
    units_cancelled: 0,
    units_shipped: 0,
    units_refunded: 0,
    refunded_amount: 0,
    units_returned: 0,
    units_unfulfilled: 0,
    orders: 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function freezeCounts(
  m: MutableCounts,
  unitsReturned: number | null,
): UnitCounts {
  return {
    units_ordered: m.units_ordered,
    units_ordered_current: m.units_ordered_current,
    units_shipped: m.units_shipped,
    units_cancelled: m.units_cancelled,
    units_refunded: m.units_refunded,
    refunded_amount: round2(m.refunded_amount),
    units_returned: unitsReturned,
    units_unfulfilled: m.units_unfulfilled,
    orders: m.orders,
  };
}

/** Numeric tail of a GID or a bare id, for product-id comparison. */
function idTail(id: string): string {
  const trimmed = id.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function hasSkuFilter(params: CountParams): boolean {
  return Array.isArray(params.skus) && params.skus.length > 0;
}

function hasProductFilter(params: CountParams): boolean {
  return typeof params.productId === "string" && params.productId.length > 0;
}

function skuInFilter(line: RawLineItem, params: CountParams): boolean {
  const normalized = normalizeSku(line.sku);
  if (normalized === null) return false;
  for (const raw of params.skus as string[]) {
    if (normalizeSku(raw) === normalized) return true;
  }
  return false;
}

function productInFilter(line: RawLineItem, params: CountParams): boolean {
  const productId = line.product?.id;
  if (!productId) return false;
  return idTail(productId) === idTail(params.productId as string);
}

function matchingLines(order: RawOrder, params: CountParams): RawLineItem[] {
  return order.lineItems.filter((line) => lineMatches(line, params));
}

function channelKey(order: RawOrder): string {
  return order.sourceName === null ? "unknown" : order.sourceName;
}

function datePrefix(value: string): string {
  return value.slice(0, 10);
}

function compareIso(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function refundedUnitsAllTime(order: RawOrder, matchingIds: Set<string>): number {
  let qty = 0;
  for (const refund of order.refunds) {
    for (const li of refund.lineItems) {
      if (matchingIds.has(li.lineItemId)) qty += li.quantity;
    }
  }
  return qty;
}

function evidenceShipped(order: RawOrder, matchingIds: Set<string>): number {
  let qty = 0;
  for (const f of order.fulfillments) {
    if (f.status !== "SUCCESS") continue;
    for (const li of f.lineItems) {
      if (!matchingIds.has(li.lineItemId)) continue;
      if (li.quantity === null) continue;
      qty += li.quantity;
    }
  }
  return qty;
}

function evidenceRefunded(order: RawOrder, matchingIds: Set<string>): {
  qty: number;
  amount: number;
} {
  let qty = 0;
  let amount = 0;
  for (const refund of order.refunds) {
    for (const li of refund.lineItems) {
      if (!matchingIds.has(li.lineItemId)) continue;
      qty += li.quantity;
      if (li.subtotalAmount !== null) amount += li.subtotalAmount;
    }
  }
  return { qty, amount: round2(amount) };
}

function evidenceReturned(order: RawOrder, matchingIds: Set<string>): number | null {
  if (order.returns === null) return null;
  let qty = 0;
  for (const ret of order.returns) {
    if (ret.status !== "CLOSED") continue;
    for (const li of ret.lineItems) {
      if (li.lineItemId !== null && matchingIds.has(li.lineItemId)) {
        qty += li.quantity;
      }
    }
  }
  return qty;
}

function toEvidence(
  order: RawOrder,
  params: CountParams,
  matching: RawLineItem[],
  matchingIds: Set<string>,
): OrderEvidence {
  const refunded = evidenceRefunded(order, matchingIds);
  return {
    id: order.id,
    name: order.name,
    created_at: order.createdAt,
    created_shop_date: params.time.localDate(order.createdAt),
    cancelled_at: order.cancelledAt,
    source_name: order.sourceName,
    test: order.test,
    matched_line_items: matching.map((line) => ({
      id: line.id,
      sku: line.sku,
      quantity: line.quantity,
      current_quantity: line.currentQuantity,
      unfulfilled_quantity: line.unfulfilledQuantity,
    })),
    shipped: evidenceShipped(order, matchingIds),
    refunded: refunded.qty,
    returned: evidenceReturned(order, matchingIds),
    refunded_amount: refunded.amount,
  };
}

function fulfillmentHasMatchingLine(
  fulfillment: RawFulfillment,
  matchingIds: Set<string>,
): boolean {
  for (const li of fulfillment.lineItems) {
    if (matchingIds.has(li.lineItemId)) return true;
  }
  return false;
}

function refundHasMatchingLine(
  refund: RawRefund,
  matchingIds: Set<string>,
): boolean {
  for (const li of refund.lineItems) {
    if (matchingIds.has(li.lineItemId)) return true;
  }
  return false;
}

function orderHasBasisEvent(
  order: RawOrder,
  params: CountParams,
  matchingIds: Set<string>,
): boolean {
  if (params.basis === "order") {
    return params.time.inWindow(order.createdAt);
  }
  if (params.basis === "fulfillment") {
    for (const f of order.fulfillments) {
      if (f.status !== "SUCCESS") continue;
      if (!params.time.inWindow(f.createdAt)) continue;
      if (fulfillmentHasMatchingLine(f, matchingIds)) return true;
    }
    return false;
  }
  for (const refund of order.refunds) {
    if (!params.time.inWindow(refund.createdAt)) continue;
    if (refundHasMatchingLine(refund, matchingIds)) return true;
  }
  return false;
}

function basisEventMonths(
  order: RawOrder,
  params: CountParams,
  matchingIds: Set<string>,
): string[] {
  const months: string[] = [];
  const seen = new Set<string>();
  const add = (iso: string) => {
    const key = params.time.monthKey(iso);
    if (seen.has(key)) return;
    seen.add(key);
    months.push(key);
  };

  if (params.basis === "order") {
    if (params.time.inWindow(order.createdAt)) add(order.createdAt);
    return months;
  }
  if (params.basis === "fulfillment") {
    for (const f of order.fulfillments) {
      if (f.status !== "SUCCESS") continue;
      if (!params.time.inWindow(f.createdAt)) continue;
      if (!fulfillmentHasMatchingLine(f, matchingIds)) continue;
      add(f.createdAt);
    }
    return months;
  }
  for (const refund of order.refunds) {
    if (refund.createdAt === null) continue;
    if (!params.time.inWindow(refund.createdAt)) continue;
    if (!refundHasMatchingLine(refund, matchingIds)) continue;
    add(refund.createdAt);
  }
  return months;
}

type CountField = keyof MutableCounts;

function bump(
  totals: MutableCounts,
  monthBuckets: Map<string, MutableCounts>,
  channelBuckets: Map<string, MutableCounts>,
  groupBy: GroupBy,
  field: CountField,
  amount: number,
  monthIso: string | null,
  channel: string,
  time: TimeAdapter,
): void {
  totals[field] += amount;
  if (groupBy === "month" && monthIso !== null) {
    const key = time.monthKey(monthIso);
    const bucket = monthBuckets.get(key);
    if (bucket) bucket[field] += amount;
  } else if (groupBy === "channel") {
    const bucket = channelBuckets.get(channel) as MutableCounts;
    bucket[field] += amount;
  }
}

function ensureChannel(
  channelBuckets: Map<string, MutableCounts>,
  key: string,
): void {
  if (!channelBuckets.has(key)) channelBuckets.set(key, emptyMutable());
}

function foRemainingForOrder(
  fos: RawFulfillmentOrder[],
  matchingIds: Set<string>,
): number {
  let remaining = 0;
  for (const fo of fos) {
    if (!FO_REMAINING_STATUSES.has(fo.status)) continue;
    for (const li of fo.lineItems) {
      if (matchingIds.has(li.lineItemId)) remaining += li.remainingQuantity;
    }
  }
  return remaining;
}

function sortBucketsByKey(buckets: Bucket[]): Bucket[] {
  return buckets.sort((a, b) => a.key.localeCompare(b.key));
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Trim + uppercase a SKU. Empty / whitespace-only / null / undefined -> null.
 */
export function normalizeSku(sku: string | null | undefined): string | null {
  if (sku === null || sku === undefined) return null;
  const normalized = sku.trim().toUpperCase();
  return normalized.length === 0 ? null : normalized;
}

/**
 * True when `line` is in the SKU set and/or matches productId.
 * Missing filters are skipped. When both are present they AND.
 * Product ids accept a numeric tail or a full GID.
 */
export function lineMatches(line: RawLineItem, params: CountParams): boolean {
  const skuFilter = hasSkuFilter(params);
  const productFilter = hasProductFilter(params);
  if (!skuFilter && !productFilter) return true;
  if (skuFilter && !skuInFilter(line, params)) return false;
  if (productFilter && !productInFilter(line, params)) return false;
  return true;
}

/**
 * Count per-SKU / per-product units across already-fetched orders.
 * Pure: no I/O, no Date math, no module state.
 */
export function countUnits(orders: RawOrder[], params: CountParams): CountResult {
  const time = params.time;
  const warnings: string[] = [];
  const returnsMissing = orders.some((o) => o.returns === null);
  const unitsReturnedOut: number | null = returnsMissing ? null : 0;

  let testExcluded = 0;
  const matched: RawOrder[] = [];
  const matchedLines = new Map<string, RawLineItem[]>();
  const matchedIds = new Map<string, Set<string>>();

  for (const order of orders) {
    if (order.test && !params.includeTestOrders) {
      testExcluded += 1;
      continue;
    }
    const lines = matchingLines(order, params);
    if (lines.length === 0) continue;
    matched.push(order);
    matchedLines.set(order.id, lines);
    matchedIds.set(order.id, new Set(lines.map((l) => l.id)));
  }

  if (testExcluded > 0) {
    warnings.push(`${testExcluded} test order(s) excluded`);
  }
  if (returnsMissing) {
    warnings.push(
      "read_returns scope missing: physical returns unavailable; refunds are reported separately",
    );
  }

  const foAvailable =
    params.fulfillmentOrderScopesComplete &&
    matched.every((o) => o.fulfillmentOrders !== null);
  const missingFoScopes = params.missingFulfillmentOrderScopes ?? [];
  if (!foAvailable) {
    warnings.push(
      `fulfillment-order scopes missing (${missingFoScopes.join(", ")}): unfulfilled cross-check unavailable`,
    );
  }

  const untilDate = datePrefix(params.until);
  const asOfLocal = time.localDate(params.asOf);
  if (untilDate < asOfLocal) {
    warnings.push(
      `units_unfulfilled is the outstanding quantity as of ${params.asOf}, not as of ${params.until}`,
    );
  }

  const totals = emptyMutable();
  const monthBuckets = new Map<string, MutableCounts>();
  const channelBuckets = new Map<string, MutableCounts>();
  const monthKeys = params.groupBy === "month" ? time.months() : [];

  for (const key of monthKeys) {
    monthBuckets.set(key, emptyMutable());
  }
  if (params.groupBy === "channel") {
    for (const order of matched) {
      ensureChannel(channelBuckets, channelKey(order));
    }
  }

  let shippedGross = 0;
  let shippedThenCancelled = 0;
  let shippedUnattributed = 0;
  const refundedByRestock: Record<string, number> = {};
  let refundsUnattributed = 0;
  let refundedAmountUnattributed = 0;
  let returnsInProgress = 0;
  let undatedRefunds = 0;
  let foRemaining = 0;

  for (const order of matched) {
    const matching = matchedLines.get(order.id) as RawLineItem[];
    const matchingIdSet = matchedIds.get(order.id) as Set<string>;
    const channel = channelKey(order);
    const add = (
      field: CountField,
      amount: number,
      monthIso: string | null,
    ) => {
      bump(
        totals,
        monthBuckets,
        channelBuckets,
        params.groupBy,
        field,
        amount,
        monthIso,
        channel,
        time,
      );
    };

    if (time.inWindow(order.createdAt)) {
      let ordered = 0;
      let orderedCurrent = 0;
      let unfulfilled = 0;
      for (const line of matching) {
        ordered += line.quantity;
        orderedCurrent += line.currentQuantity;
        if (order.cancelledAt === null) {
          unfulfilled += line.unfulfilledQuantity;
        }
      }
      add("units_ordered", ordered, order.createdAt);
      add("units_ordered_current", orderedCurrent, order.createdAt);
      if (order.cancelledAt === null) {
        add("units_unfulfilled", unfulfilled, order.createdAt);
        if (foAvailable) {
          foRemaining += foRemainingForOrder(
            order.fulfillmentOrders as RawFulfillmentOrder[],
            matchingIdSet,
          );
        }
      }
    }

    if (order.cancelledAt !== null && time.inWindow(order.cancelledAt)) {
      let cancelled = 0;
      for (const line of matching) cancelled += line.quantity;
      add("units_cancelled", cancelled, order.cancelledAt);
    }

    const shipEvents: ShipEvent[] = [];
    let orderShippedGross = 0;
    for (const fulfillment of order.fulfillments) {
      if (fulfillment.status !== "SUCCESS") continue;
      if (!time.inWindow(fulfillment.createdAt)) continue;
      for (const li of fulfillment.lineItems) {
        if (!matchingIdSet.has(li.lineItemId)) continue;
        if (li.quantity === null) {
          shippedUnattributed += 1;
          warnings.push(
            `Fulfillment ${fulfillment.id} has a line item with null quantity; counted in shipped_unattributed`,
          );
          continue;
        }
        orderShippedGross += li.quantity;
        shipEvents.push({ iso: fulfillment.createdAt, qty: li.quantity });
      }
    }
    shippedGross += orderShippedGross;

    let adjustment = 0;
    if (order.cancelledAt !== null) {
      adjustment = Math.min(
        orderShippedGross,
        refundedUnitsAllTime(order, matchingIdSet),
      );
    }
    shippedThenCancelled += adjustment;

    shipEvents.sort((a, b) => compareIso(a.iso, b.iso));
    let adjLeft = adjustment;
    for (const ev of shipEvents) {
      const deduct = Math.min(ev.qty, adjLeft);
      adjLeft -= deduct;
      add("units_shipped", ev.qty - deduct, ev.iso);
    }

    for (const refund of order.refunds) {
      let matchingQty = 0;
      let matchingAmount = 0;
      let hadMatching = false;
      let hadNullAmount = false;
      for (const li of refund.lineItems) {
        if (!matchingIdSet.has(li.lineItemId)) continue;
        hadMatching = true;
        matchingQty += li.quantity;
        if (li.subtotalAmount === null) {
          hadNullAmount = true;
        } else {
          matchingAmount += li.subtotalAmount;
        }
      }
      if (!hadMatching) continue;

      if (refund.createdAt === null) {
        undatedRefunds += 1;
        refundsUnattributed += matchingQty;
        refundedAmountUnattributed += matchingAmount;
        if (hadNullAmount) {
          warnings.push(
            `Refund ${refund.id} has a null subtotalAmount on a matching line and was counted in refunded_amount_unattributed`,
          );
        }
        continue;
      }

      if (hadNullAmount) {
        warnings.push(
          `Refund ${refund.id} has a null subtotalAmount on a matching line and was counted in refunded_amount_unattributed`,
        );
      }

      if (!time.inWindow(refund.createdAt)) continue;

      add("units_refunded", matchingQty, refund.createdAt);
      add("refunded_amount", matchingAmount, refund.createdAt);
      for (const li of refund.lineItems) {
        if (!matchingIdSet.has(li.lineItemId)) continue;
        refundedByRestock[li.restockType] =
          (refundedByRestock[li.restockType] ?? 0) + li.quantity;
      }
    }

    if (!returnsMissing && order.returns !== null) {
      for (const ret of order.returns) {
        let matchingQty = 0;
        for (const li of ret.lineItems) {
          if (li.lineItemId !== null && matchingIdSet.has(li.lineItemId)) {
            matchingQty += li.quantity;
          }
        }
        if (matchingQty === 0) continue;
        if (ret.status === "CLOSED") {
          if (time.inWindow(ret.createdAt)) {
            add("units_returned", matchingQty, ret.createdAt);
          }
        } else if (ret.status === "OPEN" || ret.status === "REQUESTED") {
          returnsInProgress += matchingQty;
        }
      }
    }

    if (orderHasBasisEvent(order, params, matchingIdSet)) {
      add("orders", 1, null);
      if (params.groupBy === "month") {
        // Totals already got +1 via add(); month buckets need each
        // basis-event month, so undo the no-op month path and stamp months.
        for (const month of basisEventMonths(order, params, matchingIdSet)) {
          const bucket = monthBuckets.get(month);
          if (bucket) bucket.orders += 1;
        }
      }
    }
  }

  if (undatedRefunds > 0) {
    warnings.push(
      `${undatedRefunds} refund(s) have no createdAt and were not dated`,
    );
  }

  const unitsReturnedFinal = returnsMissing ? null : totals.units_returned;
  const refundedWithoutReturn = returnsMissing
    ? null
    : Math.max(0, totals.units_refunded - totals.units_returned);
  const returnedWithoutRefund = returnsMissing
    ? null
    : Math.max(0, totals.units_returned - totals.units_refunded);

  const frozenTotals = freezeCounts(totals, unitsReturnedFinal);

  let buckets: Bucket[] = [];
  if (params.groupBy === "month") {
    buckets = monthKeys.map((key) => {
      const m = monthBuckets.get(key) as MutableCounts;
      return { key, ...freezeCounts(m, unitsReturnedFinal === null ? null : m.units_returned) };
    });
  } else if (params.groupBy === "channel") {
    buckets = sortBucketsByKey(
      [...channelBuckets.entries()].map(([key, m]) => ({
        key,
        ...freezeCounts(m, unitsReturnedFinal === null ? null : m.units_returned),
      })),
    );
  }

  const evidenceLimit = params.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT;
  const sortedMatched = matched.slice().sort((a, b) => {
    const byCreated = compareIso(a.createdAt, b.createdAt);
    if (byCreated !== 0) return byCreated;
    return compareIso(a.id, b.id);
  });
  const ordersTruncated = sortedMatched.length > evidenceLimit;
  const ordersEvidence = sortedMatched.slice(0, evidenceLimit).map((order) =>
    toEvidence(
      order,
      params,
      matchedLines.get(order.id) as RawLineItem[],
      matchedIds.get(order.id) as Set<string>,
    ),
  );

  const reconciliation: Reconciliation = {
    shipped_gross: shippedGross,
    shipped_then_cancelled_and_refunded: shippedThenCancelled,
    shipped_unattributed: shippedUnattributed,
    refunded_by_restock_type: refundedByRestock,
    refunds_unattributed: refundsUnattributed,
    refunded_amount_unattributed: round2(refundedAmountUnattributed),
    returns_in_progress: returnsMissing ? null : returnsInProgress,
    refunded_without_return: refundedWithoutReturn,
    returned_without_refund: returnedWithoutRefund,
    unfulfilled_crosscheck: foAvailable
      ? {
          fulfillment_order_remaining: foRemaining,
          matches: foRemaining === frozenTotals.units_unfulfilled,
        }
      : null,
    unfulfilled_crosscheck_missing_scopes: foAvailable ? null : missingFoScopes,
    as_of: params.asOf,
    unfulfilled_as_of: params.asOf,
  };

  return {
    totals: frozenTotals,
    reconciliation,
    buckets,
    warnings,
    matched_orders: matched.length,
    orders_evidence: ordersEvidence,
    orders_truncated: ordersTruncated,
  };
}
