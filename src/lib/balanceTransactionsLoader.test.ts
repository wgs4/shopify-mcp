import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import {
  fetchBalanceTransactions,
  type BalanceTransactionsAuth,
} from "./balanceTransactionsLoader.js";
import type { StoreContext } from "./toolUtils.js";
import { getShopifyPayout } from "../tools/getShopifyPayout.js";
import { listShopifyPayouts } from "../tools/listShopifyPayouts.js";

const envKeys = ["MYSHOPIFY_DOMAIN", "SHOPIFY_ACCESS_TOKEN", "SHOPIFY_API_VERSION"] as const;
const saved: Partial<Record<(typeof envKeys)[number], string | undefined>> = {};

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function poisonEnv() {
  for (const key of envKeys) saved[key] = process.env[key];
  process.env.MYSHOPIFY_DOMAIN = "env-store.myshopify.com";
  process.env.SHOPIFY_ACCESS_TOKEN = "env-token";
  process.env.SHOPIFY_API_VERSION = "1999-01";
}

function restTxn(payoutId: number) {
  return {
    id: 1,
    type: "charge",
    test: false,
    payout_id: payoutId,
    payout_status: "paid",
    currency: "USD",
    amount: "10.00",
    fee: "0.50",
    net: "9.50",
    source_id: 1,
    source_type: "charge",
    source_order_id: null,
    source_order_transaction_id: null,
    processed_at: "2026-01-02T00:00:00Z",
    adjustment_order_transactions: null,
    adjustment_reason: null,
  };
}

describe("fetchBalanceTransactions auth", () => {
  test("uses the selected store domain, api version, and a live token on every page", async () => {
    poisonEnv();
    const urls: string[] = [];
    const tokens: string[] = [];
    let page = 0;
    jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      urls.push(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      tokens.push(headers["X-Shopify-Access-Token"]);
      page += 1;
      const link =
        page === 1
          ? '<https://wgs-test.myshopify.com/admin/api/2026-01/shopify_payments/balance/transactions.json?page_info=cursor-2&limit=1>; rel="next"'
          : null;
      return new Response(JSON.stringify({ transactions: [restTxn(55)] }), {
        status: 200,
        headers: link ? { Link: link } : {},
      });
    });

    let n = 0;
    const auth: BalanceTransactionsAuth = {
      domain: "wgs-test.myshopify.com",
      apiVersion: "2026-01",
      getAccessToken: () => `live-${++n}`,
    };
    const result = await fetchBalanceTransactions(
      {} as GraphQLClient,
      {
        legacyPayoutId: "55",
        pageSize: 1,
        maxTransactions: 10,
        autoPaginate: true,
        includeOrderNames: false,
      },
      auth,
    );

    expect(result.transactions).toHaveLength(2);
    expect(urls[0]).toContain(
      "https://wgs-test.myshopify.com/admin/api/2026-01/shopify_payments/balance/transactions.json",
    );
    expect(urls[0]).not.toContain("env-store.myshopify.com");
    expect(urls[0]).not.toContain("1999-01");
    expect(tokens).toEqual(["live-1", "live-2"]);
    expect(tokens).not.toContain("env-token");
  });
});

describe("payout tools use the selected store", () => {
  test("list payouts reports ctx.domain when env points somewhere else", async () => {
    poisonEnv();
    const request = jest.fn(async () => ({ shopifyPaymentsAccount: null }));
    const ctx: StoreContext = {
      client: { request } as unknown as GraphQLClient,
      domain: "fortin-test.myshopify.com",
      storeKey: "fortin",
      getAccessToken: () => "live-token",
      apiVersion: "2026-01",
    };
    const result = (await listShopifyPayouts.execute(
      { since: "2026-01-01", until: "2026-01-31", limit: 10 },
      ctx,
    )) as { shop: { domain: string } };
    expect(result.shop.domain).toBe("fortin-test.myshopify.com");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("get payout balance fetch uses ctx domain and the live token", async () => {
    poisonEnv();
    const money = { amount: "10.00", currencyCode: "USD" };
    const summary = {
      adjustmentsFee: money,
      adjustmentsGross: money,
      advanceFees: money,
      advanceGross: money,
      chargesFee: money,
      chargesGross: money,
      refundsFee: money,
      refundsFeeGross: money,
      reservedFundsFee: money,
      reservedFundsGross: money,
      retriedPayoutsFee: money,
      retriedPayoutsGross: money,
    };
    const request = jest.fn(async () => ({
      payoutNode: {
        id: "gid://shopify/ShopifyPaymentsPayout/123",
        legacyResourceId: "123",
        issuedAt: "2026-01-02T00:00:00Z",
        status: "PAID",
        net: money,
        summary,
      },
    }));
    const urls: string[] = [];
    const tokens: string[] = [];
    jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      urls.push(String(input));
      const headers = (init?.headers ?? {}) as Record<string, string>;
      tokens.push(headers["X-Shopify-Access-Token"]);
      return new Response(JSON.stringify({ transactions: [restTxn(123)] }), { status: 200 });
    });
    const ctx: StoreContext = {
      client: { request } as unknown as GraphQLClient,
      domain: "wgs-test.myshopify.com",
      storeKey: "wgs",
      getAccessToken: () => "live-from-auth",
      apiVersion: "2026-01",
    };

    const result = (await getShopifyPayout.execute(
      {
        payout_id: "123",
        include_balance_transactions: true,
        auto_paginate: false,
        transactions_limit: 10,
        max_transactions: 10,
        include_order_names: false,
      },
      ctx,
    )) as { shop: { domain: string }; payout: { admin_url: string } };

    expect(result.shop.domain).toBe("wgs-test.myshopify.com");
    expect(result.payout.admin_url).toBe(
      "https://wgs-test.myshopify.com/admin/payments/payouts/123",
    );
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(
      "https://wgs-test.myshopify.com/admin/api/2026-01/shopify_payments/balance/transactions.json",
    );
    expect(urls[0]).toContain("payout_id=123");
    expect(tokens).toEqual(["live-from-auth"]);
  });
});
