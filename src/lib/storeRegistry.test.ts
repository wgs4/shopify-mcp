import { afterEach, describe, expect, jest, test } from "@jest/globals";

import { StoreRegistry } from "./storeRegistry.js";
import type { StoreCredential } from "./storeConfig.js";

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

function jsonResponse(body: unknown, status = 200, headers?: Headers): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers ?? { "Content-Type": "application/json" },
  });
}

function tokenBody(token: string) {
  return { access_token: token, expires_in: 86_400, scope: "read_products" };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("StoreRegistry", () => {
  test("concurrent first calls for one store share a single token fetch", async () => {
    let tokenFetches = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/admin/oauth/access_token")) {
        tokenFetches += 1;
        await gate;
        return jsonResponse(tokenBody("tok-wgs"));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const registry = new StoreRegistry(STORES, "2026-01", { fetchImpl });
    try {
      const first = registry.contextFor("wgs");
      const second = registry.contextFor("wgs");
      expect(tokenFetches).toBe(1);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.getAccessToken()).toBe("tok-wgs");
      expect(b.getAccessToken()).toBe("tok-wgs");
      expect(a.client).toBe(b.client);
      expect(tokenFetches).toBe(1);
      const tokenCalls = fetchImpl.mock.calls.filter((call) =>
        String(call[0]).includes("/admin/oauth/access_token"),
      );
      expect(tokenCalls).toHaveLength(1);
      expect(String(tokenCalls[0][0])).toBe(
        "https://wgs-test.myshopify.com/admin/oauth/access_token",
      );
    } finally {
      registry.destroy();
    }
  });

  test("one store failing auth does not block another store", async () => {
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
        return jsonResponse(tokenBody("tok-allpedal"));
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const previous = process.env.SHOPIFY_ACCESS_TOKEN;
    const registry = new StoreRegistry(STORES, "2026-01", { fetchImpl });
    try {
      await expect(registry.contextFor("wgs")).rejects.toThrow(
        /Store "wgs" authentication failed/,
      );
      try {
        await registry.contextFor("wgs");
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain("secret-wgs");
        expect(message).not.toContain("shpat_");
        expect(message).not.toContain("RAWBODYMARKER");
        expect(message).toContain("invalid_client");
      }
      const other = await registry.contextFor("allpedal");
      expect(other.domain).toBe("allpedal-test.myshopify.com");
      expect(other.getAccessToken()).toBe("tok-allpedal");
      expect(other.storeKey).toBe("allpedal");
      expect(process.env.SHOPIFY_ACCESS_TOKEN).toBe(previous);
    } finally {
      registry.destroy();
      if (previous === undefined) {
        delete process.env.SHOPIFY_ACCESS_TOKEN;
      } else {
        process.env.SHOPIFY_ACCESS_TOKEN = previous;
      }
    }
  });
});
