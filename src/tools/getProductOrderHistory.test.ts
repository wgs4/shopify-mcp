// Tool tests for get-product-order-history: validation, the 60-day wall,
// cursor and bulk paths, scope-gated fragments, and response shape.
// Fake GraphQL client scripted by operation name; no network.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import { _resetForTest as resetScopes } from "../lib/accessScopes.js";
import { BulkOperationError } from "../lib/bulkOperations.js";
import {
  FO_DETAIL_SCOPES,
  _resetForTest as resetFetch,
} from "../lib/orderHistoryFetch.js";
import { ScopeHorizonError } from "../lib/orderWall.js";
import { getProductOrderHistory } from "./getProductOrderHistory.js";

afterEach(() => {
  resetScopes();
  resetFetch();
  delete process.env.MYSHOPIFY_DOMAIN;
});

const CHICAGO = "America/Chicago";
const MATCHING_SKU = "7711-P";
const ORDER_GID = "gid://shopify/Order/26130704";
const LINE_GID = "gid://shopify/LineItem/9001";
const OTHER_GID = "gid://shopify/Order/999";
const OTHER_LINE = "gid://shopify/LineItem/999";

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

function rawOk<T>(data: T) {
  return { data, extensions: AMPLE_COST, headers: {}, status: 200 };
}

function opName(query: unknown): string {
  const text = String(query);
  const match = /\b(?:query|mutation)\s+(\w+)/.exec(text);
  return match ? match[1] : "";
}

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

function scopePayload(handles: string[]) {
  return {
    currentAppInstallation: {
      accessScopes: handles.map((handle) => ({ handle })),
    },
  };
}

function matchingLine(
  id = LINE_GID,
  sku = MATCHING_SKU,
  productId = "gid://shopify/Product/1",
) {
  return {
    id,
    sku,
    title: "Macrodose",
    quantity: 1,
    currentQuantity: 1,
    unfulfilledQuantity: 0,
    refundableQuantity: 1,
    nonFulfillableQuantity: 0,
    product: { id: productId },
  };
}

function matchingCandidateNode() {
  return {
    id: ORDER_GID,
    name: "#26130704",
    createdAt: "2026-07-27T03:40:26Z",
    processedAt: "2026-07-27T03:40:26Z",
    updatedAt: "2026-07-27T14:20:18Z",
    cancelledAt: null,
    cancelReason: null,
    sourceName: "mechanic-reverb-sync",
    test: false,
    tags: [],
    lineItems: {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [{ node: matchingLine() }],
    },
    fulfillments: [
      {
        id: `${ORDER_GID}/f`,
        status: "SUCCESS",
        createdAt: "2026-07-27T14:20:18Z",
      },
    ],
    refunds: [],
  };
}

function nonMatchingCandidateNode() {
  return {
    id: OTHER_GID,
    name: "#999",
    createdAt: "2026-07-27T03:40:26Z",
    processedAt: "2026-07-27T03:40:26Z",
    updatedAt: "2026-07-27T14:20:18Z",
    cancelledAt: null,
    cancelReason: null,
    sourceName: "web",
    test: false,
    tags: [],
    lineItems: {
      pageInfo: { hasNextPage: false, endCursor: null },
      edges: [{ node: matchingLine(OTHER_LINE, "9999-X", "gid://shopify/Product/2") }],
    },
    fulfillments: [],
    refunds: [],
  };
}

function matchingDetailNode(extra: Record<string, unknown> = {}) {
  return {
    id: ORDER_GID,
    fulfillments: [
      {
        id: `${ORDER_GID}/f`,
        status: "SUCCESS",
        createdAt: "2026-07-27T14:20:18Z",
        fulfillmentLineItems: {
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [
            { node: { quantity: 1, lineItem: { id: LINE_GID } } },
          ],
        },
      },
    ],
    refunds: [],
    ...extra,
  };
}

function scriptClient(
  handles: string[],
  opts: {
    candidates?: unknown[];
    detail?: unknown;
    tz?: string;
  } = {},
) {
  const { client, request, rawRequest } = fakeClient();
  request.mockImplementation(async (query: unknown) => {
    const name = opName(query);
    if (name === "CurrentAccessScopes" || String(query).includes("CurrentAccessScopes")) {
      return scopePayload(handles);
    }
    if (name === "ShopTimezone" || String(query).includes("ShopTimezone")) {
      return { shop: { ianaTimezone: opts.tz ?? CHICAGO } };
    }
    throw new Error(`unexpected request operation ${name || String(query)}`);
  });
  rawRequest.mockImplementation(async (query: unknown) => {
    const name = opName(query);
    if (name === "OrderHistoryCandidates") {
      return rawOk({
        orders: {
          edges: (opts.candidates ?? [
            matchingCandidateNode(),
            nonMatchingCandidateNode(),
          ]).map((node) => ({ node })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    if (name .startsWith("OrderHistoryDetails")) {
      return rawOk({ nodes: [opts.detail ?? matchingDetailNode()] });
    }
    throw new Error(`unexpected rawRequest operation ${name}`);
  });
  return { client, request, rawRequest };
}

async function run(
  args: Record<string, unknown>,
  handles: string[],
  scriptOpts?: Parameters<typeof scriptClient>[1],
  deps?: Parameters<typeof getProductOrderHistory.execute>[1],
) {
  const scripted = scriptClient(handles, scriptOpts);
  getProductOrderHistory.initialize(scripted.client);
  process.env.MYSHOPIFY_DOMAIN = "all-pedal.myshopify.com";
  const result = await getProductOrderHistory.execute(args, deps);
  return { result: result as Record<string, unknown>, ...scripted };
}

describe("get-product-order-history validation", () => {
  test("rejects neither skus nor productId, both, bad dates, until < since", async () => {
    const { client } = fakeClient();
    getProductOrderHistory.initialize(client);

    await expect(
      getProductOrderHistory.execute({
        since: "2026-07-05",
        until: "2026-09-03",
      }),
    ).rejects.toThrow(/exactly one of skus or productId/);
    await expect(getProductOrderHistory.execute({})).rejects.toThrow(
      /Required/,
    );
    await expect(
      getProductOrderHistory.execute({
        skus: [MATCHING_SKU],
        productId: "gid://shopify/Product/1",
        since: "2026-07-05",
        until: "2026-09-03",
      }),
    ).rejects.toThrow(/exactly one of skus or productId/);
    await expect(
      getProductOrderHistory.execute({
        skus: [MATCHING_SKU],
        since: "2026-13-40",
        until: "2026-09-03",
      }),
    ).rejects.toThrow(/since must be a valid YYYY-MM-DD/);
    await expect(
      getProductOrderHistory.execute({
        skus: [MATCHING_SKU],
        since: "2026-07-05",
        until: "nope",
      }),
    ).rejects.toThrow(/until must be a valid YYYY-MM-DD/);
    await expect(
      getProductOrderHistory.execute({
        skus: [MATCHING_SKU],
        since: "2026-09-03",
        until: "2026-07-05",
      }),
    ).rejects.toThrow(/until must be >= since/);
  });
});

describe("60-day wall", () => {
  test("no scope + 2024 window throws unwrapped ScopeHorizonError", async () => {
    const scripted = scriptClient(["read_orders"]);
    getProductOrderHistory.initialize(scripted.client);
    try {
      await getProductOrderHistory.execute({
        skus: [MATCHING_SKU],
        since: "2024-01-01",
        until: "2024-12-31",
      });
      throw new Error("expected ScopeHorizonError");
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeHorizonError);
      expect((err as Error).name).toBe("ScopeHorizonError");
      expect((err as Error).message).toContain("read_all_orders");
      expect((err as Error).message).not.toMatch(/^Failed to compute product order history/);
    }
  });

  test("no scope + window inside horizon throws visibility_indeterminate", async () => {
    const scripted = scriptClient(["read_orders"]);
    getProductOrderHistory.initialize(scripted.client);
    const until = new Date().toISOString().slice(0, 10);
    const sinceMs = Date.now() - 7 * 86_400_000;
    const since = new Date(sinceMs).toISOString().slice(0, 10);
    try {
      await getProductOrderHistory.execute({
        skus: [MATCHING_SKU],
        since,
        until,
      });
      throw new Error("expected ScopeHorizonError");
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeHorizonError);
      expect((err as ScopeHorizonError).name).toBe("ScopeHorizonError");
      expect((err as ScopeHorizonError).reason).toBe("visibility_indeterminate");
      expect((err as Error).message.startsWith("ScopeHorizonError: ")).toBe(true);
      expect((err as Error).message).toContain("read_all_orders");
      expect((err as Error).message).toMatch(/allow_incomplete/);
      expect((err as Error).message).toContain("Earliest accepted bound");
    }
  });

  test("allow_incomplete yields partial completeness and INCOMPLETE warning", async () => {
    const { result } = await run(
      {
        skus: [MATCHING_SKU],
        since: "2024-01-01",
        until: "2024-12-31",
        allow_incomplete: true,
      },
      ["read_orders"],
      undefined,
      {
        runBulkQuery: async () => ({
          id: "gid://shopify/BulkOperation/empty",
          objectCount: 0,
          rootObjectCount: 0,
          rows: [],
          url: null,
          elapsedMs: 1,
          polls: 1,
        }),
        sleep: async () => {},
      },
    );
    expect(result.horizon_ok).toBe(false);
    expect(result.completeness).toMatchObject({
      status: "partial",
      reason: "read_all_orders_missing",
    });
    expect((result.warnings as string[])[0]).toMatch(/^INCOMPLETE/);
  });

  test("read_all_orders yields complete and horizon_ok", async () => {
    const { result } = await run(
      {
        skus: [MATCHING_SKU],
        since: "2026-07-05",
        until: "2026-09-03",
      },
      ["read_orders", "read_all_orders"],
    );
    expect(result.horizon_ok).toBe(true);
    expect(result.completeness).toEqual({
      status: "complete",
      reason: null,
      visible_from: null,
    });
    expect((result.horizon as { scope_missing: string | null }).scope_missing).toBeNull();
  });
});

describe("cursor and bulk counting", () => {
  const windowArgs = {
    skus: [MATCHING_SKU],
    since: "2026-07-05",
    until: "2026-09-03",
  };

  test("cursor path: matching All-Pedal 26130704 plus a non-matching order", async () => {
    const { result, rawRequest } = await run(windowArgs, [
      "read_orders",
      "read_all_orders",
    ]);
    expect(result.store).toBe("all-pedal.myshopify.com");
    expect(result.skus).toEqual([MATCHING_SKU]);
    expect(result.timezone).toBe(CHICAGO);
    expect(result.basis).toBe("fulfillment");
    expect(result.group_by).toBe("none");
    expect(result.units_ordered).toBe(1);
    expect(result.units_shipped).toBe(1);
    expect(result.orders).toBe(1);
    expect(result.matched_orders).toBe(1);
    expect(result.units_returned).toBeNull();
    expect((result.source as { kind: string }).kind).toBe("cursor");
    expect((result.source as { candidate_orders: number }).candidate_orders).toBe(2);
    expect(result.orders_evidence).toBeUndefined();
    expect(result).toHaveProperty("orders_truncated");
    const candidateCall = rawRequest.mock.calls.find(
      (call) => opName(call[0]) === "OrderHistoryCandidates",
    );
    expect(candidateCall).toBeTruthy();
  });

  test("force_bulk path yields identical totals via injectable runBulkQuery", async () => {
    const bulkRows = [
      {
        id: ORDER_GID,
        name: "#26130704",
        createdAt: "2026-07-27T03:40:26Z",
        processedAt: "2026-07-27T03:40:26Z",
        updatedAt: "2026-07-27T14:20:18Z",
        cancelledAt: null,
        sourceName: "mechanic-reverb-sync",
        test: false,
        tags: [],
        fulfillments: [
          {
            id: `${ORDER_GID}/f`,
            status: "SUCCESS",
            createdAt: "2026-07-27T14:20:18Z",
          },
        ],
        refunds: [],
      },
      {
        id: LINE_GID,
        __parentId: ORDER_GID,
        sku: MATCHING_SKU,
        title: "Macrodose",
        quantity: 1,
        currentQuantity: 1,
        unfulfilledQuantity: 0,
        product: { id: "gid://shopify/Product/1" },
      },
      {
        id: OTHER_GID,
        name: "#999",
        createdAt: "2026-07-27T03:40:26Z",
        cancelledAt: null,
        sourceName: "web",
        test: false,
        tags: [],
        fulfillments: [],
        refunds: [],
      },
      {
        id: OTHER_LINE,
        __parentId: OTHER_GID,
        sku: "9999-X",
        title: "other",
        quantity: 1,
        currentQuantity: 1,
        unfulfilledQuantity: 0,
        product: { id: "gid://shopify/Product/2" },
      },
    ];
    const runBulkQuery = jest.fn(async () => ({
      id: "gid://shopify/BulkOperation/1",
      objectCount: 4,
      rootObjectCount: 2,
      rows: bulkRows,
      url: "https://example.test/x.jsonl",
      elapsedMs: 10,
      polls: 2,
    }));
    const { result } = await run(
      { ...windowArgs, force_bulk: true },
      ["read_orders", "read_all_orders"],
      undefined,
      { runBulkQuery, sleep: async () => {} },
    );
    expect(result.units_ordered).toBe(1);
    expect(result.units_shipped).toBe(1);
    expect(result.orders).toBe(1);
    expect((result.source as { kind: string }).kind).toBe("bulk");
    expect((result.source as { bulk_operation_id: string }).bulk_operation_id).toBe(
      "gid://shopify/BulkOperation/1",
    );
    expect(runBulkQuery).toHaveBeenCalledTimes(1);
  });

  test("BulkOperationError from bulk path is not wrapped", async () => {
    const runBulkQuery = jest.fn(async () => {
      throw new BulkOperationError("TIMEOUT", "too slow", "gid://shopify/BulkOperation/1");
    });
    const scripted = scriptClient(["read_orders", "read_all_orders"]);
    getProductOrderHistory.initialize(scripted.client);
    try {
      await getProductOrderHistory.execute(
        { ...windowArgs, force_bulk: true },
        { runBulkQuery, sleep: async () => {} },
      );
      throw new Error("expected BulkOperationError");
    } catch (err) {
      expect(err).toBeInstanceOf(BulkOperationError);
      expect((err as Error).name).toBe("BulkOperationError");
    }
  });
});

describe("scope-gated fragments and errors", () => {
  const windowArgs = {
    skus: [MATCHING_SKU],
    since: "2026-07-05",
    until: "2026-09-03",
  };

  test("returns fragment present only with read_returns", async () => {
    const without = scriptClient(["read_orders", "read_all_orders"]);
    getProductOrderHistory.initialize(without.client);
    process.env.MYSHOPIFY_DOMAIN = "all-pedal.myshopify.com";
    await getProductOrderHistory.execute(windowArgs);
    const withoutDoc = String(
      without.rawRequest.mock.calls.find((c) => opName(c[0]) .startsWith("OrderHistoryDetails"))?.[0],
    );
    expect(withoutDoc).not.toMatch(/\breturns\(/);

    const withReturns = scriptClient([
      "read_orders",
      "read_all_orders",
      "read_returns",
    ]);
    getProductOrderHistory.initialize(withReturns.client);
    await getProductOrderHistory.execute(windowArgs);
    const withDoc = String(
      withReturns.rawRequest.mock.calls.find((c) => opName(c[0]) .startsWith("OrderHistoryDetails"))?.[0],
    );
    expect(withDoc).toMatch(/\breturns\(/);
    expect(withDoc).not.toMatch(/\bfulfillmentOrders\(/);
  });

  test("fulfillmentOrders fragment only with all three scopes", async () => {
    const partial = scriptClient([
      "read_orders",
      "read_all_orders",
      "read_merchant_managed_fulfillment_orders",
    ]);
    getProductOrderHistory.initialize(partial.client);
    process.env.MYSHOPIFY_DOMAIN = "all-pedal.myshopify.com";
    await getProductOrderHistory.execute(windowArgs);
    const partialDoc = String(
      partial.rawRequest.mock.calls.find((c) => opName(c[0]) .startsWith("OrderHistoryDetails"))?.[0],
    );
    expect(partialDoc).not.toMatch(/\bfulfillmentOrders\(/);

    const full = scriptClient([
      "read_orders",
      "read_all_orders",
      ...FO_DETAIL_SCOPES,
    ]);
    getProductOrderHistory.initialize(full.client);
    await getProductOrderHistory.execute(windowArgs);
    const fullDoc = String(
      full.rawRequest.mock.calls.find((c) => opName(c[0]) .startsWith("OrderHistoryDetails"))?.[0],
    );
    expect(fullDoc).toMatch(/\bfulfillmentOrders\(/);
    expect(fullDoc).not.toMatch(/\breturns\(/);
  });

  test("nested hasNextPage throws an explicit undercount error", async () => {
    const { client, request, rawRequest } = scriptClient([
      "read_orders",
      "read_all_orders",
    ]);
    rawRequest.mockImplementation(async (query: unknown) => {
      const name = opName(query);
      if (name === "OrderHistoryCandidates") {
        return rawOk({
          orders: {
            edges: [{ node: matchingCandidateNode() }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      if (name .startsWith("OrderHistoryDetails")) {
        return rawOk({
          nodes: [
            matchingDetailNode({
              fulfillments: [
                {
                  id: `${ORDER_GID}/f`,
                  status: "SUCCESS",
                  createdAt: "2026-07-27T14:20:18Z",
                  fulfillmentLineItems: {
                    pageInfo: { hasNextPage: true, endCursor: "x" },
                    edges: [
                      { node: { quantity: 1, lineItem: { id: LINE_GID } } },
                    ],
                  },
                },
              ],
            }),
          ],
        });
      }
      throw new Error(name);
    });
    getProductOrderHistory.initialize(client);
    process.env.MYSHOPIFY_DOMAIN = "all-pedal.myshopify.com";
    await expect(getProductOrderHistory.execute(windowArgs)).rejects.toThrow(
      /more nested records than one page/,
    );
    void request;
  });

  test("ACCESS_DENIED becomes unwrapped MissingScopeError", async () => {
    const { client, rawRequest } = scriptClient([
      "read_orders",
      "read_all_orders",
      "read_returns",
    ]);
    rawRequest.mockImplementation(async (query: unknown) => {
      const name = opName(query);
      if (name === "OrderHistoryCandidates") {
        return rawOk({
          orders: {
            edges: [{ node: matchingCandidateNode() }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      const err = new Error("Access denied for returns field.");
      (err as Error & { response: unknown }).response = {
        errors: [
          {
            message: "Access denied for returns field.",
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      };
      throw err;
    });
    getProductOrderHistory.initialize(client);
    process.env.MYSHOPIFY_DOMAIN = "all-pedal.myshopify.com";
    try {
      await getProductOrderHistory.execute(windowArgs);
      throw new Error("expected MissingScopeError");
    } catch (err) {
      expect((err as Error).name).toBe("MissingScopeError");
      expect((err as Error).message).toContain("read_returns");
      expect((err as Error).message).not.toMatch(/^Failed to compute/);
    }
  });
});

describe("response extras", () => {
  const windowArgs = {
    skus: [MATCHING_SKU],
    since: "2026-07-05",
    until: "2026-09-03",
  };

  test("group_by month returns buckets covering the window", async () => {
    const { result } = await run(
      { ...windowArgs, group_by: "month" },
      ["read_orders", "read_all_orders"],
    );
    const buckets = result.buckets as Array<{ key: string; units_ordered: number; units_shipped: number }>;
    expect(buckets.map((b) => b.key)).toEqual(["2026-07", "2026-08", "2026-09"]);
    const july = buckets.find((b) => b.key === "2026-07");
    expect(july?.units_ordered).toBe(1);
    expect(july?.units_shipped).toBe(1);
  });

  test("include_orders adds orders_evidence; default omits it", async () => {
    const without = await run(windowArgs, ["read_orders", "read_all_orders"]);
    expect(without.result.orders_evidence).toBeUndefined();
    const withEv = await run(
      { ...windowArgs, include_orders: true },
      ["read_orders", "read_all_orders"],
    );
    const evidence = withEv.result.orders_evidence as Array<{ name: string }>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0].name).toBe("#26130704");
  });

  test("productId identity uses product_id in the response", async () => {
    const { result } = await run(
      {
        productId: "gid://shopify/Product/1",
        since: "2026-07-05",
        until: "2026-09-03",
      },
      ["read_orders", "read_all_orders"],
    );
    expect(result.product_id).toBe("gid://shopify/Product/1");
    expect(result.skus).toBeUndefined();
    expect(result.units_ordered).toBe(1);
  });
});
