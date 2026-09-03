// handleToolError wrapping: network-shaped codes must be wrapped, typed
// tool errors must pass through unwrapped.

import { describe, expect, test } from "@jest/globals";

import { ScopeHorizonError } from "./orderWall.js";
import { handleToolError } from "./toolUtils.js";

describe("handleToolError typed vs wrapped", () => {
  test("FetchError-like ECONNREFUSED is wrapped with Failed to fetch orders:", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    expect(() => handleToolError("fetch orders", err)).toThrow(
      /^Failed to fetch orders:/,
    );
    try {
      handleToolError("fetch orders", err);
    } catch (caught) {
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("Failed to fetch orders:");
      expect((caught as Error).message).toContain("ECONNREFUSED");
    }
  });

  test("ScopeHorizonError passes through", () => {
    const err = new ScopeHorizonError({
      missing: "read_all_orders",
      horizon: "2026-07-05T12:00:00.000Z",
      reason: "before_horizon",
    });
    try {
      handleToolError("fetch orders", err);
      throw new Error("expected throw");
    } catch (caught) {
      expect(caught).toBe(err);
      expect(caught).toBeInstanceOf(ScopeHorizonError);
    }
  });

  test("error with code SCOPE_HORIZON passes through", () => {
    const err = Object.assign(new Error("horizon blocked"), {
      code: "SCOPE_HORIZON",
    });
    try {
      handleToolError("fetch orders", err);
      throw new Error("expected throw");
    } catch (caught) {
      expect(caught).toBe(err);
      expect((caught as Error).message).toBe("horizon blocked");
    }
  });
});
