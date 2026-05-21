import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, type ShopifyConnection } from "../lib/toolUtils.js";
import {
  buildPayoutListQuery,
  computeBreakdownTotals,
  explainPayoutAccessError,
  formatPayoutNode,
  type NormalizedBalanceTxn,
  type NormalizedPayout,
  type RawPayoutNode,
} from "../lib/payoutHelpers.js";
import { fetchBalanceTransactions } from "../lib/balanceTransactionsLoader.js";

const PAYOUT_STATUSES = [
  "paid",
  "scheduled",
  "pending",
  "in_transit",
  "canceled",
  "failed",
] as const;

const ShopifyPayoutAutoReconcileInputSchema = z.object({
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD")
    .describe("Inclusive lower bound on payout issued_at (YYYY-MM-DD)"),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD")
    .optional()
    .describe(
      "Inclusive upper bound on payout issued_at (YYYY-MM-DD). Defaults to today (UTC).",
    ),
  status: z
    .enum(PAYOUT_STATUSES)
    .default("paid")
    .describe(
      "Payout status filter. Defaults to 'paid' — the only status that should be booked in xTuple.",
    ),
  include_breakdowns: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), fetch each payout's full balanceTransactions breakdown inline. " +
        "Set false for a cheap status-only sweep.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .default(50)
    .describe("Max payouts to return (Shopify connection page cap is 250)"),
  auto_paginate_transactions: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), each payout's breakdown walks all balance_transactions pages until exhausted or `max_transactions_per_payout` is hit. " +
        "Set false to fetch a single page per payout (PR #2 behavior).",
    ),
  transactions_limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .default(250)
    .describe(
      "Per-page size for each payout's balance_transactions (Shopify caps at 250). Page size only.",
    ),
  max_transactions_per_payout: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(2500)
    .describe(
      "Hard cap on total balance_transactions collected per payout. When a payout hits the cap, its `reconciliation_status` is set to `partial`.",
    ),
  include_order_names: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), enrich each transaction's `source_order.name` (e.g. \"#29876\") via batched GraphQL `nodes(ids: [...])` calls. " +
        "Set false to skip — useful for cheap status-only sweeps where display names aren't needed.",
    ),
  max_transactions_total: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .default(25000)
    .describe(
      "Global cap on the SUM of balance_transactions across all payouts in this sweep response. " +
        "Once exceeded, subsequent payouts are returned without breakdowns and `truncated.global_cap_hit` is set. " +
        "Protects against worst-case `limit * max_transactions_per_payout` cross-product blowups.",
    ),
});

type ShopifyPayoutAutoReconcileInput = z.infer<
  typeof ShopifyPayoutAutoReconcileInputSchema
>;

let shopifyClient: GraphQLClient;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

const PAYOUTS_QUERY = gql`
  #graphql

  query SweepPayouts($first: Int!, $query: String) {
    shopifyPaymentsAccount {
      payouts(first: $first, query: $query) {
        edges {
          node {
            id
            legacyResourceId
            issuedAt
            status
            net {
              amount
              currencyCode
            }
            summary {
              chargesGross {
                amount
                currencyCode
              }
              chargesFee {
                amount
                currencyCode
              }
              refundsFee {
                amount
                currencyCode
              }
              refundsFeeGross {
                amount
                currencyCode
              }
              adjustmentsGross {
                amount
                currencyCode
              }
              adjustmentsFee {
                amount
                currencyCode
              }
              reservedFundsGross {
                amount
                currencyCode
              }
              reservedFundsFee {
                amount
                currencyCode
              }
              retriedPayoutsGross {
                amount
                currencyCode
              }
              retriedPayoutsFee {
                amount
                currencyCode
              }
              advanceGross {
                amount
                currencyCode
              }
              advanceFees {
                amount
                currencyCode
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

const shopifyPayoutAutoReconcile = {
  name: "shopify-payout-auto-reconcile",
  description:
    "Sweep Shopify Payments payouts in a date window and return each one with its full per-order breakdown attached. Designed to drive bank reconciliation: the caller (LLM or another MCP) takes each payout's net + admin_url + breakdown and matches them against bank-side records or xTuple cashrcpts. This tool itself never writes to xTuple — it is read-only on the Shopify side. " +
    "Per-payout breakdowns auto-paginate balance_transactions by default (Shopify caps each page at 250). Each payout entry includes its own `reconciliation_notes` and `reconciliation_status` (reconciled | unreconciled | partial). " +
    "Single-page payout list: a single response covers at most `limit` payouts (max 250). The response includes a `truncated.payouts` flag when more payouts exist; for larger windows, narrow the date range or call `shopify-list-payouts` + `shopify-get-payout` in a paged loop. " +
    "Requires the `read_shopify_payments_payouts` and `read_shopify_payments_accounts` Custom App scopes.",
  schema: ShopifyPayoutAutoReconcileInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: ShopifyPayoutAutoReconcileInput) => {
    try {
      const shopDomain = process.env.MYSHOPIFY_DOMAIN ?? "";
      const until = input.until ?? todayIsoDate();
      const queryStr = buildPayoutListQuery({
        since: input.since,
        until,
        status: input.status,
      });

      let payoutsData: {
        shopifyPaymentsAccount: {
          payouts: ShopifyConnection<RawPayoutNode>;
        } | null;
      };
      try {
        payoutsData = (await shopifyClient.request(PAYOUTS_QUERY, {
          first: input.limit,
          ...(queryStr ? { query: queryStr } : {}),
        })) as typeof payoutsData;
      } catch (err) {
        throw explainPayoutAccessError(err);
      }

      if (!payoutsData.shopifyPaymentsAccount) {
        return {
          shop: { domain: shopDomain },
          window: { since: input.since, until, status: input.status },
          payouts: [],
          count: 0,
          totals: {
            paid_count: 0,
            paid_net_total: 0,
            non_paid_count: 0,
            currencies: [] as string[],
          },
          warning:
            "shopifyPaymentsAccount returned null — Shopify Payments may not be enabled on this store.",
        };
      }

      const conn = payoutsData.shopifyPaymentsAccount.payouts;
      const normalizedPayouts: NormalizedPayout[] = conn.edges.map((edge) =>
        formatPayoutNode(edge.node, shopDomain),
      );

      type Breakdown = {
        balance_transactions: NormalizedBalanceTxn[];
        totals: ReturnType<typeof computeBreakdownTotals>;
        // Back-compat aliases at the breakdown level (matches PR #2 shape).
        truncated: boolean;
        capped: boolean;
        pagination: {
          auto_paginated: boolean;
          pages_fetched: number;
          transactions_fetched: number;
          truncated: boolean;
          capped: boolean;
          max_transactions: number;
          end_cursor: string | null;
          has_next_page: boolean;
        };
      };
      const entries: Array<{
        payout: NormalizedPayout;
        breakdown: Breakdown | null;
      }> = [];

      let paidCount = 0;
      let nonPaidCount = 0;
      let anyBreakdownTruncated = false;
      let anyBreakdownCapped = false;
      let globalCapHit = false;
      let totalTransactionsFetched = 0;
      const paidNetByCurrency: Record<string, number> = {};
      const currencies = new Set<string>();

      for (const payout of normalizedPayouts) {
        currencies.add(payout.currency);
        if (payout.status === "paid") {
          paidCount += 1;
          paidNetByCurrency[payout.currency] =
            (paidNetByCurrency[payout.currency] ?? 0) + payout.net;
        } else {
          nonPaidCount += 1;
        }

        let breakdown: Breakdown | null = null;

        if (input.include_breakdowns) {
          if (totalTransactionsFetched >= input.max_transactions_total) {
            globalCapHit = true;
            // Skip breakdown entirely — payout entry still listed for status.
          } else {
            const remainingGlobal =
              input.max_transactions_total - totalTransactionsFetched;
            const effectivePerPayoutCap = Math.min(
              input.max_transactions_per_payout,
              remainingGlobal,
            );

            let loaderResult;
            try {
              loaderResult = await fetchBalanceTransactions(shopifyClient, {
                legacyPayoutId: payout.legacy_resource_id,
                pageSize: input.transactions_limit,
                maxTransactions: effectivePerPayoutCap,
                autoPaginate: input.auto_paginate_transactions,
                includeOrderNames: input.include_order_names,
              });
            } catch (err) {
              throw explainPayoutAccessError(err);
            }

            totalTransactionsFetched += loaderResult.transactions.length;
            if (loaderResult.truncated) anyBreakdownTruncated = true;
            if (loaderResult.capped) anyBreakdownCapped = true;

            const totals = computeBreakdownTotals(
              loaderResult.transactions,
              payout.net,
              {
                truncated: loaderResult.truncated,
                capped: loaderResult.capped,
                fetched: loaderResult.transactions.length,
                max_transactions: loaderResult.capped
                  ? effectivePerPayoutCap
                  : undefined,
              },
            );

            breakdown = {
              balance_transactions: loaderResult.transactions,
              totals,
              // Back-compat aliases at the breakdown level for callers typed
              // against PR #2's response shape.
              truncated: loaderResult.truncated,
              capped: loaderResult.capped,
              pagination: {
                auto_paginated: input.auto_paginate_transactions,
                pages_fetched: loaderResult.fetched_pages,
                transactions_fetched: loaderResult.transactions.length,
                truncated: loaderResult.truncated,
                capped: loaderResult.capped,
                max_transactions: effectivePerPayoutCap,
                end_cursor: loaderResult.end_cursor,
                has_next_page: loaderResult.has_next_page,
              },
            };
          }
        }

        entries.push({ payout, breakdown });
      }

      const payoutsTruncated = Boolean(conn.pageInfo?.hasNextPage);

      const roundedPaidNetByCurrency: Record<string, number> = {};
      for (const [cur, amt] of Object.entries(paidNetByCurrency)) {
        roundedPaidNetByCurrency[cur] = Math.round(amt * 100) / 100;
      }

      return {
        shop: { domain: shopDomain },
        window: { since: input.since, until, status: input.status },
        payouts: entries,
        count: entries.length,
        pageInfo: conn.pageInfo ?? null,
        truncated: {
          payouts: payoutsTruncated,
          any_breakdown: anyBreakdownTruncated,
          any_breakdown_capped: anyBreakdownCapped,
          global_cap_hit: globalCapHit,
        },
        totals: {
          paid_count: paidCount,
          paid_net_by_currency: roundedPaidNetByCurrency,
          non_paid_count: nonPaidCount,
          currencies: Array.from(currencies),
        },
      };
    } catch (error) {
      handleToolError("auto-reconcile Shopify payouts", error);
    }
  },
};

export { shopifyPayoutAutoReconcile };
