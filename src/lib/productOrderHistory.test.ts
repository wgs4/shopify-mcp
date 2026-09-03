// Regression tests for the pure per-SKU counting engine.
//
// Root cause being guarded: product-order-history totals mixing clocks
// (order createdAt vs fulfillment vs refund vs cancel) and UTC vs shop-local
// days. Tests must FAIL if countUnits / lineMatches / normalizeSku are absent
// or wrong, and PASS once the engine implements the normative semantics.

import { describe, expect, test, jest } from "@jest/globals";

import {
  countUnits,
  lineMatches,
  normalizeSku,
  type CountParams,
  type RawFulfillment,
  type RawFulfillmentOrder,
  type RawLineItem,
  type RawOrder,
  type RawRefund,
  type RawReturn,
  type TimeAdapter,
  type UnitCounts,
} from "./productOrderHistory.js";

void jest;

const SKU_A = "7655-P";
const SKU_B = "7711-P";
const LINE_A = "gid://shopify/LineItem/1";
const LINE_B = "gid://shopify/LineItem/2";
const PRODUCT_A = "gid://shopify/Product/99";
const DEFAULT_AS_OF = "2026-09-03T12:00:00Z";

function utcTime(since: string, until: string): TimeAdapter {
  return {
    localDate(iso: string): string {
      return iso.slice(0, 10);
    },
    monthKey(iso: string): string {
      return iso.slice(0, 7);
    },
    inWindow(iso: string | null | undefined): boolean {
      if (iso == null || iso === "") return false;
      const d = iso.slice(0, 10);
      return d >= since && d <= until;
    },
    months(): string[] {
      const keys: string[] = [];
      let y = Number(since.slice(0, 4));
      let m = Number(since.slice(5, 7));
      const ey = Number(until.slice(0, 4));
      const em = Number(until.slice(5, 7));
      while (y < ey || (y === ey && m <= em)) {
        keys.push(`${y}-${String(m).padStart(2, "0")}`);
        m += 1;
        if (m === 13) {
          m = 1;
          y += 1;
        }
      }
      return keys;
    },
  };
}

function offsetTime(
  offsetHours: number,
  since: string,
  until: string,
): TimeAdapter {
  function shiftedIso(iso: string): string {
    const ms = Date.parse(iso) + offsetHours * 3600 * 1000;
    return new Date(ms).toISOString();
  }
  const inner = utcTime(since, until);
  return {
    localDate(iso: string): string {
      return inner.localDate(shiftedIso(iso));
    },
    monthKey(iso: string): string {
      return inner.monthKey(shiftedIso(iso));
    },
    inWindow(iso: string | null | undefined): boolean {
      if (iso == null || iso === "") return false;
      return inner.inWindow(shiftedIso(iso));
    },
    months(): string[] {
      return inner.months();
    },
  };
}

function makeParams(overrides: Partial<CountParams> = {}): CountParams {
  const since = overrides.since ?? "2025-01-01";
  const until = overrides.until ?? "2025-12-31";
  return {
    skus: [SKU_A],
    since,
    until,
    tz: "UTC",
    basis: "order",
    groupBy: "none",
    includeTestOrders: false,
    asOf: DEFAULT_AS_OF,
    fulfillmentOrderScopesComplete: true,
    returnsScopeComplete: true,
    ...overrides,
    since,
    until,
    time: overrides.time ?? utcTime(since, until),
  };
}

function makeLine(overrides: Partial<RawLineItem> = {}): RawLineItem {
  return {
    id: LINE_A,
    sku: SKU_A,
    title: "Pedal",
    quantity: 1,
    currentQuantity: 1,
    unfulfilledQuantity: 0,
    product: { id: PRODUCT_A },
    ...overrides,
  };
}

function makeFulfillment(
  overrides: Partial<RawFulfillment> = {},
): RawFulfillment {
  return {
    id: "gid://shopify/Fulfillment/1",
    status: "SUCCESS",
    createdAt: "2025-02-10T12:00:00Z",
    lineItems: [{ quantity: 1, lineItemId: LINE_A }],
    ...overrides,
  };
}

function makeRefund(overrides: Partial<RawRefund> = {}): RawRefund {
  return {
    id: "gid://shopify/Refund/1",
    createdAt: "2025-03-05T12:00:00Z",
    totalRefundedAmount: 10,
    lineItems: [
      {
        quantity: 1,
        restockType: "RETURN",
        lineItemId: LINE_A,
        subtotalAmount: 10,
      },
    ],
    ...overrides,
  };
}

function makeReturn(overrides: Partial<RawReturn> = {}): RawReturn {
  return {
    id: "gid://shopify/Return/1",
    status: "CLOSED",
    createdAt: "2025-03-06T12:00:00Z",
    lineItems: [{ quantity: 1, lineItemId: LINE_A }],
    ...overrides,
  };
}

function makeFo(
  overrides: Partial<RawFulfillmentOrder> = {},
): RawFulfillmentOrder {
  return {
    id: "gid://shopify/FulfillmentOrder/1",
    status: "OPEN",
    lineItems: [
      {
        lineItemId: LINE_A,
        sku: SKU_A,
        totalQuantity: 1,
        remainingQuantity: 1,
      },
    ],
    ...overrides,
  };
}

function makeOrder(overrides: Partial<RawOrder> = {}): RawOrder {
  return {
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2025-01-15T12:00:00Z",
    cancelledAt: null,
    sourceName: "web",
    test: false,
    lineItems: [makeLine()],
    fulfillments: [],
    refunds: [],
    returns: [],
    fulfillmentOrders: [],
    ...overrides,
  };
}

function zeros(units_returned: number | null = 0): UnitCounts {
  return {
    units_ordered: 0,
    units_ordered_current: 0,
    units_shipped: 0,
    units_cancelled: 0,
    units_refunded: 0,
    refunded_amount: 0,
    units_returned,
    units_unfulfilled: 0,
    orders: 0,
  };
}

describe("normalizeSku", () => {
  test("trims, uppercases, and maps empty to null", () => {
    expect(normalizeSku("  7655-p  ")).toBe("7655-P");
    expect(normalizeSku("7711-p")).toBe("7711-P");
    expect(normalizeSku("")).toBeNull();
    expect(normalizeSku("   ")).toBeNull();
    expect(normalizeSku(null)).toBeNull();
    expect(normalizeSku(undefined)).toBeNull();
  });
});

describe("lineMatches", () => {
  const line = makeLine({ sku: "  7655-P  ", product: { id: PRODUCT_A } });

  test("SKU reuse: case, whitespace, and both SKUs in the set", () => {
    const params = makeParams({ skus: ["7711-P", "7655-P"] });
    expect(lineMatches(makeLine({ sku: "7655-P" }), params)).toBe(true);
    expect(lineMatches(makeLine({ sku: "7711-p" }), params)).toBe(true);
    expect(lineMatches(line, params)).toBe(true);
    expect(lineMatches(makeLine({ sku: "NOPE" }), params)).toBe(false);
    expect(lineMatches(makeLine({ sku: null }), params)).toBe(false);
    expect(lineMatches(makeLine({ sku: SKU_A }), makeParams({ skus: ["  ", ""] }))).toBe(false);
  });

  test("product id numeric vs gid (numeric tail)", () => {
    const byNumeric = makeParams({ skus: undefined, productId: "99" });
    const byGid = makeParams({
      skus: undefined,
      productId: "gid://shopify/Product/99",
    });
    const other = makeParams({ skus: undefined, productId: "98" });
    expect(lineMatches(line, byNumeric)).toBe(true);
    expect(lineMatches(line, byGid)).toBe(true);
    expect(lineMatches(line, other)).toBe(false);
    expect(
      lineMatches(makeLine({ product: null }), byNumeric),
    ).toBe(false);
    expect(
      lineMatches(makeLine({ product: { id: "99" } }), byGid),
    ).toBe(true);
  });

  test("no filters match every line; both filters AND", () => {
    const none = makeParams({ skus: undefined, productId: undefined });
    expect(lineMatches(makeLine({ sku: "ZZZ" }), none)).toBe(true);
    const empty = makeParams({ skus: [], productId: "" });
    expect(lineMatches(makeLine({ sku: "ZZZ" }), empty)).toBe(true);
    const both = makeParams({
      skus: [SKU_A],
      productId: "99",
    });
    expect(lineMatches(line, both)).toBe(true);
    expect(
      lineMatches(makeLine({ sku: SKU_A, product: { id: "gid://shopify/Product/1" } }), both),
    ).toBe(false);
    expect(
      lineMatches(makeLine({ sku: SKU_B, product: { id: PRODUCT_A } }), both),
    ).toBe(false);
  });
});

describe("countUnits empty input", () => {
  test("returnsScopeComplete false on empty input nulls returns metrics and warns", () => {
    const result = countUnits(
      [],
      makeParams({ returnsScopeComplete: false }),
    );
    expect(result.totals.units_returned).toBeNull();
    expect(result.reconciliation.returns_in_progress).toBeNull();
    expect(result.reconciliation.refunded_without_return).toBeNull();
    expect(result.reconciliation.returned_without_refund).toBeNull();
    expect(result.warnings).toContain(
      "read_returns scope missing: physical returns unavailable; refunds are reported separately",
    );
  });

  test("returnsScopeComplete true on empty input yields 0 and no returns warning", () => {
    const result = countUnits([], makeParams({ returnsScopeComplete: true }));
    expect(result.totals.units_returned).toBe(0);
    expect(result.reconciliation.returns_in_progress).toBe(0);
    expect(
      result.warnings.some((w) => w.includes("read_returns scope missing")),
    ).toBe(false);
  });

  test("zeros, empty buckets for none, zero-filled months for month", () => {
    const none = countUnits([], makeParams({ groupBy: "none" }));
    expect(none.totals).toEqual(zeros(0));
    expect(none.buckets).toEqual([]);
    expect(none.matched_orders).toBe(0);
    expect(none.orders_evidence).toEqual([]);
    expect(none.orders_truncated).toBe(false);
    expect(none.reconciliation.shipped_gross).toBe(0);
    expect(none.reconciliation.unfulfilled_crosscheck).toEqual({
      fulfillment_order_remaining: 0,
      matches: true,
    });
    expect(none.reconciliation.as_of).toBe(DEFAULT_AS_OF);
    expect(none.reconciliation.unfulfilled_as_of).toBe(DEFAULT_AS_OF);

    const month = countUnits(
      [],
      makeParams({
        since: "2024-12-01",
        until: "2025-01-31",
        groupBy: "month",
      }),
    );
    expect(month.buckets.map((b) => b.key)).toEqual(["2024-12", "2025-01"]);
    for (const b of month.buckets) {
      expect(b).toMatchObject(zeros(0));
    }
  });
});

describe("SKU matching through countUnits", () => {
  test("both 7655-P and 7711-p match skus [7711-P, 7655-P]", () => {
    const orders = [
      makeOrder({
        id: "o1",
        lineItems: [makeLine({ id: "l1", sku: "7655-P", quantity: 2 })],
      }),
      makeOrder({
        id: "o2",
        name: "#1002",
        createdAt: "2025-01-16T12:00:00Z",
        lineItems: [makeLine({ id: "l2", sku: "7711-p", quantity: 3 })],
      }),
    ];
    const result = countUnits(
      orders,
      makeParams({ skus: ["7711-P", "7655-P"] }),
    );
    expect(result.totals.units_ordered).toBe(5);
    expect(result.matched_orders).toBe(2);
  });
});

describe("cross-year own clocks", () => {
  test("created 2024-12-30, fulfilled 2025-01-02 -> ordered 0, shipped 1 for since 2025-01-01", () => {
    const order = makeOrder({
      createdAt: "2024-12-30T12:00:00Z",
      lineItems: [makeLine({ unfulfilledQuantity: 0 })],
      fulfillments: [
        makeFulfillment({ createdAt: "2025-01-02T12:00:00Z" }),
      ],
      fulfillmentOrders: [
        makeFo({ status: "CLOSED", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 0 }] }),
      ],
    });
    const result = countUnits(
      [order],
      makeParams({ since: "2025-01-01", until: "2025-01-31", basis: "fulfillment" }),
    );
    expect(result.totals.units_ordered).toBe(0);
    expect(result.totals.units_shipped).toBe(1);
    expect(result.reconciliation.shipped_gross).toBe(1);
    expect(result.totals.orders).toBe(1);
    expect(result.matched_orders).toBe(1);
  });
});

describe("cancel-after-ship", () => {
  const base = {
    createdAt: "2025-02-01T12:00:00Z",
    cancelledAt: "2025-03-05T12:00:00Z",
    fulfillments: [makeFulfillment({ createdAt: "2025-02-10T12:00:00Z" })],
  };

  test("cancelled with RETURN refund -> shipped net 0, adjustment 1", () => {
    const order = makeOrder({
      ...base,
      refunds: [makeRefund({ createdAt: "2025-03-05T15:00:00Z" })],
    });
    const result = countUnits(
      [order],
      makeParams({ since: "2025-02-01", until: "2025-03-31" }),
    );
    expect(result.reconciliation.shipped_gross).toBe(1);
    expect(result.totals.units_shipped).toBe(0);
    expect(result.reconciliation.shipped_then_cancelled_and_refunded).toBe(1);
    expect(result.totals.units_cancelled).toBe(1);
    expect(result.totals.units_refunded).toBe(1);
  });

  test("cancelled without a refund -> units_shipped stays 1", () => {
    const order = makeOrder({ ...base, refunds: [] });
    const result = countUnits(
      [order],
      makeParams({ since: "2025-02-01", until: "2025-03-31" }),
    );
    expect(result.reconciliation.shipped_gross).toBe(1);
    expect(result.totals.units_shipped).toBe(1);
    expect(result.reconciliation.shipped_then_cancelled_and_refunded).toBe(0);
    expect(result.totals.units_cancelled).toBe(1);
  });

  test("refund dated AFTER the window still reduces units_shipped", () => {
    const order = makeOrder({
      ...base,
      refunds: [makeRefund({ createdAt: "2025-04-15T12:00:00Z" })],
    });
    const result = countUnits(
      [order],
      makeParams({ since: "2025-02-01", until: "2025-03-31" }),
    );
    expect(result.reconciliation.shipped_gross).toBe(1);
    expect(result.totals.units_shipped).toBe(0);
    expect(result.reconciliation.shipped_then_cancelled_and_refunded).toBe(1);
    expect(result.totals.units_refunded).toBe(0);
  });

  test("not cancelled, even with a refund, does not adjust shipped", () => {
    const order = makeOrder({
      createdAt: "2025-02-01T12:00:00Z",
      cancelledAt: null,
      fulfillments: [makeFulfillment({ createdAt: "2025-02-10T12:00:00Z" })],
      refunds: [makeRefund({ createdAt: "2025-03-05T15:00:00Z" })],
    });
    const result = countUnits(
      [order],
      makeParams({ since: "2025-02-01", until: "2025-03-31" }),
    );
    expect(result.totals.units_shipped).toBe(1);
    expect(result.reconciliation.shipped_then_cancelled_and_refunded).toBe(0);
  });
});

describe("refunds", () => {
  test("whole-order refund lists a non-matching line too -> only matching qty", () => {
    const order = makeOrder({
      lineItems: [
        makeLine({ id: LINE_A, sku: SKU_A, quantity: 2 }),
        makeLine({ id: LINE_B, sku: "OTHER", quantity: 5 }),
      ],
      refunds: [
        makeRefund({
          lineItems: [
            { quantity: 2, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 20 },
            { quantity: 5, restockType: "RETURN", lineItemId: LINE_B, subtotalAmount: 50 },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams({ skus: [SKU_A] }));
    expect(result.totals.units_refunded).toBe(2);
    expect(result.totals.refunded_amount).toBe(20);
    expect(result.reconciliation.refunded_by_restock_type).toEqual({ RETURN: 2 });
  });

  test("refund with createdAt null -> refunds_unattributed + warning", () => {
    const order = makeOrder({
      refunds: [
        makeRefund({
          id: "gid://shopify/Refund/undated",
          createdAt: null,
          lineItems: [
            { quantity: 2, restockType: "CANCEL", lineItemId: LINE_A, subtotalAmount: 15.5 },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_refunded).toBe(0);
    expect(result.totals.refunded_amount).toBe(0);
    expect(result.reconciliation.refunds_unattributed).toBe(2);
    expect(result.reconciliation.refunded_amount_unattributed).toBe(15.5);
    expect(result.warnings).toContain(
      "1 refund(s) have no createdAt and were not dated",
    );
    expect(result.reconciliation.refunded_by_restock_type).toEqual({});
  });

  test("refund restock type breakdown accumulates by restockType", () => {
    const order = makeOrder({
      refunds: [
        makeRefund({
          id: "r1",
          createdAt: "2025-03-01T00:00:00Z",
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 },
            { quantity: 2, restockType: "NO_RESTOCK", lineItemId: LINE_A, subtotalAmount: 2 },
          ],
        }),
        makeRefund({
          id: "r2",
          createdAt: "2025-03-02T00:00:00Z",
          lineItems: [
            { quantity: 3, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 3 },
            { quantity: 1, restockType: "CANCEL", lineItemId: LINE_A, subtotalAmount: 1 },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_refunded).toBe(7);
    expect(result.reconciliation.refunded_by_restock_type).toEqual({
      RETURN: 4,
      NO_RESTOCK: 2,
      CANCEL: 1,
    });
  });

  test("two refunds 227.50 (Feb) and 276.25 (May) -> 503.75 and per-month buckets", () => {
    const order = makeOrder({
      createdAt: "2025-02-01T12:00:00Z",
      refunds: [
        makeRefund({
          id: "feb",
          createdAt: "2025-02-15T12:00:00Z",
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 227.5 },
          ],
        }),
        makeRefund({
          id: "may",
          createdAt: "2025-05-15T12:00:00Z",
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 276.25 },
          ],
        }),
      ],
    });
    const result = countUnits(
      [order],
      makeParams({
        since: "2025-02-01",
        until: "2025-05-31",
        groupBy: "month",
      }),
    );
    expect(result.totals.refunded_amount).toBe(503.75);
    const byKey = Object.fromEntries(result.buckets.map((b) => [b.key, b]));
    expect(byKey["2025-02"].refunded_amount).toBe(227.5);
    expect(byKey["2025-03"].refunded_amount).toBe(0);
    expect(byKey["2025-04"].refunded_amount).toBe(0);
    expect(byKey["2025-05"].refunded_amount).toBe(276.25);
  });

  test("undated refund with null subtotalAmount stays out of units_refunded", () => {
    const order = makeOrder({
      refunds: [
        makeRefund({
          id: "gid://shopify/Refund/undated-null",
          createdAt: null,
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: null },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_refunded).toBe(0);
    expect(result.reconciliation.refunds_unattributed).toBe(1);
    expect(result.reconciliation.refunded_amount_unattributed).toBe(0);
    expect(result.warnings).toContain(
      "1 refund(s) have no createdAt and were not dated",
    );
    expect(
      result.warnings.some((w) =>
        w.includes("amount unknown"),
      ),
    ).toBe(false);
  });

  test("in-window null subtotalAmount counts units, excludes amount, warns", () => {
    const order = makeOrder({
      refunds: [
        makeRefund({
          id: "gid://shopify/Refund/null-amt",
          createdAt: "2025-03-05T12:00:00Z",
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: null },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_refunded).toBe(1);
    expect(result.totals.refunded_amount).toBe(0);
    expect(result.reconciliation.refunded_amount_unattributed).toBe(0);
    expect(result.warnings).toContain(
      "Refund gid://shopify/Refund/null-amt: amount unknown for 1 matching line(s); refunded_amount is understated",
    );
  });

  test("out-of-window refund with null amount produces no amount-unknown warning", () => {
    const order = makeOrder({
      refunds: [
        makeRefund({
          id: "gid://shopify/Refund/old-null",
          createdAt: "2024-01-05T12:00:00Z",
          lineItems: [
            { quantity: 2, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: null },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_refunded).toBe(0);
    expect(result.totals.refunded_amount).toBe(0);
    expect(
      result.warnings.some((w) => w.includes("gid://shopify/Refund/old-null")),
    ).toBe(false);
  });
});

describe("returns", () => {
  test("returns null -> units_returned null + warning and null reconciliation fields", () => {
    const order = makeOrder({ returns: null });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_returned).toBeNull();
    expect(result.reconciliation.returns_in_progress).toBeNull();
    expect(result.reconciliation.refunded_without_return).toBeNull();
    expect(result.reconciliation.returned_without_refund).toBeNull();
    expect(result.warnings).toContain(
      "read_returns scope missing: physical returns unavailable; refunds are reported separately",
    );
  });

  test("ANY order with returns null nulls the whole result even if others have data", () => {
    const result = countUnits(
      [
        makeOrder({ id: "a", returns: [makeReturn()] }),
        makeOrder({ id: "b", name: "#2", returns: null }),
      ],
      makeParams(),
    );
    expect(result.totals.units_returned).toBeNull();
    expect(result.warnings).toContain(
      "read_returns scope missing: physical returns unavailable; refunds are reported separately",
    );
  });

  test("CLOSED counted, OPEN in-progress, REQUESTED in-progress, DECLINED/CANCELED ignored", () => {
    const order = makeOrder({
      returns: [
        makeReturn({ id: "closed", status: "CLOSED", createdAt: "2025-03-06T12:00:00Z", lineItems: [{ quantity: 2, lineItemId: LINE_A }] }),
        makeReturn({ id: "open", status: "OPEN", createdAt: "2024-01-01T12:00:00Z", lineItems: [{ quantity: 3, lineItemId: LINE_A }] }),
        makeReturn({ id: "req", status: "REQUESTED", createdAt: "2025-06-01T12:00:00Z", lineItems: [{ quantity: 4, lineItemId: LINE_A }] }),
        makeReturn({ id: "dec", status: "DECLINED", createdAt: "2025-03-06T12:00:00Z", lineItems: [{ quantity: 9, lineItemId: LINE_A }] }),
        makeReturn({ id: "can", status: "CANCELED", createdAt: "2025-03-06T12:00:00Z", lineItems: [{ quantity: 8, lineItemId: LINE_A }] }),
        makeReturn({ id: "closed-out", status: "CLOSED", createdAt: "2024-01-01T12:00:00Z", lineItems: [{ quantity: 7, lineItemId: LINE_A }] }),
        makeReturn({ id: "null-li", status: "CLOSED", createdAt: "2025-03-06T12:00:00Z", lineItems: [{ quantity: 5, lineItemId: null }] }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_returned).toBe(2);
    expect(result.reconciliation.returns_in_progress).toBe(7);
  });

  test("refunded_without_return and returned_without_refund", () => {
    const moreRefunded = makeOrder({
      refunds: [makeRefund({ lineItems: [{ quantity: 5, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 }] })],
      returns: [makeReturn({ lineItems: [{ quantity: 2, lineItemId: LINE_A }] })],
    });
    const a = countUnits([moreRefunded], makeParams());
    expect(a.totals.units_refunded).toBe(5);
    expect(a.totals.units_returned).toBe(2);
    expect(a.reconciliation.refunded_without_return).toBe(3);
    expect(a.reconciliation.returned_without_refund).toBe(0);

    const moreReturned = makeOrder({
      refunds: [makeRefund({ lineItems: [{ quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 }] })],
      returns: [makeReturn({ lineItems: [{ quantity: 4, lineItemId: LINE_A }] })],
    });
    const b = countUnits([moreReturned], makeParams());
    expect(b.reconciliation.refunded_without_return).toBe(0);
    expect(b.reconciliation.returned_without_refund).toBe(3);
  });
});

describe("unfulfilled", () => {
  test("cancelled orders excluded from units_unfulfilled", () => {
    const live = makeOrder({
      id: "live",
      createdAt: "2025-01-15T12:00:00Z",
      cancelledAt: null,
      lineItems: [makeLine({ unfulfilledQuantity: 3 })],
      fulfillmentOrders: [makeFo({ lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 3, remainingQuantity: 3 }] })],
    });
    const dead = makeOrder({
      id: "dead",
      name: "#1002",
      createdAt: "2025-01-16T12:00:00Z",
      cancelledAt: "2025-01-20T12:00:00Z",
      lineItems: [makeLine({ unfulfilledQuantity: 9 })],
      fulfillmentOrders: [makeFo({ id: "fo2", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 9, remainingQuantity: 9 }] })],
    });
    const result = countUnits([live, dead], makeParams());
    expect(result.totals.units_unfulfilled).toBe(3);
    expect(result.reconciliation.unfulfilled_crosscheck).toEqual({
      fulfillment_order_remaining: 3,
      matches: true,
    });
  });

  test("fulfillmentOrders cross-check matches: false when remaining disagrees", () => {
    const order = makeOrder({
      lineItems: [makeLine({ unfulfilledQuantity: 2 })],
      fulfillmentOrders: [
        makeFo({
          status: "OPEN",
          lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 2, remainingQuantity: 1 }],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_unfulfilled).toBe(2);
    expect(result.reconciliation.unfulfilled_crosscheck).toEqual({
      fulfillment_order_remaining: 1,
      matches: false,
    });
  });

  test("CLOSED/CANCELLED/INCOMPLETE FO statuses are not remaining; non-matching lines ignored", () => {
    const order = makeOrder({
      lineItems: [
        makeLine({ id: LINE_A, sku: SKU_A, unfulfilledQuantity: 1 }),
        makeLine({ id: LINE_B, sku: "OTHER", unfulfilledQuantity: 4 }),
      ],
      fulfillmentOrders: [
        makeFo({ status: "OPEN", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 1 }] }),
        makeFo({ id: "fo-closed", status: "CLOSED", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 9 }] }),
        makeFo({ id: "fo-other", status: "OPEN", lineItems: [{ lineItemId: LINE_B, sku: "OTHER", totalQuantity: 4, remainingQuantity: 4 }] }),
        makeFo({ id: "fo-hold", status: "ON_HOLD", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 0 }] }),
        makeFo({ id: "fo-sched", status: "SCHEDULED", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 0 }] }),
        makeFo({ id: "fo-prog", status: "IN_PROGRESS", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 0 }] }),
        makeFo({ id: "fo-inc", status: "INCOMPLETE", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 5 }] }),
        makeFo({ id: "fo-can", status: "CANCELLED", lineItems: [{ lineItemId: LINE_A, sku: SKU_A, totalQuantity: 1, remainingQuantity: 5 }] }),
      ],
    });
    const result = countUnits([order], makeParams({ skus: [SKU_A] }));
    expect(result.reconciliation.unfulfilled_crosscheck).toEqual({
      fulfillment_order_remaining: 1,
      matches: true,
    });
  });

  test("fulfillmentOrders null -> warning and crosscheck null", () => {
    const order = makeOrder({
      lineItems: [makeLine({ unfulfilledQuantity: 1 })],
      fulfillmentOrders: null,
    });
    const result = countUnits(
      [order],
      makeParams({
        fulfillmentOrderScopesComplete: true,
        missingFulfillmentOrderScopes: ["read_merchant_managed_fulfillment_orders"],
      }),
    );
    expect(result.reconciliation.unfulfilled_crosscheck).toBeNull();
    expect(result.reconciliation.unfulfilled_crosscheck_missing_scopes).toEqual([
      "read_merchant_managed_fulfillment_orders",
    ]);
    expect(result.warnings).toContain(
      "fulfillment-order scopes missing (read_merchant_managed_fulfillment_orders): unfulfilled cross-check unavailable",
    );
  });

  test("fulfillmentOrderScopesComplete false with data present -> crosscheck null and scopes echoed", () => {
    const order = makeOrder({
      lineItems: [makeLine({ unfulfilledQuantity: 1 })],
      fulfillmentOrders: [makeFo()],
    });
    const result = countUnits(
      [order],
      makeParams({
        fulfillmentOrderScopesComplete: false,
        missingFulfillmentOrderScopes: ["read_third_party_fulfillment_orders"],
      }),
    );
    expect(result.reconciliation.unfulfilled_crosscheck).toBeNull();
    expect(result.reconciliation.unfulfilled_crosscheck_missing_scopes).toEqual([
      "read_third_party_fulfillment_orders",
    ]);
    expect(result.warnings).toContain(
      "fulfillment-order scopes missing (read_third_party_fulfillment_orders): unfulfilled cross-check unavailable",
    );
    expect(result.totals.units_unfulfilled).toBe(1);
  });

  test("missingFulfillmentOrderScopes undefined echoes []", () => {
    const result = countUnits(
      [makeOrder({ fulfillmentOrders: [makeFo()] })],
      makeParams({ fulfillmentOrderScopesComplete: false }),
    );
    expect(result.reconciliation.unfulfilled_crosscheck_missing_scopes).toEqual([]);
    expect(result.warnings).toContain(
      "fulfillment-order scopes missing (): unfulfilled cross-check unavailable",
    );
  });

  test("until before asOf local date -> unfulfilled_as_of warning; until == asOf date -> none", () => {
    const order = makeOrder({
      createdAt: "2025-01-15T12:00:00Z",
      lineItems: [makeLine({ unfulfilledQuantity: 1 })],
    });
    const before = countUnits(
      [order],
      makeParams({
        since: "2025-01-01",
        until: "2025-01-31",
        asOf: "2025-02-01T12:00:00Z",
      }),
    );
    expect(before.warnings).toContain(
      "units_unfulfilled is the outstanding quantity as of 2025-02-01T12:00:00Z, not as of 2025-01-31",
    );

    const equal = countUnits(
      [order],
      makeParams({
        since: "2025-01-01",
        until: "2025-02-01",
        asOf: "2025-02-01T12:00:00Z",
      }),
    );
    expect(
      equal.warnings.some((w) => w.startsWith("units_unfulfilled is the outstanding")),
    ).toBe(false);

    const after = countUnits(
      [order],
      makeParams({
        since: "2025-01-01",
        until: "2025-03-01",
        asOf: "2025-02-01T12:00:00Z",
      }),
    );
    expect(
      after.warnings.some((w) => w.startsWith("units_unfulfilled is the outstanding")),
    ).toBe(false);
  });
});

describe("basis orders count", () => {
  const mixedClock = makeOrder({
    createdAt: "2025-01-15T12:00:00Z",
    fulfillments: [makeFulfillment({ createdAt: "2025-02-10T12:00:00Z" })],
    refunds: [makeRefund({ createdAt: "2025-03-05T12:00:00Z" })],
  });

  test("basis order/fulfillment/refund change the orders count only", () => {
    const window = { since: "2025-02-01", until: "2025-02-28" } as const;
    const ordered = countUnits([mixedClock], makeParams({ ...window, basis: "order" }));
    const shipped = countUnits([mixedClock], makeParams({ ...window, basis: "fulfillment" }));
    const refunded = countUnits([mixedClock], makeParams({ ...window, basis: "refund" }));

    expect(ordered.totals.orders).toBe(0);
    expect(shipped.totals.orders).toBe(1);
    expect(refunded.totals.orders).toBe(0);

    expect(ordered.totals.units_ordered).toBe(shipped.totals.units_ordered);
    expect(ordered.totals.units_shipped).toBe(shipped.totals.units_shipped);
    expect(ordered.totals.units_refunded).toBe(refunded.totals.units_refunded);
    expect(ordered.totals.units_shipped).toBe(1);
    expect(ordered.totals.units_ordered).toBe(0);
  });

  test("basis refund counts the order when an in-window refund contains a matching line", () => {
    const order = makeOrder({
      createdAt: "2024-12-01T12:00:00Z",
      refunds: [makeRefund({ createdAt: "2025-03-05T12:00:00Z" })],
    });
    const result = countUnits(
      [order],
      makeParams({ since: "2025-03-01", until: "2025-03-31", basis: "refund" }),
    );
    expect(result.totals.orders).toBe(1);
    expect(result.totals.units_ordered).toBe(0);
    expect(result.totals.units_refunded).toBe(1);
  });

  test("basis refund on mixed-product order whose in-window refund contains only a non-matching line -> orders 0", () => {
    const order = makeOrder({
      createdAt: "2025-01-15T12:00:00Z",
      lineItems: [
        makeLine({ id: LINE_A, sku: SKU_A }),
        makeLine({ id: LINE_B, sku: "OTHER" }),
      ],
      refunds: [
        makeRefund({
          createdAt: "2025-03-05T12:00:00Z",
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_B, subtotalAmount: 5 },
          ],
        }),
      ],
    });
    const result = countUnits(
      [order],
      makeParams({ skus: [SKU_A], basis: "refund" }),
    );
    expect(result.matched_orders).toBe(1);
    expect(result.totals.orders).toBe(0);
    expect(result.totals.units_refunded).toBe(0);
  });

  test("basis fulfillment on mixed-product order whose in-window fulfillment contains only a non-matching line -> orders 0", () => {
    const order = makeOrder({
      createdAt: "2025-01-15T12:00:00Z",
      lineItems: [
        makeLine({ id: LINE_A, sku: SKU_A, quantity: 1 }),
        makeLine({ id: LINE_B, sku: "OTHER", quantity: 1 }),
      ],
      fulfillments: [
        makeFulfillment({
          createdAt: "2025-02-10T12:00:00Z",
          lineItems: [{ quantity: 1, lineItemId: LINE_B }],
        }),
      ],
    });
    const result = countUnits(
      [order],
      makeParams({
        skus: [SKU_A],
        since: "2025-02-01",
        until: "2025-02-28",
        basis: "fulfillment",
      }),
    );
    expect(result.matched_orders).toBe(1);
    expect(result.totals.orders).toBe(0);
    expect(result.totals.units_shipped).toBe(0);
  });

  test("non-SUCCESS fulfillment does not count for basis or shipped", () => {
    const order = makeOrder({
      fulfillments: [
        makeFulfillment({ status: "PENDING", createdAt: "2025-01-20T12:00:00Z" }),
        makeFulfillment({
          id: "f2",
          status: "CANCELLED",
          createdAt: "2025-01-21T12:00:00Z",
        }),
        makeFulfillment({
          id: "f3",
          status: "SUCCESS",
          createdAt: "2024-01-01T12:00:00Z",
        }),
      ],
    });
    const result = countUnits(
      [order],
      makeParams({ basis: "fulfillment" }),
    );
    expect(result.totals.orders).toBe(0);
    expect(result.totals.units_shipped).toBe(0);
  });
});

describe("buckets", () => {
  test("month buckets zero-filled across a year boundary with each metric on its own month", () => {
    const order = makeOrder({
      createdAt: "2024-12-30T12:00:00Z",
      cancelledAt: "2025-01-20T12:00:00Z",
      lineItems: [makeLine({ quantity: 1, currentQuantity: 0, unfulfilledQuantity: 0 })],
      fulfillments: [makeFulfillment({ createdAt: "2025-01-02T12:00:00Z" })],
      refunds: [makeRefund({ createdAt: "2025-01-20T15:00:00Z" })],
      returns: [makeReturn({ status: "CLOSED", createdAt: "2025-01-21T12:00:00Z" })],
    });
    const result = countUnits(
      [order],
      makeParams({
        since: "2024-11-01",
        until: "2025-01-31",
        groupBy: "month",
        basis: "order",
      }),
    );
    expect(result.buckets.map((b) => b.key)).toEqual([
      "2024-11",
      "2024-12",
      "2025-01",
    ]);
    const nov = result.buckets[0];
    const dec = result.buckets[1];
    const jan = result.buckets[2];
    expect(nov).toMatchObject({
      ...zeros(0),
      key: "2024-11",
    });
    expect(dec.units_ordered).toBe(1);
    expect(dec.units_ordered_current).toBe(0);
    expect(dec.units_shipped).toBe(0);
    expect(dec.units_cancelled).toBe(0);
    expect(dec.orders).toBe(1);
    expect(jan.units_ordered).toBe(0);
    expect(jan.units_shipped).toBe(0); // cancelled + refunded adjustment
    expect(jan.units_cancelled).toBe(1);
    expect(jan.units_refunded).toBe(1);
    expect(jan.units_returned).toBe(1);
    expect(jan.orders).toBe(0);
  });

  test("month bucket orders follow the basis-event month", () => {
    const order = makeOrder({
      createdAt: "2024-12-30T12:00:00Z",
      lineItems: [
        makeLine({ id: LINE_A, sku: SKU_A, quantity: 1 }),
        makeLine({ id: LINE_B, sku: "OTHER", quantity: 1 }),
      ],
      fulfillments: [
        makeFulfillment({
          id: "pending",
          status: "PENDING",
          createdAt: "2025-01-03T12:00:00Z",
          lineItems: [{ quantity: 1, lineItemId: LINE_A }],
        }),
        makeFulfillment({
          id: "too-early",
          status: "SUCCESS",
          createdAt: "2024-11-02T12:00:00Z",
          lineItems: [{ quantity: 1, lineItemId: LINE_A }],
        }),
        makeFulfillment({
          id: "other-sku",
          status: "SUCCESS",
          createdAt: "2025-01-04T12:00:00Z",
          lineItems: [{ quantity: 1, lineItemId: LINE_B }],
        }),
        makeFulfillment({ createdAt: "2025-01-02T12:00:00Z" }),
      ],
    });
    const byFulfillment = countUnits(
      [order],
      makeParams({
        since: "2024-12-01",
        until: "2025-01-31",
        groupBy: "month",
        basis: "fulfillment",
        skus: [SKU_A],
      }),
    );
    const byKey = Object.fromEntries(byFulfillment.buckets.map((b) => [b.key, b]));
    expect(byKey["2024-12"].orders).toBe(0);
    expect(byKey["2025-01"].orders).toBe(1);
    expect(byKey["2024-12"].units_ordered).toBe(1);
    expect(byKey["2025-01"].units_shipped).toBe(1);
  });

  test("month buckets for basis refund use the refund month, including two refunds in the same month", () => {
    const order = makeOrder({
      createdAt: "2024-12-01T12:00:00Z",
      refunds: [
        makeRefund({
          id: "r1",
          createdAt: "2025-02-10T12:00:00Z",
          lineItems: [{ quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 }],
        }),
        makeRefund({
          id: "r2",
          createdAt: "2025-02-20T12:00:00Z",
          lineItems: [{ quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 }],
        }),
        makeRefund({
          id: "r3",
          createdAt: "2025-05-01T12:00:00Z",
          lineItems: [{ quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 }],
        }),
        makeRefund({
          id: "undated",
          createdAt: null,
          lineItems: [{ quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 }],
        }),
        makeRefund({
          id: "outside",
          createdAt: "2024-12-15T12:00:00Z",
          lineItems: [{ quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 1 }],
        }),
        makeRefund({
          id: "other-sku",
          createdAt: "2025-03-01T12:00:00Z",
          lineItems: [{ quantity: 1, restockType: "RETURN", lineItemId: LINE_B, subtotalAmount: 1 }],
        }),
      ],
    });
    const result = countUnits(
      [order],
      makeParams({
        since: "2025-02-01",
        until: "2025-05-31",
        groupBy: "month",
        basis: "refund",
      }),
    );
    const byKey = Object.fromEntries(result.buckets.map((b) => [b.key, b]));
    expect(result.totals.orders).toBe(1);
    expect(byKey["2025-02"].orders).toBe(1);
    expect(byKey["2025-03"].orders).toBe(0);
    expect(byKey["2025-05"].orders).toBe(1);
    expect(byKey["2025-02"].units_refunded).toBe(2);
    expect(byKey["2025-05"].units_refunded).toBe(1);
  });

  test("month buckets ignore a monthKey outside time.months()", () => {
    const since = "2025-01-01";
    const until = "2025-01-31";
    const base = utcTime(since, until);
    const time: TimeAdapter = {
      localDate: (iso) => base.localDate(iso),
      inWindow: (iso) => base.inWindow(iso),
      months: () => base.months(),
      monthKey: () => "2099-01",
    };
    const result = countUnits(
      [makeOrder()],
      makeParams({ since, until, groupBy: "month", time }),
    );
    expect(result.buckets.map((b) => b.key)).toEqual(["2025-01"]);
    expect(result.totals.units_ordered).toBe(1);
    expect(result.buckets[0].units_ordered).toBe(0);
  });

  test("channel buckets with null sourceName -> unknown, sorted by key", () => {
    const web = makeOrder({
      id: "web",
      sourceName: "web",
      createdAt: "2025-01-15T12:00:00Z",
      lineItems: [makeLine({ quantity: 2 })],
    });
    const unknown = makeOrder({
      id: "unk",
      name: "#1002",
      sourceName: null,
      createdAt: "2025-01-16T12:00:00Z",
      lineItems: [makeLine({ quantity: 3 })],
    });
    const iphone = makeOrder({
      id: "iphone",
      name: "#1003",
      sourceName: "iphone",
      createdAt: "2025-01-17T12:00:00Z",
      lineItems: [makeLine({ quantity: 1 })],
    });
    const web2 = makeOrder({
      id: "web2",
      name: "#1004",
      sourceName: "web",
      createdAt: "2025-01-18T12:00:00Z",
      lineItems: [makeLine({ quantity: 7 })],
    });
    const result = countUnits(
      [web, unknown, iphone, web2],
      makeParams({ groupBy: "channel" }),
    );
    expect(result.buckets.map((b) => b.key)).toEqual(["iphone", "unknown", "web"]);
    expect(result.buckets.find((b) => b.key === "unknown")?.units_ordered).toBe(3);
    expect(result.buckets.find((b) => b.key === "web")?.units_ordered).toBe(9);
    expect(result.buckets.find((b) => b.key === "iphone")?.units_ordered).toBe(1);
  });

  test("month and channel buckets carry units_returned null when the returns scope is missing", () => {
    const order = makeOrder({
      sourceName: null,
      returns: null,
      lineItems: [makeLine({ quantity: 1 })],
    });
    const month = countUnits(
      [order],
      makeParams({ since: "2025-01-01", until: "2025-01-31", groupBy: "month" }),
    );
    expect(month.buckets[0].units_returned).toBeNull();
    const channel = countUnits(
      [order],
      makeParams({ groupBy: "channel" }),
    );
    expect(channel.buckets[0].units_returned).toBeNull();
    expect(channel.buckets[0].key).toBe("unknown");
  });
});

describe("timezone adapter deferral", () => {
  test("2026-07-27T03:40:26Z lands on 2026-07-26 via UTC-5 adapter, not Date math in the engine", () => {
    const iso = "2026-07-27T03:40:26Z";
    const order = makeOrder({
      createdAt: iso,
      lineItems: [makeLine({ unfulfilledQuantity: 1 })],
    });

    const countedTime = offsetTime(-5, "2026-07-01", "2026-07-26");
    const counted = countUnits(
      [order],
      makeParams({
        since: "2026-07-01",
        until: "2026-07-26",
        asOf: "2026-07-26T22:00:00Z",
        time: countedTime,
        tz: "America/Chicago",
      }),
    );
    expect(countedTime.localDate(iso)).toBe("2026-07-26");
    expect(counted.totals.units_ordered).toBe(1);
    expect(counted.totals.orders).toBe(1);
    expect(counted.orders_evidence[0].created_shop_date).toBe("2026-07-26");

    const skippedTime = offsetTime(-5, "2026-07-27", "2026-07-31");
    const skipped = countUnits(
      [order],
      makeParams({
        since: "2026-07-27",
        until: "2026-07-31",
        asOf: "2026-07-31T22:00:00Z",
        time: skippedTime,
        tz: "America/Chicago",
      }),
    );
    expect(skipped.totals.units_ordered).toBe(0);
    expect(skipped.totals.orders).toBe(0);
    expect(skipped.matched_orders).toBe(1);
    expect(skipped.orders_evidence[0].created_shop_date).toBe("2026-07-26");
  });
});

describe("test orders", () => {
  test("excluded and counted in warnings; includeTestOrders true includes them", () => {
    const real = makeOrder({
      id: "real",
      test: false,
      lineItems: [makeLine({ quantity: 1 })],
    });
    const testOrder = makeOrder({
      id: "test",
      name: "#T",
      test: true,
      createdAt: "2025-01-16T12:00:00Z",
      lineItems: [makeLine({ quantity: 4 })],
    });
    const excluded = countUnits(
      [real, testOrder],
      makeParams({ includeTestOrders: false }),
    );
    expect(excluded.totals.units_ordered).toBe(1);
    expect(excluded.matched_orders).toBe(1);
    expect(excluded.warnings).toContain("1 test order(s) excluded");

    const included = countUnits(
      [real, testOrder],
      makeParams({ includeTestOrders: true }),
    );
    expect(included.totals.units_ordered).toBe(5);
    expect(included.matched_orders).toBe(2);
    expect(included.warnings.some((w) => w.includes("test order"))).toBe(false);

    const twoTests = countUnits(
      [
        makeOrder({ id: "t1", test: true }),
        makeOrder({ id: "t2", name: "#2", test: true }),
      ],
      makeParams({ includeTestOrders: false }),
    );
    expect(twoTests.warnings).toContain("2 test order(s) excluded");
    expect(twoTests.matched_orders).toBe(0);
  });
});

describe("null fulfillment line quantity", () => {
  test("shipped_unattributed 1, units_shipped unchanged, warning names the fulfillment", () => {
    const fid = "gid://shopify/Fulfillment/null-qty";
    const order = makeOrder({
      fulfillments: [
        makeFulfillment({
          id: fid,
          createdAt: "2025-01-20T12:00:00Z",
          lineItems: [{ quantity: null, lineItemId: LINE_A }],
        }),
        makeFulfillment({
          id: "gid://shopify/Fulfillment/ok",
          createdAt: "2025-01-21T12:00:00Z",
          lineItems: [{ quantity: 2, lineItemId: LINE_A }],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.units_shipped).toBe(2);
    expect(result.reconciliation.shipped_gross).toBe(2);
    expect(result.reconciliation.shipped_unattributed).toBe(1);
    expect(
      result.warnings.some((w) => w.includes(fid) && /null/i.test(w)),
    ).toBe(true);
    expect(result.orders_evidence[0].shipped).toBe(2);
  });

  test("two SUCCESS fulfillments on the same instant still ship both quantities", () => {
    const order = makeOrder({
      fulfillments: [
        makeFulfillment({
          id: "f1",
          createdAt: "2025-01-20T12:00:00Z",
          lineItems: [{ quantity: 1, lineItemId: LINE_A }],
        }),
        makeFulfillment({
          id: "f2",
          createdAt: "2025-01-20T12:00:00Z",
          lineItems: [{ quantity: 3, lineItemId: LINE_A }],
        }),
      ],
    });
    const result = countUnits(
      [order],
      makeParams({ groupBy: "month", basis: "fulfillment" }),
    );
    expect(result.totals.units_shipped).toBe(4);
    expect(result.totals.orders).toBe(1);
    expect(result.buckets.find((b) => b.key === "2025-01")?.orders).toBe(1);
  });
});

describe("evidence cap", () => {
  test("evidenceLimit 2 with 3 matched orders -> truncated, aggregates still 3", () => {
    const orders = [3, 1, 2].map((n) =>
      makeOrder({
        id: `gid://shopify/Order/${n}`,
        name: `#${1000 + n}`,
        createdAt: `2025-01-${String(10 + n).padStart(2, "0")}T12:00:00Z`,
        lineItems: [makeLine({ quantity: 1 })],
      }),
    );
    const result = countUnits(
      orders,
      makeParams({ evidenceLimit: 2 }),
    );
    expect(result.orders_truncated).toBe(true);
    expect(result.orders_evidence).toHaveLength(2);
    expect(result.matched_orders).toBe(3);
    expect(result.totals.units_ordered).toBe(3);
    expect(result.totals.orders).toBe(3);
    expect(result.orders_evidence[0].created_at).toBe("2025-01-11T12:00:00Z");
    expect(result.orders_evidence[1].created_at).toBe("2025-01-12T12:00:00Z");
    expect(result.orders_evidence[0].refunded_amount).toBe(0);
  });

  test("same createdAt sorts evidence by id; returned is null when returns are null", () => {
    const b = makeOrder({
      id: "gid://shopify/Order/b",
      name: "#B",
      createdAt: "2025-01-15T12:00:00Z",
      returns: null,
    });
    const a = makeOrder({
      id: "gid://shopify/Order/a",
      name: "#A",
      createdAt: "2025-01-15T12:00:00Z",
      returns: null,
    });
    const result = countUnits([b, a], makeParams({ evidenceLimit: 10 }));
    expect(result.orders_evidence.map((e) => e.id)).toEqual([
      "gid://shopify/Order/a",
      "gid://shopify/Order/b",
    ]);
    expect(result.orders_evidence[0].returned).toBeNull();
  });

  test("default cap 500 does not truncate 3 orders; evidence includes refunded_amount", () => {
    const order = makeOrder({
      refunds: [
        makeRefund({
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 12.34 },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.orders_truncated).toBe(false);
    expect(result.orders_evidence).toHaveLength(1);
    expect(result.orders_evidence[0].refunded_amount).toBe(12.34);
    expect(result.orders_evidence[0].refunded).toBe(1);
    expect(result.orders_evidence[0].returned).toBe(0);
    expect(result.orders_evidence[0].created_shop_date).toBe("2025-01-15");
  });
});

describe("currentQuantity and unmatched orders", () => {
  test("units_ordered_current uses currentQuantity; unmatched SKU is dropped", () => {
    const matched = makeOrder({
      lineItems: [makeLine({ quantity: 5, currentQuantity: 2 })],
    });
    const unmatched = makeOrder({
      id: "other",
      name: "#x",
      lineItems: [makeLine({ id: LINE_B, sku: "NOPE", quantity: 9 })],
    });
    const result = countUnits([matched, unmatched], makeParams({ skus: [SKU_A] }));
    expect(result.totals.units_ordered).toBe(5);
    expect(result.totals.units_ordered_current).toBe(2);
    expect(result.matched_orders).toBe(1);
  });
});

describe("refunded_amount rounding", () => {
  test("sums then rounds to 2 decimals", () => {
    const order = makeOrder({
      refunds: [
        makeRefund({
          id: "a",
          createdAt: "2025-03-01T00:00:00Z",
          lineItems: [
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 0.1 },
            { quantity: 1, restockType: "RETURN", lineItemId: LINE_A, subtotalAmount: 0.2 },
          ],
        }),
      ],
    });
    const result = countUnits([order], makeParams());
    expect(result.totals.refunded_amount).toBe(0.3);
  });
});
