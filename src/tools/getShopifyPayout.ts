import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, type ShopifyConnection } from "../lib/toolUtils.js";
import {
  computeBreakdownTotals,
  explainPayoutAccessError,
  formatBalanceTxnNode,
  formatPayoutNode,
  parsePayoutId,
  type RawBalanceTxnNode,
  type RawPayoutNode,
} from "../lib/payoutHelpers.js";

const GetShopifyPayoutInputSchema = z.object({
  payout_id: z
    .union([z.string().min(1), z.number().int().positive()])
    .describe(
      "Numeric legacy id (e.g. 137809822064), GID, or string of either. Same lookup style as `get-order-by-id`.",
    ),
  include_balance_transactions: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), also fetch the per-order breakdown via balanceTransactions.",
    ),
  transactions_limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .default(250)
    .describe(
      "Max balance transactions to fetch in one page (Shopify caps at 250). " +
        "Most Shopify payouts have far fewer than 250 transactions; if your store does, page via `transactions_after`.",
    ),
  transactions_after: z
    .string()
    .optional()
    .describe(
      "Cursor for forward pagination of balance_transactions (use the `endCursor` from a prior call's `balance_transactions_pageInfo`). " +
        "Required when a previous response had `balance_transactions_pageInfo.hasNextPage: true`.",
    ),
});

type GetShopifyPayoutInput = z.infer<typeof GetShopifyPayoutInputSchema>;

let shopifyClient: GraphQLClient;

const getShopifyPayout = {
  name: "shopify-get-payout",
  description:
    "Get full details for one Shopify Payments payout, including the per-order balance-transaction breakdown that the Shopify admin UI shows. Returns reconciled totals (charges, refunds, fees, adjustments) so the caller can match against bank deposits. Requires the `read_shopify_payments_payouts` Custom App scope.",
  schema: GetShopifyPayoutInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetShopifyPayoutInput) => {
    try {
      const shopDomain = process.env.MYSHOPIFY_DOMAIN ?? "";
      const { gid, legacyId } = parsePayoutId(input.payout_id);

      const txnQuery = `payout_id:${legacyId}`;
      const includeBalances = input.include_balance_transactions;

      const query = gql`
        #graphql

        query GetShopifyPayout(
          $payoutGid: ID!
          $txnQuery: String!
          $first: Int!
          $includeBalances: Boolean!
          $after: String
        ) {
          payoutNode: node(id: $payoutGid) {
            ... on ShopifyPaymentsPayout {
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
          shopifyPaymentsAccount @include(if: $includeBalances) {
            balanceTransactions(first: $first, query: $txnQuery, after: $after) {
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
                hasPreviousPage
                startCursor
                endCursor
              }
            }
          }
        }
      `;

      const variables = {
        payoutGid: gid,
        txnQuery,
        first: input.transactions_limit,
        includeBalances,
        ...(input.transactions_after ? { after: input.transactions_after } : {}),
      };

      let data: {
        payoutNode: RawPayoutNode | null;
        shopifyPaymentsAccount?: {
          balanceTransactions: ShopifyConnection<RawBalanceTxnNode>;
        } | null;
      };
      try {
        data = (await shopifyClient.request(query, variables)) as typeof data;
      } catch (err) {
        throw explainPayoutAccessError(err);
      }

      if (!data.payoutNode) {
        throw new Error(
          `Payout not found: ${gid}. Confirm the numeric id matches a payout on this store.`,
        );
      }

      const payout = formatPayoutNode(data.payoutNode, shopDomain);

      if (!includeBalances) {
        return {
          shop: { domain: shopDomain },
          payout,
          balance_transactions: null,
          totals: null,
        };
      }

      const conn = data.shopifyPaymentsAccount?.balanceTransactions;
      const balance_transactions =
        conn?.edges.map((edge) => formatBalanceTxnNode(edge.node)) ?? [];
      const totals = computeBreakdownTotals(balance_transactions, payout.net);

      return {
        shop: { domain: shopDomain },
        payout,
        balance_transactions,
        balance_transactions_pageInfo: conn?.pageInfo ?? null,
        totals,
      };
    } catch (error) {
      handleToolError("fetch Shopify payout", error);
    }
  },
};

export { getShopifyPayout };
