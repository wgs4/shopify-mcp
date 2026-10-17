// Multi-store registration: schemas, routing, and auth isolation.
// Fetch is mocked. No network.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

import { createShopifyMcpServer } from "./registerTools.js";
import { StoreRegistry } from "./storeRegistry.js";
import type { StoreCredential } from "./storeConfig.js";
import type { StoreContext } from "./toolUtils.js";
import { tools } from "../tools/registry.js";

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

const STORE_DESCRIPTION =
  "Which Shopify store: wgs | allpedal. Required; there is no default.";

interface RegisteredTool {
  description?: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  callback: (
    args: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function registeredTools(server: ReturnType<typeof createShopifyMcpServer>) {
  return (server as unknown as { _registeredTools: Record<string, RegisteredTool> })
    ._registeredTools;
}

function serverName(server: ReturnType<typeof createShopifyMcpServer>): string {
  return (server.server as unknown as { _serverInfo: { name: string } })._serverInfo.name;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface SeenCall {
  url: string;
  token?: string;
  body: string;
}

const registries: StoreRegistry[] = [];

afterEach(() => {
  for (const registry of registries) registry.destroy();
  registries.length = 0;
  jest.restoreAllMocks();
});

describe("single-store tool schemas", () => {
  test("tools/list schemas match the tool's own schema and have no store argument", () => {
    const context: StoreContext = {
      client: {} as StoreContext["client"],
      domain: "only.myshopify.com",
      storeKey: "only.myshopify.com",
      getAccessToken: () => "static",
      apiVersion: "2026-01",
    };
    const server = createShopifyMcpServer({ mode: "single", context });
    expect(serverName(server)).toBe("shopify");
    const registered = registeredTools(server);
    expect(Object.keys(registered)).toHaveLength(50);

    for (const tool of tools) {
      const entry = registered[tool.name];
      expect(entry.description).toBe(tool.description);
      expect(entry.inputSchema.shape.store).toBeUndefined();
      expect(zodToJsonSchema(entry.inputSchema, { strictUnions: true })).toEqual(
        zodToJsonSchema(z.object(tool.schema.shape), { strictUnions: true }),
      );
    }
  });
});

describe("multi-store tool schemas and routing", () => {
  function setup(fetchImpl: typeof fetch) {
    const registry = new StoreRegistry(STORES, "2026-01", { fetchImpl });
    registries.push(registry);
    const server = createShopifyMcpServer({ mode: "multi", registry });
    return { server, registry, tools: registeredTools(server) };
  }

  test("every tool requires a store enum and keeps its description", () => {
    const { server, tools: registered } = setup(async () => {
      throw new Error("schema inspection must not fetch");
    });
    expect(serverName(server)).toBe("shopify");
    expect(Object.keys(registered)).toHaveLength(tools.length);

    for (const tool of tools) {
      const entry = registered[tool.name];
      expect(entry.description).toBe(tool.description);
      const storeField = entry.inputSchema.shape.store;
      expect(storeField).toBeDefined();
      expect(storeField).not.toBeInstanceOf(z.ZodDefault);
      expect(storeField.description).toBe(STORE_DESCRIPTION);
      expect(storeField.safeParse("wgs").success).toBe(true);
      expect(storeField.safeParse("allpedal").success).toBe(true);
      expect(storeField.safeParse("nope").success).toBe(false);
      expect(storeField.safeParse(undefined).success).toBe(false);
      const missing = entry.inputSchema.safeParse({});
      expect(missing.success).toBe(false);
      if (!missing.success) {
        expect(missing.error.issues.some((issue) => issue.path[0] === "store")).toBe(true);
      }
      expect(tool.schema.shape.store).toBeUndefined();
    }
  });

  test("missing or unknown store is rejected before any request", async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error("request should not run");
    });
    const { tools: registered } = setup(fetchImpl);
    const callback = registered["get-shop-info"].callback;
    await expect(callback({}, {})).rejects.toThrow(/Invalid store/);
    await expect(callback({ store: "nope" }, {})).rejects.toThrow(/Invalid store "nope"/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a call routes to that store's domain with that store's token", async () => {
    const calls: SeenCall[] = [];
    const fetchImpl = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const rawBody = init?.body;
      const body =
        typeof rawBody === "string"
          ? rawBody
          : rawBody instanceof URLSearchParams
            ? rawBody.toString()
            : "";
      calls.push({ url, token: headers["X-Shopify-Access-Token"], body });
      if (url.includes("/admin/oauth/access_token")) {
        const host = new URL(url).host;
        const token = host.startsWith("wgs-test") ? "token-wgs" : "token-allpedal";
        return jsonResponse({ access_token: token, expires_in: 86_400, scope: "read_products" });
      }
      if (url.includes("/graphql.json")) {
        return jsonResponse({ data: { shop: { name: new URL(url).host } } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { tools: registered } = setup(fetchImpl);
    const callback = registered["get-shop-info"].callback;

    const wgs = await callback({ store: "wgs" }, {});
    expect(JSON.parse(wgs.content[0].text).shop.name).toBe("wgs-test.myshopify.com");
    const wgsGraphql = calls.filter((call) => call.url.includes("/graphql.json"));
    expect(wgsGraphql).toHaveLength(1);
    expect(wgsGraphql[0].url).toBe(
      "https://wgs-test.myshopify.com/admin/api/2026-01/graphql.json",
    );
    expect(wgsGraphql[0].token).toBe("token-wgs");
    const wgsToken = calls.find((call) => call.url.includes("/admin/oauth/access_token"));
    expect(wgsToken?.url).toBe("https://wgs-test.myshopify.com/admin/oauth/access_token");
    expect(wgsToken?.body).toContain("client_id=id-wgs");
    expect(wgsToken?.body).not.toContain("secret-allpedal");

    calls.length = 0;
    const allpedal = await callback({ store: "allpedal" }, {});
    expect(JSON.parse(allpedal.content[0].text).shop.name).toBe(
      "allpedal-test.myshopify.com",
    );
    const allGraphql = calls.filter((call) => call.url.includes("/graphql.json"));
    expect(allGraphql).toHaveLength(1);
    expect(allGraphql[0].url).toBe(
      "https://allpedal-test.myshopify.com/admin/api/2026-01/graphql.json",
    );
    expect(allGraphql[0].token).toBe("token-allpedal");
    expect(calls.find((call) => call.url.includes("access_token"))?.body).toContain(
      "client_id=id-allpedal",
    );
  });

  test("one store's token failure leaves the other store working", async () => {
    const graphqlHosts: string[] = [];
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("wgs-test.myshopify.com/admin/oauth/access_token")) {
        return jsonResponse(
          {
            error: "invalid_client",
            error_description: "nope secret-wgs",
            access_token: "shpat_LEAKEDTOKEN",
            raw: "RAWBODYMARKER",
          },
          401,
        );
      }
      if (url.includes("allpedal-test.myshopify.com/admin/oauth/access_token")) {
        return jsonResponse({
          access_token: "token-allpedal",
          expires_in: 86_400,
          scope: "read_products",
        });
      }
      if (url.includes("/graphql.json")) {
        graphqlHosts.push(new URL(url).host);
        return jsonResponse({ data: { shop: { name: new URL(url).host } } });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { tools: registered } = setup(fetchImpl);
    const callback = registered["get-shop-info"].callback;
    await expect(callback({ store: "wgs" }, {})).rejects.toThrow(
      /Store "wgs" authentication failed/,
    );
    try {
      await callback({ store: "wgs" }, {});
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("secret-wgs");
      expect(message).not.toContain("shpat_");
      expect(message).not.toContain("RAWBODYMARKER");
    }
    expect(graphqlHosts).toHaveLength(0);

    const ok = await callback({ store: "allpedal" }, {});
    expect(JSON.parse(ok.content[0].text).shop.name).toBe("allpedal-test.myshopify.com");
    expect(graphqlHosts).toEqual(["allpedal-test.myshopify.com"]);
  });
});
