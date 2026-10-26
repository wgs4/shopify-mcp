// SHOPIFY_MCP_DISABLED_TOOLS: hidden tools are never registered, and a
// misspelled name fails closed instead of leaving the tool exposed.

import { describe, expect, test } from "@jest/globals";

import { disabledToolNames, withoutDisabledTools } from "./registerTools.js";
import { tools } from "../tools/registry.js";

const MONEY_TOOLS = [
  "refund-create",
  "order-cancel",
  "order-mark-as-paid",
  "complete-draft-order",
];

describe("disabledToolNames", () => {
  test("unset or blank env disables nothing", () => {
    expect(disabledToolNames({}).size).toBe(0);
    expect(disabledToolNames({ SHOPIFY_MCP_DISABLED_TOOLS: " , " }).size).toBe(0);
  });

  test("comma list is trimmed", () => {
    const names = disabledToolNames({
      SHOPIFY_MCP_DISABLED_TOOLS: " refund-create,order-cancel ,, order-mark-as-paid",
    });
    expect([...names].sort()).toEqual(["order-cancel", "order-mark-as-paid", "refund-create"]);
  });
});

describe("withoutDisabledTools", () => {
  test("every money tool exists in the registry", () => {
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of MONEY_TOOLS) {
      expect(names.has(name)).toBe(true);
    }
  });

  test("hides exactly the listed tools", () => {
    const kept = withoutDisabledTools(tools, new Set(MONEY_TOOLS));
    const keptNames = kept.map((tool) => tool.name);
    for (const name of MONEY_TOOLS) {
      expect(keptNames).not.toContain(name);
    }
    expect(keptNames).toContain("update-order");
    expect(kept.length).toBe(tools.length - MONEY_TOOLS.length);
  });

  test("nothing disabled keeps every tool", () => {
    expect(withoutDisabledTools(tools, new Set()).length).toBe(tools.length);
  });

  test("a misspelled name throws instead of exposing the tool", () => {
    expect(() =>
      withoutDisabledTools(tools, new Set(["refund-create", "refund-creat"])),
    ).toThrow(/unknown tools: refund-creat$/);
  });
});
