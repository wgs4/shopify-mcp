// I/O tests for product-order-history fetch: candidate filter, bulk vs
// cursor, pagination, throttle, details batching, document selection, mapping.
// Fake client only; no network. Must FAIL if the fetch layer is missing.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import { SCOPE_CACHE_TTL_MS, _resetForTest as resetScopes } from "./accessScopes.js";
import {
  DETAILS_BATCH_SIZE,
  FO_DETAIL_SCOPES,
  ORDER_HISTORY_CANDIDATES_QUERY,
  ORDER_HISTORY_DETAILS_BOTH,
  ORDER_HISTORY_DETAILS_FO,
  ORDER_HISTORY_DETAILS_NONE,
  ORDER_HISTORY_DETAILS_RETURNS,
  THROTTLE_MAX_SLEEP_MS,
  _resetForTest,
  applyOrderFilter,
  assertSingleDetailsPage,
  buildCandidateFilter,
  chunkIds,
  escapeBulkFilter,
  fetchCandidates,
  fetchOrderDetails,
  getShopTimezone,
  mapDetailNodeToRawOrder,
  readThrottleExtensions,
  selectDetailsDocument,
  shouldUseBulk,
  throttleDelayMs,
  type CandidateOrder,
  type DetailOrderNode,
  type OrderHistoryFetchDeps,
} from "./orderHistoryFetch.js";
import { shopDayStartOffsetIso, nextDay } from "./shopTime.js";

afterEach(() => {
  _resetForTest();
  resetScopes();
});

const CHICAGO = "America/Chicago";
const NEW_YORK = "America/New_York";
const AMPLE_COST = {
  cost: {
    requestedQueryCost: 12,
    throttleStatus: {
      currentlyAvailable: 10_000,
      restoreRate: 50,
      maximumAvailable: 10_000,
    },
  },
};

function fakeClient(): {
  client: GraphQLClient;
  request: jest.Mock;
  rawRequest: jest.Mock;
} {
  const request = jest.fn();
  const rawRequest = jest.fn();
  return {
    client: { request, rawRequest } as unknown as GraphQLClient,
    request,
    rawRequest,
  };
}

function rawOk<T>(data: T, extensions: unknown = AMPLE_COST) {
  return {
    data,
    extensions,
    headers: {},
    status: 200,
  };
}

function opName(query: unknown): string {
  const text = String(query);
  const match = /\b(?:query|mutation)\s+(\w+)/.exec(text);
  return match ? match[1] : "";
}

function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

function lineNode(id: string, sku: string) {
  return {
    id,
    sku,
    title: sku,
    quantity: 1,
    currentQuantity: 1,
    unfulfilledQuantity: 0,
    refundableQuantity: 1,
    nonFulfillableQuantity: 0,
    product: { id: "gid://shopify/Product/1" },
  };
}

function candidateNode(id: string, name: string, sku: string, extra?: {
  hasNextLinePage?: boolean;
  endCursor?: string;
}) {
  return {
    id,
    name,
    createdAt: "2026-07-27T03:40:26Z",
    processedAt: "2026-07-27T03:40:26Z",
    updatedAt: "2026-07-27T14:20:18Z",
    cancelledAt: null,
    cancelReason: null,
    sourceName: "web",
    test: false,
    tags: [],
    lineItems: {
      pageInfo: {
        hasNextPage: extra?.hasNextLinePage === true,
        endCursor: extra?.endCursor ?? null,
      },
      edges: [{ node: lineNode(`${id}/li1`, sku) }],
    },
    fulfillments: [{ id: `${id}/f1`, status: "SUCCESS", createdAt: "2026-07-27T14:20:18Z" }],
    refunds: [],
  };
}

describe("buildCandidateFilter", () => {
  test("uses shop-local offset ISO for Chicago (CDT)", () => {
    const since = "2026-07-05";
    const until = "2026-09-03";
    const filter = buildCandidateFilter(since, until, CHICAGO);
    const createdBefore = shopDayStartOffsetIso(nextDay(until), CHICAGO);
    const updatedFrom = shopDayStartOffsetIso(since, CHICAGO);
    expect(createdBefore).toBe("2026-09-04T00:00:00-05:00");
    expect(updatedFrom).toBe("2026-07-05T00:00:00-05:00");
    expect(filter).toBe(
      `created_at:<'${createdBefore}' updated_at:>='${updatedFrom}'`,
    );
  });

  test("uses shop-local offset ISO for New_York (EDT vs EST)", () => {
    expect(shopDayStartOffsetIso("2026-07-05", NEW_YORK)).toBe(
      "2026-07-05T00:00:00-04:00",
    );
    expect(shopDayStartOffsetIso("2026-01-15", NEW_YORK)).toBe(
      "2026-01-15T00:00:00-05:00",
    );
    const summer = buildCandidateFilter("2026-07-05", "2026-07-10", NEW_YORK);
    expect(summer).toContain("2026-07-11T00:00:00-04:00");
    expect(summer).toContain("2026-07-05T00:00:00-04:00");
    const winter = buildCandidateFilter("2026-01-15", "2026-01-20", NEW_YORK);
    expect(winter).toContain("2026-01-21T00:00:00-05:00");
    expect(winter).toContain("2026-01-15T00:00:00-05:00");
  });
});

describe("shouldUseBulk", () => {
  test("cursor at 90 inclusive days, bulk at 91, force_bulk always bulk", () => {
    expect(shouldUseBulk("2026-01-01", "2026-03-31", false)).toBe(false);
    expect(shouldUseBulk("2026-01-01", "2026-04-01", false)).toBe(true);
    expect(shouldUseBulk("2026-09-01", "2026-09-01", true)).toBe(true);
    expect(shouldUseBulk("2026-09-01", "2026-09-01", false)).toBe(false);
  });
});

describe("escapeBulkFilter / applyOrderFilter", () => {
  test("escapes double quotes in the spliced filter", () => {
    expect(escapeBulkFilter('sku:"7711-P"')).toBe('sku:\\"7711-P\\"');
    const applied = applyOrderFilter(
      '{ orders(query: "__ORDER_FILTER__") { id } }',
      'tag:"rush"',
    );
    expect(applied).toBe('{ orders(query: "tag:\\"rush\\"") { id } }');
  });
});

describe("throttleDelayMs", () => {
  test("zero when currentlyAvailable covers last cost * 2 + 200", () => {
    expect(throttleDelayMs(10_000, 12, 50)).toBe(0);
    expect(throttleDelayMs(400, 100, 50)).toBe(0);
  });

  test("ceils deficit / restoreRate seconds, caps at 30s, restoreRate <= 0 is cap", () => {
    // needed = 100*2+200 = 400; deficit 350; restore 50 -> 7s
    expect(throttleDelayMs(50, 100, 50)).toBe(7_000);
    expect(throttleDelayMs(50, 100, 1)).toBe(THROTTLE_MAX_SLEEP_MS);
    expect(throttleDelayMs(50, 100, 0)).toBe(THROTTLE_MAX_SLEEP_MS);
    expect(throttleDelayMs(50, 100, -1)).toBe(THROTTLE_MAX_SLEEP_MS);
  });

  test("readThrottleExtensions parses cost.throttleStatus and ignores junk", () => {
    expect(readThrottleExtensions(AMPLE_COST)).toEqual({
      requestedQueryCost: 12,
      currentlyAvailable: 10_000,
      restoreRate: 50,
    });
    expect(readThrottleExtensions(null)).toBeNull();
    expect(readThrottleExtensions({ cost: { requestedQueryCost: "nope" } })).toBeNull();
    expect(
      readThrottleExtensions({ cost: { requestedQueryCost: 8 } }),
    ).toEqual({
      requestedQueryCost: 8,
      currentlyAvailable: Number.POSITIVE_INFINITY,
      restoreRate: 50,
    });
  });
});

describe("chunkIds", () => {
  test("splits 45 ids into 20/20/5", () => {
    const ids = Array.from({ length: 45 }, (_, i) => `gid://shopify/Order/${i + 1}`);
    const chunks = chunkIds(ids, DETAILS_BATCH_SIZE);
    expect(chunks.map((c) => c.length)).toEqual([20, 20, 5]);
    expect(chunks[0][0]).toBe("gid://shopify/Order/1");
    expect(chunks[2][4]).toBe("gid://shopify/Order/45");
  });

  test("empty and exact-size lists", () => {
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(["a"], 20)).toEqual([["a"]]);
    expect(chunkIds(Array.from({ length: 20 }, (_, i) => String(i)))).toHaveLength(1);
  });
});

describe("selectDetailsDocument", () => {
  test("none / returns / fulfillmentOrders / both, including write_* twins", () => {
    expect(selectDetailsDocument(["read_orders"])).toBe(ORDER_HISTORY_DETAILS_NONE);
    expect(selectDetailsDocument(["read_returns"])).toBe(
      ORDER_HISTORY_DETAILS_RETURNS,
    );
    expect(selectDetailsDocument(["write_returns"])).toBe(
      ORDER_HISTORY_DETAILS_RETURNS,
    );
    expect(selectDetailsDocument([...FO_DETAIL_SCOPES])).toBe(
      ORDER_HISTORY_DETAILS_FO,
    );
    expect(
      selectDetailsDocument([
        "write_merchant_managed_fulfillment_orders",
        "write_assigned_fulfillment_orders",
        "write_third_party_fulfillment_orders",
      ]),
    ).toBe(ORDER_HISTORY_DETAILS_FO);
    expect(selectDetailsDocument(["read_returns", ...FO_DETAIL_SCOPES])).toBe(
      ORDER_HISTORY_DETAILS_BOTH,
    );
    expect(ORDER_HISTORY_DETAILS_NONE).not.toMatch(/\breturns\(/);
    expect(ORDER_HISTORY_DETAILS_NONE).not.toMatch(/\bfulfillmentOrders\(/);
    expect(ORDER_HISTORY_DETAILS_RETURNS).toMatch(/\breturns\(/);
    expect(ORDER_HISTORY_DETAILS_RETURNS).not.toMatch(/\bfulfillmentOrders\(/);
    expect(ORDER_HISTORY_DETAILS_FO).toMatch(/\bfulfillmentOrders\(/);
    expect(ORDER_HISTORY_DETAILS_FO).not.toMatch(/\breturns\(/);
    expect(ORDER_HISTORY_DETAILS_BOTH).toMatch(/\breturns\(/);
    expect(ORDER_HISTORY_DETAILS_BOTH).toMatch(/\bfulfillmentOrders\(/);
  });
});

describe("getShopTimezone", () => {
  test("caches per client within TTL and refetches after", async () => {
    const a = fakeClient();
    const b = fakeClient();
    a.request.mockResolvedValue({ shop: { ianaTimezone: CHICAGO } });
    b.request.mockResolvedValue({ shop: { ianaTimezone: NEW_YORK } });
    const t0 = 1_000_000;
    await expect(getShopTimezone(a.client, { nowMs: t0 })).resolves.toBe(CHICAGO);
    await expect(
      getShopTimezone(a.client, { nowMs: t0 + SCOPE_CACHE_TTL_MS - 1 }),
    ).resolves.toBe(CHICAGO);
    expect(a.request).toHaveBeenCalledTimes(1);
    expect(String(a.request.mock.calls[0][0])).toMatch(/ShopTimezone/);
    await expect(getShopTimezone(b.client, { nowMs: t0 })).resolves.toBe(NEW_YORK);
    expect(b.request).toHaveBeenCalledTimes(1);
    await expect(
      getShopTimezone(a.client, { nowMs: t0 + SCOPE_CACHE_TTL_MS }),
    ).resolves.toBe(CHICAGO);
    expect(a.request).toHaveBeenCalledTimes(2);
  });

  test("force bypasses cache; missing ianaTimezone throws and is not cached", async () => {
    const { client, request } = fakeClient();
    request
      .mockResolvedValueOnce({ shop: { ianaTimezone: CHICAGO } })
      .mockResolvedValueOnce({ shop: { ianaTimezone: NEW_YORK } });
    const t0 = 1_000_000;
    await getShopTimezone(client, { nowMs: t0 });
    await expect(
      getShopTimezone(client, { nowMs: t0 + 1, force: true }),
    ).resolves.toBe(NEW_YORK);
    expect(request).toHaveBeenCalledTimes(2);

    const missing = fakeClient();
    missing.request.mockResolvedValue({ shop: null });
    await expect(getShopTimezone(missing.client)).rejects.toThrow(
      /ianaTimezone missing/,
    );
    missing.request.mockResolvedValue({ shop: { ianaTimezone: CHICAGO } });
    await expect(getShopTimezone(missing.client)).resolves.toBe(CHICAGO);
  });
});

describe("fetchCandidates cursor", () => {
  test("paginates two order pages and continues lineItems", async () => {
    const { client, rawRequest } = fakeClient();
    const sleeper = recordingSleep();
    rawRequest.mockImplementation(async (query: unknown, variables?: unknown) => {
      const name = opName(query);
      if (name === "OrderHistoryCandidates") {
        const vars = variables as { after?: string } | undefined;
        if (!vars?.after) {
          return rawOk({
            orders: {
              edges: [
                {
                  node: candidateNode(
                    "gid://shopify/Order/1",
                    "#1",
                    "AAA",
                    { hasNextLinePage: true, endCursor: "li-cursor" },
                  ),
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "page-2" },
            },
          });
        }
        return rawOk({
          orders: {
            edges: [
              { node: candidateNode("gid://shopify/Order/2", "#2", "BBB") },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      if (name === "OrderLineItemsPage") {
        return rawOk({
          order: {
            lineItems: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                { node: lineNode("gid://shopify/LineItem/extra", "AAA-2") },
              ],
            },
          },
        });
      }
      throw new Error(`unexpected operation ${name}`);
    });

    const result = await fetchCandidates(
      client,
      { since: "2026-07-05", until: "2026-07-10", tz: CHICAGO },
      { sleep: sleeper.sleep },
    );
    expect(result.kind).toBe("cursor");
    expect(result.bulkOperationId).toBeNull();
    expect(result.orders).toHaveLength(2);
    expect(result.orders[0].lineItems).toHaveLength(2);
    expect(result.orders[0].lineItems[1].sku).toBe("AAA-2");
    expect(result.orders[1].id).toBe("gid://shopify/Order/2");
    expect(result.requests).toBe(3);
    expect(result.query).toContain("created_at:<");
    expect(ORDER_HISTORY_CANDIDATES_QUERY).toMatch(/OrderHistoryCandidates/);
  });

  test("uses bulk when forceBulk or span > 90 days", async () => {
    const { client, rawRequest } = fakeClient();
    const runBulkQuery = jest.fn(async (_c: GraphQLClient, inner: string) => {
      expect(inner).toContain("created_at:<");
      expect(inner).not.toContain("__ORDER_FILTER__");
      return {
        id: "gid://shopify/BulkOperation/9",
        objectCount: 2,
        rootObjectCount: 1,
        rows: [
          {
            id: "gid://shopify/Order/1",
            name: "#1",
            createdAt: "2026-01-02T00:00:00Z",
            cancelledAt: null,
            sourceName: "web",
            test: false,
            tags: [],
            fulfillments: [],
            refunds: [],
          },
          {
            id: "gid://shopify/LineItem/1",
            __parentId: "gid://shopify/Order/1",
            sku: "7711-P",
            title: "Macrodose",
            quantity: 1,
            currentQuantity: 1,
            unfulfilledQuantity: 0,
            product: { id: "gid://shopify/Product/1" },
          },
        ],
        url: "https://example.test/x.jsonl",
        elapsedMs: 5,
        polls: 2,
      };
    });
    const deps: OrderHistoryFetchDeps = { runBulkQuery, sleep: async () => {} };

    const forced = await fetchCandidates(
      client,
      { since: "2026-09-01", until: "2026-09-01", tz: CHICAGO, forceBulk: true },
      deps,
    );
    expect(forced.kind).toBe("bulk");
    expect(forced.bulkOperationId).toBe("gid://shopify/BulkOperation/9");
    expect(forced.orders).toHaveLength(1);
    expect(forced.orders[0].lineItems[0].sku).toBe("7711-P");
    expect(rawRequest).not.toHaveBeenCalled();

    await fetchCandidates(
      client,
      { since: "2026-01-01", until: "2026-04-01", tz: CHICAGO },
      deps,
    );
    expect(runBulkQuery).toHaveBeenCalledTimes(2);
  });

  test("retries Throttled up to 3 times with 2/4/8s backoff then throws", async () => {
    const { client, rawRequest } = fakeClient();
    const sleeper = recordingSleep();
    rawRequest.mockRejectedValue(new Error("Throttled"));
    await expect(
      fetchCandidates(
        client,
        { since: "2026-09-01", until: "2026-09-01", tz: CHICAGO },
        { sleep: sleeper.sleep },
      ),
    ).rejects.toThrow(/Throttled/);
    expect(rawRequest).toHaveBeenCalledTimes(4);
    expect(sleeper.delays.filter((d) => d === 2000 || d === 4000 || d === 8000)).toEqual([
      2000, 4000, 8000,
    ]);
  });

  test("Throttled then success does not keep retrying", async () => {
    const { client, rawRequest } = fakeClient();
    const sleeper = recordingSleep();
    rawRequest
      .mockRejectedValueOnce(new Error("Throttled"))
      .mockResolvedValueOnce(
        rawOk({
          orders: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      );
    const result = await fetchCandidates(
      client,
      { since: "2026-09-01", until: "2026-09-01", tz: CHICAGO },
      { sleep: sleeper.sleep },
    );
    expect(result.orders).toEqual([]);
    expect(sleeper.delays).toContain(2000);
    expect(rawRequest).toHaveBeenCalledTimes(2);
  });

  test("sleeps before a call when currentlyAvailable is below the budget", async () => {
    const { client, rawRequest } = fakeClient();
    const sleeper = recordingSleep();
    const tight = {
      cost: {
        requestedQueryCost: 100,
        throttleStatus: {
          currentlyAvailable: 50,
          restoreRate: 50,
          maximumAvailable: 1000,
        },
      },
    };
    rawRequest
      .mockResolvedValueOnce(
        rawOk(
          {
            orders: {
              edges: [],
              pageInfo: { hasNextPage: true, endCursor: "p2" },
            },
          },
          tight,
        ),
      )
      .mockResolvedValueOnce(
        rawOk({
          orders: {
            edges: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        }),
      );
    await fetchCandidates(
      client,
      { since: "2026-09-01", until: "2026-09-01", tz: CHICAGO },
      { sleep: sleeper.sleep },
    );
    // needed = 400, currentlyAvailable 50, restore 50 -> 7s before page 2
    expect(sleeper.delays).toContain(7_000);
  });

  test("lineItems continuation failure refuses to undercount", async () => {
    const { client, rawRequest } = fakeClient();
    rawRequest.mockImplementation(async (query: unknown) => {
      const name = opName(query);
      if (name === "OrderHistoryCandidates") {
        return rawOk({
          orders: {
            edges: [
              {
                node: candidateNode("gid://shopify/Order/1", "#1", "AAA", {
                  hasNextLinePage: true,
                  endCursor: "li",
                }),
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      throw new Error("line page boom");
    });
    await expect(
      fetchCandidates(
        client,
        { since: "2026-09-01", until: "2026-09-01", tz: CHICAGO },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/line page boom/);
  });
});

describe("fetchOrderDetails", () => {
  function stubCandidate(id: string, name: string): CandidateOrder {
    return {
      id,
      name,
      createdAt: "2026-07-27T03:40:26Z",
      cancelledAt: null,
      sourceName: "web",
      test: false,
      tags: [],
      lineItems: [
        {
          id: `${id}/li`,
          sku: "7711-P",
          quantity: 1,
          currentQuantity: 1,
          unfulfilledQuantity: 0,
        },
      ],
      fulfillments: [],
      refunds: [],
    };
  }

  function detailNode(id: string, overrides: Partial<DetailOrderNode> = {}): DetailOrderNode {
    return {
      id,
      fulfillments: [
        {
          id: `${id}/f`,
          status: "SUCCESS",
          createdAt: "2026-07-27T14:20:18Z",
          fulfillmentLineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              {
                node: {
                  quantity: 1,
                  lineItem: { id: `${id}/li` },
                },
              },
            ],
          },
        },
      ],
      refunds: [
        {
          id: `${id}/r`,
          createdAt: "2026-08-01T00:00:00Z",
          totalRefundedSet: { shopMoney: { amount: "12.50" } },
          refundLineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            edges: [
              {
                node: {
                  quantity: 1,
                  restockType: "RETURN",
                  subtotalSet: { shopMoney: { amount: "12.50" } },
                  lineItem: { id: `${id}/li` },
                },
              },
            ],
          },
        },
      ],
      ...overrides,
    };
  }

  test("batches 45 ids into 20/20/5 and maps numbers / nulls", async () => {
    const { client, rawRequest } = fakeClient();
    const orders = Array.from({ length: 45 }, (_, i) =>
      stubCandidate(`gid://shopify/Order/${i + 1}`, `#${i + 1}`),
    );
    const seen: number[] = [];
    rawRequest.mockImplementation(async (_q: unknown, vars: unknown) => {
      const ids = (vars as { ids: string[] }).ids;
      seen.push(ids.length);
      return rawOk({
        nodes: ids.map((id) =>
          detailNode(id, {
            refunds: [
              {
                id: `${id}/r`,
                createdAt: null,
                totalRefundedSet: { shopMoney: { amount: null } },
                refundLineItems: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  edges: [
                    {
                      node: {
                        quantity: 1,
                        restockType: "NO_RESTOCK",
                        subtotalSet: { shopMoney: { amount: null } },
                        lineItem: { id: `${id}/li` },
                      },
                    },
                  ],
                },
              },
            ],
          }),
        ),
      });
    });
    const result = await fetchOrderDetails(
      client,
      orders,
      ["read_orders"],
      { sleep: async () => {} },
    );
    expect(seen).toEqual([20, 20, 5]);
    expect(result.orders).toHaveLength(45);
    expect(result.orders[0].refunds[0].createdAt).toBeNull();
    expect(result.orders[0].refunds[0].totalRefundedAmount).toBeNull();
    expect(result.orders[0].refunds[0].lineItems[0].subtotalAmount).toBeNull();
    expect(result.orders[0].returns).toBeNull();
    expect(result.orders[0].fulfillmentOrders).toBeNull();
    expect(String(rawRequest.mock.calls[0][0])).not.toMatch(/\breturns\(/);
  });

  test("includes returns and fulfillmentOrders fragments only when scopes allow", async () => {
    const { client, rawRequest } = fakeClient();
    const order = stubCandidate("gid://shopify/Order/1", "#1");
    rawRequest.mockImplementation(async (query: unknown) => {
      const text = String(query);
      expect(text).toMatch(/\breturns\(/);
      expect(text).toMatch(/\bfulfillmentOrders\(/);
      return rawOk({
        nodes: [
          detailNode(order.id, {
            returns: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    id: "gid://shopify/Return/1",
                    status: "CLOSED",
                    createdAt: "2026-08-02T00:00:00Z",
                    returnLineItems: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      edges: [
                        {
                          node: {
                            quantity: 1,
                            fulfillmentLineItem: {
                              lineItem: { id: `${order.id}/li` },
                            },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
            fulfillmentOrders: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/1",
                    status: "OPEN",
                    lineItems: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      edges: [
                        {
                          node: {
                            sku: "7711-P",
                            totalQuantity: 1,
                            remainingQuantity: 0,
                            lineItem: { id: `${order.id}/li` },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        ],
      });
    });
    const result = await fetchOrderDetails(
      client,
      [order],
      ["read_returns", ...FO_DETAIL_SCOPES],
      { sleep: async () => {} },
    );
    expect(result.orders[0].returns).toHaveLength(1);
    expect(result.orders[0].returns?.[0].lineItems[0].lineItemId).toBe(
      `${order.id}/li`,
    );
    expect(result.orders[0].fulfillmentOrders).toHaveLength(1);
    expect(result.orders[0].refunds[0].totalRefundedAmount).toBe(12.5);
  });

  test("ACCESS_DENIED on returns becomes MissingScopeError", async () => {
    const { client, rawRequest } = fakeClient();
    const err = new Error("Access denied for returns field.");
    (err as Error & { response: unknown }).response = {
      errors: [
        {
          message: "Access denied for returns field.",
          extensions: { code: "ACCESS_DENIED" },
        },
      ],
    };
    rawRequest.mockRejectedValue(err);
    await expect(
      fetchOrderDetails(
        client,
        [stubCandidate("gid://shopify/Order/1", "#1")],
        ["read_returns"],
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({
      name: "MissingScopeError",
      message: expect.stringMatching(/read_returns/),
    });
  });

  test("ACCESS_DENIED on fulfillmentOrders names the FO scopes", async () => {
    const { client, rawRequest } = fakeClient();
    const err = new Error("Access denied for fulfillmentOrders field.");
    (err as Error & { response: unknown }).response = {
      errors: [
        {
          message: "Access denied for fulfillmentOrders field.",
          extensions: { code: "ACCESS_DENIED" },
        },
      ],
    };
    rawRequest.mockRejectedValue(err);
    await expect(
      fetchOrderDetails(
        client,
        [stubCandidate("gid://shopify/Order/1", "#1")],
        [...FO_DETAIL_SCOPES],
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({
      name: "MissingScopeError",
      message: expect.stringMatching(/read_merchant_managed_fulfillment_orders/),
    });
  });

  test("ACCESS_DENIED on an unknown field uses the required-read-scope fallback", async () => {
    const { client, rawRequest } = fakeClient();
    const err = new Error("Access denied for secretField field.");
    (err as Error & { response: unknown }).response = {
      errors: [
        {
          message: "Access denied for secretField field.",
          extensions: { code: "ACCESS_DENIED" },
        },
      ],
    };
    rawRequest.mockRejectedValue(err);
    await expect(
      fetchOrderDetails(
        client,
        [stubCandidate("gid://shopify/Order/1", "#1")],
        ["read_orders"],
        { sleep: async () => {} },
      ),
    ).rejects.toMatchObject({
      name: "MissingScopeError",
      message: expect.stringMatching(/the required read scope/),
    });
  });

  test("nested hasNextPage and 50-entry lists refuse to undercount", async () => {
    const over = detailNode("gid://shopify/Order/1", {
      fulfillments: Array.from({ length: 50 }, (_, i) => ({
        id: `f${i}`,
        status: "SUCCESS",
        createdAt: "2026-07-27T14:20:18Z",
        fulfillmentLineItems: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [],
        },
      })),
    });
    expect(() => assertSingleDetailsPage("#1", over)).toThrow(
      /more nested records than one page/,
    );
    expect(() =>
      assertSingleDetailsPage("#1", {
        id: "gid://shopify/Order/1",
        fulfillments: [
          {
            id: "f",
            status: "SUCCESS",
            createdAt: "2026-07-27T14:20:18Z",
            fulfillmentLineItems: {
              pageInfo: { hasNextPage: true, endCursor: "x" },
              edges: [],
            },
          },
        ],
        refunds: [],
      }),
    ).toThrow(/more nested records than one page/);

    const { client, rawRequest } = fakeClient();
    rawRequest.mockResolvedValue(
      rawOk({
        nodes: [
          {
            id: "gid://shopify/Order/1",
            fulfillments: [
              {
                id: "f",
                status: "SUCCESS",
                createdAt: "2026-07-27T14:20:18Z",
                fulfillmentLineItems: {
                  pageInfo: { hasNextPage: true, endCursor: "x" },
                  edges: [],
                },
              },
            ],
            refunds: [],
          },
        ],
      }),
    );
    await expect(
      fetchOrderDetails(
        client,
        [stubCandidate("gid://shopify/Order/1", "#1")],
        ["read_orders"],
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/more nested records than one page/);
  });

  test("missing details node refuses to undercount; empty input is a no-op", async () => {
    const { client, rawRequest } = fakeClient();
    rawRequest.mockResolvedValue(rawOk({ nodes: [null] }));
    await expect(
      fetchOrderDetails(
        client,
        [stubCandidate("gid://shopify/Order/1", "#1")],
        ["read_orders"],
        { sleep: async () => {} },
      ),
    ).rejects.toThrow(/missing from details response/);
    const empty = await fetchOrderDetails(client, [], ["read_orders"]);
    expect(empty).toEqual({ orders: [], requests: 0 });
    expect(rawRequest).toHaveBeenCalledTimes(1);
  });
});

describe("mapDetailNodeToRawOrder", () => {
  test("parses money amounts and preserves nulls", () => {
    const candidate: CandidateOrder = {
      id: "gid://shopify/Order/1",
      name: "#1",
      createdAt: "2026-07-27T03:40:26Z",
      cancelledAt: null,
      sourceName: null,
      test: false,
      tags: ["a"],
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          sku: "7711-P",
          quantity: 1,
          currentQuantity: 1,
          unfulfilledQuantity: 0,
        },
      ],
      fulfillments: [],
      refunds: [],
    };
    const raw = mapDetailNodeToRawOrder(
      candidate,
      {
        id: candidate.id,
        fulfillments: [
          {
            id: "f",
            status: "SUCCESS",
            createdAt: "2026-07-27T14:20:18Z",
            fulfillmentLineItems: {
              edges: [
                {
                  node: {
                    quantity: null,
                    lineItem: { id: "gid://shopify/LineItem/1" },
                  },
                },
              ],
            },
          },
        ],
        refunds: [
          {
            id: "r",
            createdAt: null,
            totalRefundedSet: { shopMoney: { amount: "10.25" } },
            refundLineItems: {
              edges: [
                {
                  node: {
                    quantity: 1,
                    restockType: "CANCEL",
                    subtotalSet: { shopMoney: { amount: "10.25" } },
                    lineItem: { id: "gid://shopify/LineItem/1" },
                  },
                },
              ],
            },
          },
        ],
      },
      { includeReturns: false, includeFulfillmentOrders: false },
    );
    expect(raw.fulfillments[0].lineItems[0].quantity).toBeNull();
    expect(raw.refunds[0].createdAt).toBeNull();
    expect(raw.refunds[0].totalRefundedAmount).toBe(10.25);
    expect(raw.refunds[0].lineItems[0].subtotalAmount).toBe(10.25);
    expect(raw.returns).toBeNull();
    expect(raw.fulfillmentOrders).toBeNull();
    expect(raw.sourceName).toBeNull();
  });
});
