// Access-scope cache, write-implies-read, and ACCESS_DENIED inspection.
// Tests must FAIL if the cache / implication helpers are missing.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import {
  FULFILLMENT_ORDER_SCOPES,
  SCOPE_CACHE_TTL_MS,
  _resetForTest,
  getAccessScopes,
  hasAnyScope,
  hasScope,
  invalidateAccessScopes,
  isAccessDeniedError,
  missingScopeError,
} from "./accessScopes.js";

afterEach(() => {
  _resetForTest();
});

function fakeClient(): {
  client: GraphQLClient;
  request: jest.Mock;
} {
  const request = jest.fn();
  const rawRequest = jest.fn();
  return {
    client: { request, rawRequest } as unknown as GraphQLClient,
    request,
  };
}

function scopePayload(handles: string[]) {
  return {
    currentAppInstallation: {
      accessScopes: handles.map((handle) => ({ handle })),
    },
  };
}

describe("getAccessScopes cache", () => {
  test("cache hit within TTL calls request once", async () => {
    const { client, request } = fakeClient();
    request.mockResolvedValue(scopePayload(["read_orders"]));
    const t0 = 1_000_000;
    await expect(getAccessScopes(client, { nowMs: t0 })).resolves.toEqual([
      "read_orders",
    ]);
    await expect(
      getAccessScopes(client, { nowMs: t0 + SCOPE_CACHE_TTL_MS - 1 }),
    ).resolves.toEqual(["read_orders"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toMatch(/CurrentAccessScopes/);
  });

  test("cache miss after TTL refetches", async () => {
    const { client, request } = fakeClient();
    request
      .mockResolvedValueOnce(scopePayload(["read_orders"]))
      .mockResolvedValueOnce(scopePayload(["read_orders", "read_all_orders"]));
    const t0 = 1_000_000;
    await expect(getAccessScopes(client, { nowMs: t0 })).resolves.toEqual([
      "read_orders",
    ]);
    await expect(
      getAccessScopes(client, { nowMs: t0 + SCOPE_CACHE_TTL_MS }),
    ).resolves.toEqual(["read_orders", "read_all_orders"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("force bypasses a warm cache", async () => {
    const { client, request } = fakeClient();
    request
      .mockResolvedValueOnce(scopePayload(["read_orders"]))
      .mockResolvedValueOnce(scopePayload(["read_all_orders"]));
    const t0 = 1_000_000;
    await getAccessScopes(client, { nowMs: t0 });
    await expect(
      getAccessScopes(client, { nowMs: t0 + 1, force: true }),
    ).resolves.toEqual(["read_all_orders"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("invalidate drops the cached entry", async () => {
    const { client, request } = fakeClient();
    request
      .mockResolvedValueOnce(scopePayload(["read_orders"]))
      .mockResolvedValueOnce(scopePayload(["read_products"]));
    const t0 = 1_000_000;
    await getAccessScopes(client, { nowMs: t0 });
    invalidateAccessScopes(client);
    await expect(getAccessScopes(client, { nowMs: t0 + 1 })).resolves.toEqual([
      "read_products",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("WeakMap isolates two clients", async () => {
    const a = fakeClient();
    const b = fakeClient();
    a.request.mockResolvedValue(scopePayload(["read_orders"]));
    b.request.mockResolvedValue(scopePayload(["read_all_orders"]));
    const t0 = 1_000_000;
    await expect(getAccessScopes(a.client, { nowMs: t0 })).resolves.toEqual([
      "read_orders",
    ]);
    await expect(getAccessScopes(b.client, { nowMs: t0 })).resolves.toEqual([
      "read_all_orders",
    ]);
    await getAccessScopes(a.client, { nowMs: t0 + 1 });
    expect(a.request).toHaveBeenCalledTimes(1);
    expect(b.request).toHaveBeenCalledTimes(1);
  });

  test("errors propagate and are not cached", async () => {
    const { client, request } = fakeClient();
    request
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(scopePayload(["read_orders"]));
    await expect(getAccessScopes(client, { nowMs: 1 })).rejects.toThrow(
      "network down",
    );
    await expect(getAccessScopes(client, { nowMs: 2 })).resolves.toEqual([
      "read_orders",
    ]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  test("missing currentAppInstallation throws (no silent empty list)", async () => {
    const { client, request } = fakeClient();
    request.mockResolvedValue({ currentAppInstallation: null });
    await expect(getAccessScopes(client)).rejects.toThrow(
      /accessScopes missing/,
    );
    request.mockResolvedValue({ currentAppInstallation: { accessScopes: [] } });
    await expect(getAccessScopes(client, { force: true })).resolves.toEqual([]);
    request.mockResolvedValue({ currentAppInstallation: {} });
    await expect(getAccessScopes(client, { force: true })).rejects.toThrow(
      /accessScopes missing/,
    );
  });

  test("defaults nowMs to Date.now()", async () => {
    const { client, request } = fakeClient();
    request.mockResolvedValue(scopePayload(["read_orders"]));
    const spy = jest.spyOn(Date, "now").mockReturnValue(42);
    try {
      await getAccessScopes(client);
      await getAccessScopes(client);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("hasScope / hasAnyScope", () => {
  test("write_* implies the matching read_* twin", () => {
    expect(hasScope(["write_orders"], "read_orders")).toBe(true);
    expect(hasScope(["write_orders"], "write_orders")).toBe(true);
    expect(hasScope(["read_orders"], "read_orders")).toBe(true);
    expect(hasScope(["read_orders"], "write_orders")).toBe(false);
    expect(hasScope(["write_orders"], "read_products")).toBe(false);
    expect(hasScope(["write_orders"], "orders")).toBe(false);
    expect(hasScope([], "read_orders")).toBe(false);
  });

  test("read_all_orders has no write twin in practice, but the rule still applies", () => {
    expect(hasScope(["read_all_orders"], "read_all_orders")).toBe(true);
    expect(hasScope(["write_all_orders"], "read_all_orders")).toBe(true);
    expect(hasScope(["read_orders"], "read_all_orders")).toBe(false);
  });

  test("hasAnyScope uses the same implication", () => {
    expect(hasAnyScope(["read_orders"], [...FULFILLMENT_ORDER_SCOPES])).toBe(
      false,
    );
    expect(
      hasAnyScope(
        ["write_merchant_managed_fulfillment_orders"],
        [...FULFILLMENT_ORDER_SCOPES],
      ),
    ).toBe(true);
    expect(hasAnyScope(["read_assigned_fulfillment_orders"], [
      ...FULFILLMENT_ORDER_SCOPES,
    ])).toBe(true);
    expect(hasAnyScope(["read_orders"], [])).toBe(false);
    expect(hasAnyScope([], ["read_orders"])).toBe(false);
  });

  test("FULFILLMENT_ORDER_SCOPES lists the three fulfillment-order reads", () => {
    expect([...FULFILLMENT_ORDER_SCOPES]).toEqual([
      "read_merchant_managed_fulfillment_orders",
      "read_assigned_fulfillment_orders",
      "read_third_party_fulfillment_orders",
    ]);
  });
});

describe("missingScopeError", () => {
  test("formats a string scope", () => {
    const err = missingScopeError("returns", "read_returns");
    expect(err.name).toBe("MissingScopeError");
    expect((err as Error & { code: string }).code).toBe("MISSING_SCOPE");
    expect(err.message).toBe(
      "Access denied for returns: this app's token lacks read_returns. Add the scope to app shop-wgs-mcp-8-6-26 and re-authorize the store.",
    );
  });

  test("joins an array of scopes with plural fulfillment-order wording", () => {
    const err = missingScopeError("fulfillmentOrders", [
      "read_merchant_managed_fulfillment_orders",
      "read_assigned_fulfillment_orders",
    ]);
    expect(err.message).toBe(
      "Access denied for fulfillmentOrders: this app's token lacks the fulfillment-order scopes (read_merchant_managed_fulfillment_orders, read_assigned_fulfillment_orders). Add them to app shop-wgs-mcp-8-6-26 and re-authorize the store.",
    );
  });
});

describe("isAccessDeniedError", () => {
  test("parses a fake ClientError-like ACCESS_DENIED payload", () => {
    const err = {
      response: {
        errors: [
          {
            message: "Access denied for returns field.",
            extensions: { code: "ACCESS_DENIED" },
            path: ["order", "returns"],
          },
        ],
      },
    };
    expect(isAccessDeniedError(err)).toEqual({ field: "returns" });
  });

  test("ACCESS_DENIED with a non-parseable message still matches", () => {
    const err = {
      response: {
        errors: [
          {
            message: "nope",
            extensions: { code: "ACCESS_DENIED" },
          },
        ],
      },
    };
    expect(isAccessDeniedError(err)).toEqual({ field: null });
  });

  test("message prefix without extensions.code still matches", () => {
    const err = {
      response: {
        errors: [{ message: "Access denied for fulfillmentOrders field." }],
      },
    };
    expect(isAccessDeniedError(err)).toEqual({ field: "fulfillmentOrders" });
  });

  test("top-level Error message is inspected when response.errors is absent", () => {
    expect(
      isAccessDeniedError(new Error("Access denied for returns field.")),
    ).toEqual({ field: "returns" });
  });

  test("unrelated errors return null", () => {
    expect(isAccessDeniedError(null)).toBeNull();
    expect(isAccessDeniedError(undefined)).toBeNull();
    expect(isAccessDeniedError("Access denied for returns field.")).toBeNull();
    expect(isAccessDeniedError(123)).toBeNull();
    expect(isAccessDeniedError(new Error("network down"))).toBeNull();
    expect(isAccessDeniedError({ response: { errors: [] } })).toBeNull();
    expect(
      isAccessDeniedError({
        response: {
          errors: [{ message: "THROTTLED", extensions: { code: "THROTTLED" } }],
        },
      }),
    ).toBeNull();
    expect(isAccessDeniedError({ response: {} })).toBeNull();
  });
});