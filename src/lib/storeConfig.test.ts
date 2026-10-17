import { describe, expect, test } from "@jest/globals";

import {
  ConfigError,
  credentialOverrideName,
  loadServerConfig,
  parseStoreList,
} from "./storeConfig.js";

const SHARED = {
  SHOPIFY_CLIENT_ID: "shared-id",
  SHOPIFY_CLIENT_SECRET: "shared-secret",
};

describe("parseStoreList", () => {
  test("parses a valid list and keeps order", () => {
    expect(
      parseStoreList(
        "wgs=wgsusa.myshopify.com, allpedal=allpedal.myshopify.com,amperian=amperian.myshopify.com, fortin=fortinamps.myshopify.com",
      ),
    ).toEqual([
      { key: "wgs", domain: "wgsusa.myshopify.com" },
      { key: "allpedal", domain: "allpedal.myshopify.com" },
      { key: "amperian", domain: "amperian.myshopify.com" },
      { key: "fortin", domain: "fortinamps.myshopify.com" },
    ]);
  });

  test("lowercases the domain", () => {
    expect(parseStoreList("wgs=WGSUSA.myshopify.com")).toEqual([
      { key: "wgs", domain: "wgsusa.myshopify.com" },
    ]);
  });

  test("rejects a malformed entry", () => {
    expect(() => parseStoreList("wgs")).toThrow(ConfigError);
    expect(() => parseStoreList("wgs")).toThrow(/Malformed SHOPIFY_STORES entry/);
    expect(() => parseStoreList("=wgsusa.myshopify.com")).toThrow(/Malformed/);
    expect(() => parseStoreList("wgs=wgsusa.myshopify.com=extra")).toThrow(/Malformed/);
    expect(() => parseStoreList("wgs=wgsusa.myshopify.com,,allpedal=allpedal.myshopify.com")).toThrow(
      /empty entry/,
    );
  });

  test("rejects a bad key", () => {
    expect(() => parseStoreList("Wgs=wgsusa.myshopify.com")).toThrow(/Invalid store key/);
    expect(() => parseStoreList("1wgs=wgsusa.myshopify.com")).toThrow(/Invalid store key/);
    expect(() => parseStoreList("wgs_usa=wgsusa.myshopify.com")).toThrow(/Invalid store key/);
    expect(() => parseStoreList(`${"a".repeat(33)}=wgsusa.myshopify.com`)).toThrow(
      /Invalid store key/,
    );
  });

  test("rejects a non-myshopify domain", () => {
    expect(() => parseStoreList("wgs=wgsusa.com")).toThrow(/Invalid Shopify domain/);
    expect(() => parseStoreList("wgs=https://wgsusa.myshopify.com")).toThrow(
      /Invalid Shopify domain/,
    );
    expect(() => parseStoreList("wgs=myshopify.com")).toThrow(/Invalid Shopify domain/);
  });

  test("rejects a duplicate key", () => {
    expect(() =>
      parseStoreList("wgs=wgsusa.myshopify.com,wgs=other.myshopify.com"),
    ).toThrow(/Duplicate store key "wgs"/);
  });

  test("rejects a duplicate domain", () => {
    expect(() =>
      parseStoreList("wgs=wgsusa.myshopify.com,speakers=wgsusa.myshopify.com"),
    ).toThrow(/Duplicate Shopify domain/);
  });
});

describe("loadServerConfig", () => {
  test("single-store mode when SHOPIFY_STORES is unset", () => {
    const config = loadServerConfig({
      SHOPIFY_ACCESS_TOKEN: "shpat_static",
      MYSHOPIFY_DOMAIN: "wgsusa.myshopify.com",
    });
    expect(config).toEqual({
      mode: "single",
      domain: "wgsusa.myshopify.com",
      apiVersion: "2026-01",
      auth: { kind: "static", accessToken: "shpat_static" },
    });
  });

  test("single-store client credentials win over a static token, matching today", () => {
    const config = loadServerConfig({
      SHOPIFY_ACCESS_TOKEN: "shpat_static",
      SHOPIFY_CLIENT_ID: "id",
      SHOPIFY_CLIENT_SECRET: "secret",
      MYSHOPIFY_DOMAIN: "wgsusa.myshopify.com",
      SHOPIFY_API_VERSION: "2025-10",
    });
    expect(config.mode).toBe("single");
    if (config.mode !== "single") return;
    expect(config.apiVersion).toBe("2025-10");
    expect(config.auth).toEqual({
      kind: "client_credentials",
      clientId: "id",
      clientSecret: "secret",
    });
  });

  test("CLI --stores selects multi-store mode and overrides the env list", () => {
    const config = loadServerConfig(
      {
        ...SHARED,
        SHOPIFY_STORES: "ignored=ignored.myshopify.com",
        MYSHOPIFY_DOMAIN: "should-not-matter.myshopify.com",
      },
      { stores: "wgs=wgsusa.myshopify.com,allpedal=allpedal.myshopify.com" },
    );
    expect(config.mode).toBe("multi");
    if (config.mode !== "multi") return;
    expect(config.stores.map((store) => store.key)).toEqual(["wgs", "allpedal"]);
    expect(config.stores[0]).toMatchObject({
      domain: "wgsusa.myshopify.com",
      clientId: "shared-id",
      clientSecret: "shared-secret",
    });
  });

  test("per-store credential override uses KEY with hyphens turned into underscores", () => {
    const config = loadServerConfig({
      ...SHARED,
      SHOPIFY_STORES: "wgs=wgsusa.myshopify.com,all-pedal=allpedal.myshopify.com",
      [credentialOverrideName("SHOPIFY_CLIENT_ID", "all-pedal")]: "pedal-id",
      [credentialOverrideName("SHOPIFY_CLIENT_SECRET", "all-pedal")]: "pedal-secret",
    });
    if (config.mode !== "multi") throw new Error("expected multi");
    const wgs = config.stores.find((store) => store.key === "wgs");
    const pedal = config.stores.find((store) => store.key === "all-pedal");
    expect(wgs).toMatchObject({ clientId: "shared-id", clientSecret: "shared-secret" });
    expect(pedal).toMatchObject({ clientId: "pedal-id", clientSecret: "pedal-secret" });
    expect(credentialOverrideName("SHOPIFY_CLIENT_ID", "all-pedal")).toBe(
      "SHOPIFY_CLIENT_ID__ALL_PEDAL",
    );
  });

  test("a partial per-store override is a startup error and does not echo the secret", () => {
    expect(() =>
      loadServerConfig({
        ...SHARED,
        SHOPIFY_STORES: "wgs=wgsusa.myshopify.com",
        SHOPIFY_CLIENT_ID__WGS: "only-the-id",
        SHOPIFY_CLIENT_SECRET: "shared-secret",
      }),
    ).toThrow(/partial credential override/);
    try {
      loadServerConfig({
        ...SHARED,
        SHOPIFY_STORES: "wgs=wgsusa.myshopify.com",
        SHOPIFY_CLIENT_SECRET__WGS: "only-the-secret",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain("only-the-secret");
      expect((err as Error).message).not.toContain("shared-secret");
    }
  });

  test("multi-store mode requires the shared client id and secret", () => {
    expect(() =>
      loadServerConfig({ SHOPIFY_STORES: "wgs=wgsusa.myshopify.com" }),
    ).toThrow(/SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET/);
  });

  test("empty SHOPIFY_STORES is a startup error", () => {
    expect(() => loadServerConfig({ ...SHARED, SHOPIFY_STORES: "  " })).toThrow(
      /SHOPIFY_STORES is empty/,
    );
  });

  test("single-store errors keep the original text", () => {
    expect(() => loadServerConfig({})).toThrow(
      /Authentication credentials are required/,
    );
    expect(() => loadServerConfig({ SHOPIFY_ACCESS_TOKEN: "shpat_x" })).toThrow(
      /MYSHOPIFY_DOMAIN is required/,
    );
  });
});
