// Registry registration: MCP tool descriptions only stick when the SDK
// sees a string as the second argument to server.tool(). Index.ts used to
// pass schema.shape there, so every tools/list entry had an empty
// description. This suite registers the same way index.ts does (the
// 4-arg form) and asserts descriptions and unique names.

import { describe, expect, test } from "@jest/globals";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { tools } from "./registry.js";

describe("tool registry MCP registration", () => {
  test("registers 50 uniquely named tools with non-empty descriptions", () => {
    const server = new McpServer({ name: "t", version: "0" });
    for (const tool of tools) {
      server.tool(tool.name, tool.description, tool.schema.shape, async (args) => {
        const result = await tool.execute(args);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        };
      });
    }

    const registered = (server as unknown as {
      _registeredTools: Record<string, { description?: string }>;
    })._registeredTools;

    const history = registered["get-product-order-history"];
    expect(typeof history?.description).toBe("string");
    expect(history.description && history.description.length > 0).toBe(true);

    const names = Object.keys(registered);
    expect(names).toHaveLength(50);
    expect(new Set(names).size).toBe(50);
    expect(tools).toHaveLength(50);

    for (const tool of tools) {
      const entry = registered[tool.name];
      expect(entry).toBeDefined();
      expect(typeof entry.description).toBe("string");
      expect(entry.description && entry.description.length > 0).toBe(true);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  test("get-orders query is capped at 4096 characters", () => {
    const getOrders = tools.find((tool) => tool.name === "get-orders");
    expect(getOrders).toBeDefined();
    const querySchema = getOrders!.schema.shape.query;
    expect(querySchema.safeParse("x".repeat(4096)).success).toBe(true);
    expect(querySchema.safeParse("x".repeat(4097)).success).toBe(false);
  });
});
