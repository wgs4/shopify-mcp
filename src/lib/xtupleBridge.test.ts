import { afterEach, describe, expect, test } from "@jest/globals";

import { formatOrderSummary } from "./formatters.js";
import { deriveXtuplePoNumber, xtupleBridge } from "./xtupleBridge.js";

const saved = process.env.MYSHOPIFY_DOMAIN;

afterEach(() => {
  if (saved === undefined) delete process.env.MYSHOPIFY_DOMAIN;
  else process.env.MYSHOPIFY_DOMAIN = saved;
});

const MONEY = { shopMoney: { amount: "1.00", currencyCode: "USD" } };

describe("xtuple bridge domain", () => {
  test("uses the domain argument and ignores MYSHOPIFY_DOMAIN", () => {
    process.env.MYSHOPIFY_DOMAIN = "wgsusa.myshopify.com";
    expect(xtupleBridge("#28932", "fortinamps.myshopify.com")).toEqual({
      customer: "FORTIN",
      brand: "Fortin Amplification",
      poNumber: "F-28932",
    });
    expect(deriveXtuplePoNumber("#D359", "fortinamps.myshopify.com")).toBe("F-D-359");
    expect(xtupleBridge("#28932")).toBeNull();
    expect(deriveXtuplePoNumber("#28932")).toBeNull();
  });

  test("formatOrderSummary stamps the domain it was given", () => {
    process.env.MYSHOPIFY_DOMAIN = "wgsusa.myshopify.com";
    const summary = formatOrderSummary(
      {
        id: "gid://shopify/Order/1",
        name: "#28932",
        createdAt: "2026-01-01T00:00:00Z",
        displayFinancialStatus: "PAID",
        displayFulfillmentStatus: "FULFILLED",
        totalPriceSet: MONEY,
        subtotalPriceSet: MONEY,
        totalShippingPriceSet: MONEY,
        totalTaxSet: MONEY,
        customer: null,
        shippingAddress: null,
        lineItems: { edges: [] },
        tags: [],
        note: null,
      },
      "allpedal.myshopify.com",
    );
    expect(summary.xtuple).toEqual({
      customer: "INTERNET-AP",
      brand: "All-Pedal",
      poNumber: "AP-28932",
    });
  });
});
