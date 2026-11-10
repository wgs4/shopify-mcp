import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { getOperationAST, parse, visit } from "graphql";
import {
  createShopifyMcpServer,
  withoutDisabledTools,
} from "../src/lib/registerTools.js";
import type { StoreCredential } from "../src/lib/storeConfig.js";
import { StoreRegistry } from "../src/lib/storeRegistry.js";
import type { StoreContext } from "../src/lib/toolUtils.js";
import {
  getOrderTimeline,
  normalizeOrderGid,
} from "../src/tools/getOrderTimeline.js";
import { tools } from "../src/tools/registry.js";

const ORDER_NUMERIC_ID = "8054938337547";
const ORDER_GID = `gid://shopify/Order/${ORDER_NUMERIC_ID}`;

function makeBasicEvent(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "BasicEvent",
    id: "gid://shopify/BasicEvent/1001",
    createdAt: "2026-10-15T14:00:00Z",
    action: "placed",
    message: "Order was placed.",
    ...overrides,
  };
}

function makeCommentEvent(overrides: Record<string, unknown> = {}) {
  return {
    __typename: "CommentEvent",
    id: "gid://shopify/CommentEvent/2001",
    createdAt: "2026-10-16T09:30:00Z",
    action: "comment",
    message:
      'RMA #4410 cross-linked to replacement order <a href="https://admin.shopify.com/store/wgs-test/orders/9000000000001">#77240</a>.',
    rawMessage: "RMA #4410 cross-linked to replacement order #77240.",
    ...overrides,
  };
}

function makeOrderPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: ORDER_GID,
    name: "#77235",
    note: null,
    events: {
      edges: [
        { node: makeBasicEvent() },
        { node: makeCommentEvent() },
        {
          node: makeBasicEvent({
            id: "gid://shopify/BasicEvent/1002",
            createdAt: "2026-10-16T10:00:00Z",
            action: "refund_success",
            message: "We successfully refunded $85.00 USD.",
          }),
        },
        {
          node: makeBasicEvent({
            id: "gid://shopify/BasicEvent/1003",
            createdAt: "2026-10-16T10:01:00Z",
            action: "mail_sent",
            message:
              'Refund notification email was sent to <a href="mailto:buyer@example.com">buyer@example.com</a>.',
          }),
        },
      ],
      pageInfo: {
        hasNextPage: false,
        endCursor: "cursor-mail-1",
      },
    },
    ...overrides,
  };
}

function createHarness(
  orderResponse: unknown = { order: makeOrderPayload() },
  domain = "wgsusa.myshopify.com",
  storeKey = "wgs",
) {
  const calls: Array<{
    operation: string;
    query: string;
    variables: Record<string, unknown>;
  }> = [];

  const request = jest.fn(
    async (query: unknown, variables: Record<string, unknown> = {}) => {
      const queryStr = String(query);
      const operation = getOperationAST(parse(queryStr))?.name?.value ?? "";
      calls.push({ operation, query: queryStr, variables });
      if (typeof orderResponse === "function") {
        return (orderResponse as (v: Record<string, unknown>) => unknown)(
          variables,
        );
      }
      return orderResponse;
    },
  );

  const ctx: StoreContext = {
    client: { request } as unknown as StoreContext["client"],
    domain,
    storeKey,
    apiVersion: "2026-01",
    getAccessToken: () => "synthetic-test-token",
  };

  return { calls, request, ctx };
}

describe("get-order-timeline minimal GraphQL contract", () => {
  test("queries only order id/name/note and minimal event/pageInfo fields with default limit 25", async () => {
    const { calls, ctx } = createHarness();
    const result = await getOrderTimeline.execute(
      { orderId: ORDER_NUMERIC_ID },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].operation).toBe("GetOrderTimeline");
    expect(calls[0].variables).toEqual({
      id: ORDER_GID,
      first: 25,
      reverse: false,
    });

    const ast = parse(calls[0].query);
    const selectedFields: string[] = [];
    visit(ast, {
      Field(node) {
        selectedFields.push(node.name.value);
      },
    });
    expect(selectedFields).toEqual([
      "order",
      "id",
      "name",
      "note",
      "events",
      "edges",
      "node",
      "__typename",
      "id",
      "createdAt",
      "action",
      "message",
      "rawMessage",
      "pageInfo",
      "hasNextPage",
      "endCursor",
    ]);

    expect(result).toEqual({
      order: {
        id: ORDER_GID,
        name: "#77235",
        currentNote: null,
      },
      events: [
        {
          __typename: "BasicEvent",
          id: "gid://shopify/BasicEvent/1001",
          createdAt: "2026-10-15T14:00:00Z",
          action: "placed",
          message: "Order was placed.",
          isMailSent: false,
        },
        {
          __typename: "CommentEvent",
          id: "gid://shopify/CommentEvent/2001",
          createdAt: "2026-10-16T09:30:00Z",
          action: "comment",
          message:
            'RMA #4410 cross-linked to replacement order <a href="https://admin.shopify.com/store/wgs-test/orders/9000000000001">#77240</a>.',
          rawMessage: "RMA #4410 cross-linked to replacement order #77240.",
          isMailSent: false,
        },
        {
          __typename: "BasicEvent",
          id: "gid://shopify/BasicEvent/1002",
          createdAt: "2026-10-16T10:00:00Z",
          action: "refund_success",
          message: "We successfully refunded $85.00 USD.",
          isMailSent: false,
        },
        {
          __typename: "BasicEvent",
          id: "gid://shopify/BasicEvent/1003",
          createdAt: "2026-10-16T10:01:00Z",
          action: "mail_sent",
          message:
            'Refund notification email was sent to <a href="mailto:buyer@example.com">buyer@example.com</a>.',
          isMailSent: true,
        },
      ],
      pageInfo: {
        hasNextPage: false,
        endCursor: "cursor-mail-1",
      },
    });
  });

  test("preserves message verbatim, returns rawMessage on CommentEvent only, and requires BasicEvent with exact action mail_sent", async () => {
    const order = makeOrderPayload({
      note: "Ship UPS Ground",
      events: {
        edges: [
          {
            node: makeCommentEvent({
              id: "gid://shopify/CommentEvent/2002",
              action: "mail_sent",
              rawMessage: null,
              message:
                'Confirmation email was sent to <a href="mailto:buyer@example.com">buyer@example.com</a>.',
            }),
          },
          {
            node: makeBasicEvent({
              id: "gid://shopify/BasicEvent/1004",
              action: "notification_sent",
              message: "Order confirmation email was sent to buyer@example.com.",
            }),
          },
          {
            node: makeBasicEvent({
              id: "gid://shopify/BasicEvent/1005",
              action: "mail_sent",
              message: "Shipping confirmation email was sent.",
            }),
          },
        ],
        pageInfo: {
          hasNextPage: false,
          endCursor: "c3",
        },
      },
    });

    const { ctx } = createHarness({ order });
    const result = await getOrderTimeline.execute({ orderId: ORDER_GID }, ctx);

    expect(result?.order.currentNote).toBe("Ship UPS Ground");
    expect(result?.events[0]).toEqual({
      __typename: "CommentEvent",
      id: "gid://shopify/CommentEvent/2002",
      createdAt: "2026-10-16T09:30:00Z",
      action: "mail_sent",
      message:
        'Confirmation email was sent to <a href="mailto:buyer@example.com">buyer@example.com</a>.',
      rawMessage: null,
      isMailSent: false,
    });
    expect(result?.events[1].isMailSent).toBe(false);
    expect("rawMessage" in (result?.events[1] ?? {})).toBe(false);
    expect(result?.events[2].isMailSent).toBe(true);
  });

  test("forwards after cursor, custom limit, reverse, and includeComments=false", async () => {
    const { calls, ctx } = createHarness({
      order: makeOrderPayload({
        events: {
          edges: [{ node: makeBasicEvent() }],
          pageInfo: {
            hasNextPage: true,
            endCursor: "cursor-page-2",
          },
        },
      }),
    });

    const result = await getOrderTimeline.execute(
      {
        orderId: ` ${ORDER_NUMERIC_ID} `,
        limit: 50,
        after: "cursor-page-1",
        includeComments: false,
        reverse: true,
      },
      ctx,
    );

    expect(calls[0].variables).toEqual({
      id: ORDER_GID,
      first: 50,
      after: "cursor-page-1",
      query: "comments:false",
      reverse: true,
    });
    expect(result?.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: "cursor-page-2",
    });
  });
});

describe("get-order-timeline input validation bounds", () => {
  test("accepts positive numeric Order IDs and Order GIDs and rejects invalid IDs or limits > 50", async () => {
    expect(normalizeOrderGid(" 8054938337547 ")).toBe(ORDER_GID);
    expect(normalizeOrderGid(ORDER_GID)).toBe(ORDER_GID);

    for (const badId of [
      "",
      "0",
      "-1",
      "#77235",
      "gid://shopify/Order/0",
      "gid://shopify/DraftOrder/8054938337547",
      "gid://shopify/Order/abc",
    ]) {
      expect(getOrderTimeline.schema.safeParse({ orderId: badId }).success).toBe(
        false,
      );
    }

    expect(
      getOrderTimeline.schema.safeParse({ orderId: ORDER_GID, limit: 1 }).success,
    ).toBe(true);
    expect(
      getOrderTimeline.schema.safeParse({ orderId: ORDER_GID, limit: 50 }).success,
    ).toBe(true);
    for (const badLimit of [0, -1, 51, 250, 1.5]) {
      expect(
        getOrderTimeline.schema.safeParse({ orderId: ORDER_GID, limit: badLimit })
          .success,
      ).toBe(false);
    }

    const { calls, ctx } = createHarness();
    await expect(
      getOrderTimeline.execute({ orderId: "#77235" }, ctx),
    ).rejects.toThrow(/Failed to fetch order timeline/);
    await expect(
      getOrderTimeline.execute({ orderId: ORDER_GID, limit: 51 }, ctx),
    ).rejects.toThrow(/Failed to fetch order timeline/);
    expect(calls).toHaveLength(0);
  });
});

describe("get-order-timeline fail-closed response and error handling", () => {
  test("fails when order is null and mentions older-order permissions", async () => {
    const { ctx } = createHarness({ order: null }, "allpedal.myshopify.com", "allpedal");
    await expect(
      getOrderTimeline.execute({ orderId: ORDER_NUMERIC_ID }, ctx),
    ).rejects.toThrow(
      /Order not found or not visible.*allpedal.*older-order permissions/,
    );
  });

  test("fails on missing/malformed events page or null/malformed node instead of dropping evidence", async () => {
    for (const badEvents of [
      null,
      { edges: null, pageInfo: { hasNextPage: false, endCursor: null } },
      { edges: [], pageInfo: null },
      { edges: [null], pageInfo: { hasNextPage: false, endCursor: null } },
      { edges: [{ node: null }], pageInfo: { hasNextPage: false, endCursor: null } },
      {
        edges: [{ node: { __typename: "UnknownEvent", id: "1", createdAt: "t", action: "a", message: "m" } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ]) {
      const { ctx } = createHarness({
        order: makeOrderPayload({ events: badEvents }),
      });
      await expect(
        getOrderTimeline.execute({ orderId: ORDER_GID }, ctx),
      ).rejects.toThrow(/Failed to fetch order timeline/);
    }
  });

  test("fails when hasNextPage is true without a new endCursor", async () => {
    const { ctx: nullCursorCtx } = createHarness({
      order: makeOrderPayload({
        events: {
          edges: [{ node: makeBasicEvent() }],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      }),
    });
    await expect(
      getOrderTimeline.execute({ orderId: ORDER_GID }, nullCursorCtx),
    ).rejects.toThrow(/hasNextPage=true without a new endCursor/);

    for (const endCursor of ["same-cursor", " same-cursor ", "x".repeat(1025)]) {
      const { ctx } = createHarness({
        order: makeOrderPayload({
          events: {
            edges: [{ node: makeBasicEvent() }],
            pageInfo: { hasNextPage: true, endCursor },
          },
        }),
      });
      await expect(
        getOrderTimeline.execute({ orderId: ORDER_GID, after: "same-cursor" }, ctx),
      ).rejects.toThrow(/hasNextPage=true without a new endCursor/);
    }
  });

  test("preserves GraphQL auth/access errors via standard tool error handling without claiming an exact scope", async () => {
    const { ctx } = createHarness(() => {
      throw new Error("Access denied for events field.");
    });
    await expect(
      getOrderTimeline.execute({ orderId: ORDER_GID }, ctx),
    ).rejects.toThrow(
      "Failed to fetch order timeline: Access denied for events field.",
    );
  });
});

describe("get-order-timeline opt-in registration, denylist precedence, and multi-store routing", () => {
  const STORES: StoreCredential[] = [
    {
      key: "wgs",
      domain: "wgs-test.myshopify.com",
      clientId: "id-wgs",
      clientSecret: "secret-wgs",
    },
    {
      key: "allpedal",
      domain: "allpedal-test.myshopify.com",
      clientId: "id-allpedal",
      clientSecret: "secret-allpedal",
    },
  ];

  const registries: StoreRegistry[] = [];

  afterEach(() => {
    for (const r of registries) r.destroy();
    registries.length = 0;
  });

  test("remains in registry for denylist validation, is off by default, enabled via SHOPIFY_MCP_ENABLE_ORDER_TIMELINE=true, and disabled when also in SHOPIFY_MCP_DISABLED_TOOLS", () => {
    expect(
      withoutDisabledTools(tools, new Set(["get-order-timeline"])).map(
        (t) => t.name,
      ),
    ).not.toContain("get-order-timeline");

    const registry = new StoreRegistry(STORES, "2026-01", {
      fetchImpl: async () => {
        throw new Error("no network");
      },
    });
    registries.push(registry);

    const defaultServer = createShopifyMcpServer({ mode: "multi", registry }, {});
    const defaultTools = (
      defaultServer as unknown as { _registeredTools: Record<string, unknown> }
    )._registeredTools;
    expect(defaultTools["get-order-timeline"]).toBeUndefined();

    const enabledDeniedServer = createShopifyMcpServer(
      { mode: "multi", registry },
      {
        SHOPIFY_MCP_ENABLE_ORDER_TIMELINE: "true",
        SHOPIFY_MCP_DISABLED_TOOLS: "get-order-timeline",
      },
    );
    const enabledDeniedTools = (
      enabledDeniedServer as unknown as {
        _registeredTools: Record<string, unknown>;
      }
    )._registeredTools;
    expect(enabledDeniedTools["get-order-timeline"]).toBeUndefined();
  });

  test("registers when SHOPIFY_MCP_ENABLE_ORDER_TIMELINE=true and routes to the selected store in multi-store mode", async () => {
    const seenUrls: string[] = [];
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.includes("/admin/oauth/access_token")) {
        return new Response(
          JSON.stringify({
            access_token: "token-allpedal",
            expires_in: 86_400,
            scope: "read_orders",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/graphql.json")) {
        return new Response(
          JSON.stringify({
            data: {
              order: makeOrderPayload({
                name: "#55100",
                note: "Checked by support",
              }),
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected fetch URL: ${url}`);
    });

    const registry = new StoreRegistry(STORES, "2026-01", { fetchImpl });
    registries.push(registry);
    const server = createShopifyMcpServer(
      { mode: "multi", registry },
      { SHOPIFY_MCP_ENABLE_ORDER_TIMELINE: "true" },
    );
    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          {
            inputSchema: { safeParse: (v: unknown) => { success: boolean } };
            callback: (
              args: Record<string, unknown>,
              extra: unknown,
            ) => Promise<{ content: Array<{ type: string; text: string }> }>;
          }
        >;
      }
    )._registeredTools["get-order-timeline"];

    expect(registered).toBeDefined();
    expect(
      registered.inputSchema.safeParse({ orderId: ORDER_NUMERIC_ID }).success,
    ).toBe(false);
    expect(
      registered.inputSchema.safeParse({
        store: "allpedal",
        orderId: ORDER_NUMERIC_ID,
      }).success,
    ).toBe(true);

    const mcpResp = await registered.callback(
      { store: "allpedal", orderId: ORDER_NUMERIC_ID },
      {},
    );
    const parsed = JSON.parse(mcpResp.content[0].text);
    expect(parsed.order).toEqual({
      id: ORDER_GID,
      name: "#55100",
      currentNote: "Checked by support",
    });
    expect(
      seenUrls.some((u) =>
        u.startsWith("https://allpedal-test.myshopify.com/admin/api/2026-01/graphql.json"),
      ),
    ).toBe(true);
    expect(seenUrls.some((u) => u.includes("wgs-test.myshopify.com"))).toBe(
      false,
    );
  });
});
