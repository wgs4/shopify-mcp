import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, type ShopifyConnection } from "../lib/toolUtils.js";
import {
  buildPayoutListQuery,
  computeBreakdownTotals,
  explainPayoutAccessError,
  formatBalanceTxnNode,
  formatPayoutNode,
  type NormalizedPayout,
  type RawBalanceTxnNode,
  type RawPayoutNode,
} from "../lib/payoutHelpers.js";

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
  transactions_limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .default(250)
    .describe(
      "Max balance transactions per payout when include_breakdowns=true (Shopify caps at 250)",
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

const BALANCE_TXN_QUERY = gql`
  #graphql

  query SweepPayoutBalanceTxns($first: Int!, $query: String!) {
    shopifyPaymentsAccount {
      balanceTransactions(first: $first, query: $query) {
        edges {
          node {
            id
            type
            amount {
              amount
              currencyCode
            }
            fee {
              amount
              currencyCode
            }
            net {
              amount
              currencyCode
            }
            transactionDate
            sourceId
            sourceType
            sourceOrderTransactionId
            associatedOrder {
              id
              name
            }
            adjustmentReason
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
    "Single-page fetch only: a single response covers at most `limit` payouts (max 250) and `transactions_limit` balance transactions per payout (max 250). The response includes a `truncated` block flagging when more pages exist; for larger windows, narrow the date range or call `shopify-list-payouts` + `shopify-get-payout` in a paged loop. " +
    "Requires the `read_shopify_payments_payouts` Custom App scope.",
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

      type PayoutEntry = {
        payout: NormalizedPayout;
        breakdown:
          | {
              balance_transactions: ReturnType<typeof formatBalanceTxnNode>[];
              totals: ReturnType<typeof computeBreakdownTotals>;
              truncated: boolean;
            }
          | null;
      };

      const entries: PayoutEntry[] = [];
      let paidCount = 0;
      let nonPaidCount = 0;
      let anyBreakdownTruncated = false;
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

        let breakdown: PayoutEntry["breakdown"] = null;

        if (input.include_breakdowns) {
          let txnData: {
            shopifyPaymentsAccount: {
              balanceTransactions: ShopifyConnection<RawBalanceTxnNode>;
            } | null;
          };
          try {
            txnData = (await shopifyClient.request(BALANCE_TXN_QUERY, {
              first: input.transactions_limit,
              query: `payout_id:${payout.legacy_resource_id}`,
            })) as typeof txnData;
          } catch (err) {
            throw explainPayoutAccessError(err);
          }

          const txns =
            txnData.shopifyPaymentsAccount?.balanceTransactions.edges.map(
              (edge) => formatBalanceTxnNode(edge.node),
            ) ?? [];
          const totals = computeBreakdownTotals(txns, payout.net);
          const truncated = Boolean(
            txnData.shopifyPaymentsAccount?.balanceTransactions.pageInfo
              ?.hasNextPage,
          );
          if (truncated) anyBreakdownTruncated = true;
          breakdown = {
            balance_transactions: txns,
            totals,
            truncated,
          };
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
