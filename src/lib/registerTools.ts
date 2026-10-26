import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { StoreRegistry } from "./storeRegistry.js";
import type { ShopifyTool, StoreContext } from "./toolUtils.js";
import { tools } from "../tools/registry.js";

export interface SingleStoreRegistration {
  mode: "single";
  context: StoreContext;
}

export interface MultiStoreRegistration {
  mode: "multi";
  registry: StoreRegistry;
}

export type ToolRegistration = SingleStoreRegistration | MultiStoreRegistration;

export function storeArgumentSchema(keys: readonly string[]) {
  if (keys.length === 0) {
    throw new Error("Multi-store mode requires at least one store.");
  }
  const tuple = [keys[0], ...keys.slice(1)] as [string, ...string[]];
  return z.enum(tuple).describe(
    `Which Shopify store: ${keys.join(" | ")}. Required; there is no default.`,
  );
}

function toolResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
  };
}

/**
 * Register every tool. Multi-store mode adds a required `store` argument and
 * strips it before the tool body runs. Single-store mode registers the tool
 * schema unchanged.
 */
export function registerShopifyTools(
  server: McpServer,
  toolList: readonly ShopifyTool[],
  options: ToolRegistration,
): void {
  for (const tool of toolList) {
    if (options.mode === "single") {
      const context = options.context;
      server.tool(tool.name, tool.description, tool.schema.shape, async (args) => {
        const result = await tool.execute(args as Record<string, unknown>, context);
        return toolResult(result);
      });
      continue;
    }

    const registry = options.registry;
    const shape = {
      ...tool.schema.shape,
      store: storeArgumentSchema(registry.keys()),
    };
    server.tool(tool.name, tool.description, shape, async (args) => {
      const record = args as Record<string, unknown>;
      const storeKey = record.store;
      if (typeof storeKey !== "string" || !registry.has(storeKey)) {
        const shown = typeof storeKey === "string" ? storeKey : "";
        throw new Error(
          `Invalid store "${shown}". Expected one of: ${registry.keys().join(" | ")}.`,
        );
      }
      const { store: _store, ...input } = record;
      const ctx = await registry.contextFor(storeKey);
      const result = await tool.execute(input, ctx);
      return toolResult(result);
    });
  }
}

/**
 * Tool names listed in SHOPIFY_MCP_DISABLED_TOOLS (comma-separated).
 *
 * Used by restricted deployments (the Fortin MCP for Jason Wilding hides
 * refund-create, order-cancel, order-mark-as-paid and complete-draft-order,
 * so write_orders lets him edit notes/tags but not move money).
 */
export function disabledToolNames(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set(
    (env.SHOPIFY_MCP_DISABLED_TOOLS ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  );
}

/**
 * Drop disabled tools. Fails closed: a name that matches no tool throws, so a
 * typo can never leave a tool exposed that the deployment meant to hide.
 */
export function withoutDisabledTools(
  toolList: readonly ShopifyTool[],
  disabled: ReadonlySet<string>,
): ShopifyTool[] {
  const known = new Set(toolList.map((tool) => tool.name));
  const unknown = [...disabled].filter((name) => !known.has(name)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `SHOPIFY_MCP_DISABLED_TOOLS names unknown tools: ${unknown.join(", ")}`,
    );
  }
  return toolList.filter((tool) => !disabled.has(tool.name));
}

export function createShopifyMcpServer(options: ToolRegistration): McpServer {
  const server = new McpServer({
    name: "shopify",
    version: "1.0.0",
    description:
      "MCP Server for Shopify API, enabling interaction with store data through GraphQL API",
  });
  registerShopifyTools(server, withoutDisabledTools(tools, disabledToolNames()), options);
  return server;
}
