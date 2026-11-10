// Registry registration: MCP tool descriptions only stick when the SDK
// sees a string as the second argument to server.tool(). Index.ts used to
// pass schema.shape there, so every tools/list entry had an empty
// description. This suite registers the same way index.ts does (the
// 4-arg form) and asserts descriptions and unique names.

import { describe, expect, test } from "@jest/globals";

import { createShopifyMcpServer } from "../lib/registerTools.js";
import type { StoreContext } from "../lib/toolUtils.js";
import { tools } from "./registry.js";

const singleContext: StoreContext = {
  client: {} as StoreContext["client"],
  domain: "example.myshopify.com",
  storeKey: "example.myshopify.com",
  getAccessToken: () => "token",
  apiVersion: "2026-01",
};

describe("tool registry MCP registration", () => {
  test("registers 52 baseline tools by default and keeps get-order-timeline opt-in", () => {
    const server = createShopifyMcpServer({ mode: "single", context: singleContext }, {});

    const registered = (server as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    })._registeredTools;

    const history = registered["get-product-order-history"];
    expect(typeof history?.description).toBe("string");
    expect(history.description && history.description.length > 0).toBe(true);

    const names = Object.keys(registered);
    expect(names).toHaveLength(52);
    expect(new Set(names).size).toBe(52);
    expect(tools).toHaveLength(53);
    expect(registered["order-edit"]).toBeDefined();
    expect(registered["get-order-returns"]).toBeDefined();
    expect(registered["get-order-timeline"]).toBeUndefined();

    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      if (tool.name === "get-order-timeline") continue;
      const entry = registered[tool.name];
      expect(entry).toBeDefined();
      expect(typeof entry.description).toBe("string");
      expect(entry.description && entry.description.length > 0).toBe(true);
    }
  });

  test("registers get-order-timeline only when SHOPIFY_MCP_ENABLE_ORDER_TIMELINE=true and disable list wins", () => {
    const enabledServer = createShopifyMcpServer(
      { mode: "single", context: singleContext },
      { SHOPIFY_MCP_ENABLE_ORDER_TIMELINE: "true" },
    );
    const enabledRegistered = (enabledServer as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    })._registeredTools;
    expect(Object.keys(enabledRegistered)).toHaveLength(53);
    expect(enabledRegistered["get-order-timeline"]).toBeDefined();

    const deniedServer = createShopifyMcpServer(
      { mode: "single", context: singleContext },
      {
        SHOPIFY_MCP_ENABLE_ORDER_TIMELINE: "true",
        SHOPIFY_MCP_DISABLED_TOOLS: "get-order-timeline",
      },
    );
    const deniedRegistered = (deniedServer as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    })._registeredTools;
    expect(Object.keys(deniedRegistered)).toHaveLength(52);
    expect(deniedRegistered["get-order-timeline"]).toBeUndefined();
  });

  test("get-orders query is capped at 4096 characters", () => {
    const getOrders = tools.find((tool) => tool.name === "get-orders");
    expect(getOrders).toBeDefined();
    const querySchema = getOrders!.schema.shape.query;
    expect(querySchema.safeParse("x".repeat(4096)).success).toBe(true);
    expect(querySchema.safeParse("x".repeat(4097)).success).toBe(false);
  });
});
