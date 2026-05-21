import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";
import {
  computeBreakdownTotals,
  explainPayoutAccessError,
  formatPayoutNode,
  parsePayoutId,
  type RawPayoutNode,
} from "../lib/payoutHelpers.js";
import { fetchBalanceTransactions } from "../lib/balanceTransactionsLoader.js";

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
  auto_paginate: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), walk balance_transactions pages until either hasNextPage=false or `max_transactions` is hit. " +
        "Set false to fetch a single page only (PR #2 behavior) and page manually via `transactions_after`.",
    ),
  transactions_limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .default(250)
    .describe(
      "Per-page size for balance_transactions (Shopify caps at 250). Page size only — use `max_transactions` to control the total.",
    ),
  max_transactions: z
    .number()
    .int()
    .min(1)
    .max(10000)
    .default(2500)
    .describe(
      "Hard cap on total balance_transactions collected across all auto-paginated pages. Default 2500 covers most real-world payouts; raise for unusually busy payouts. " +
        "When the cap is hit before Shopify returns hasNextPage=false, `reconciliation_status` is set to `partial` and `capped: true`.",
    ),
  transactions_after: z
    .string()
    .optional()
    .describe(
      "Cursor for forward pagination of balance_transactions (use the `end_cursor` from a prior call). " +
        "When provided, treated as the starting point — `auto_paginate=true` will continue from here.",
    ),
  include_order_names: z
    .boolean()
    .default(true)
    .describe(
      "If true (default), make one or more batched GraphQL `nodes(ids: [...])` calls to fill in `source_order.name` (e.g. \"#29876\") for each transaction. " +
        "Adds 1-N extra roundtrips (one per 250 distinct orders). Set false to skip for raw-id-only output.",
    ),
});

type GetShopifyPayoutInput = z.infer<typeof GetShopifyPayoutInputSchema>;

let shopifyClient: GraphQLClient;

const PAYOUT_NODE_QUERY = gql`
  #graphql

  query GetShopifyPayoutNode($payoutGid: ID!) {
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
  }
`;

const getShopifyPayout = {
  name: "shopify-get-payout",
  description:
    "Get full details for one Shopify Payments payout, including the per-order balance-transaction breakdown that the Shopify admin UI shows. " +
    "Auto-paginates balance_transactions by default (Shopify caps each page at 250; busy weekly payouts often exceed that once internal reserve movements are counted). " +
    "Returns reconciled totals (charges, refunds, adjustments, transfers, disputes, fee_refunds, other) plus plain-English `reconciliation_notes` explaining the result. " +
    "Requires the `read_shopify_payments_payouts` and `read_shopify_payments_accounts` Custom App scopes.",
  schema: GetShopifyPayoutInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetShopifyPayoutInput) => {
    try {
      const shopDomain = process.env.MYSHOPIFY_DOMAIN ?? "";
      const { gid, legacyId } = parsePayoutId(input.payout_id);

      let payoutData: { payoutNode: RawPayoutNode | null };
      try {
        payoutData = (await shopifyClient.request(PAYOUT_NODE_QUERY, {
          payoutGid: gid,
        })) as typeof payoutData;
      } catch (err) {
        throw explainPayoutAccessError(err);
      }

      if (!payoutData.payoutNode) {
        throw new Error(
          `Payout not found: ${gid}. Confirm the numeric id matches a payout on this store.`,
        );
      }

      const payout = formatPayoutNode(payoutData.payoutNode, shopDomain);

      if (!input.include_balance_transactions) {
        return {
          shop: { domain: shopDomain },
          payout,
          balance_transactions: null,
          totals: null,
        };
      }

      let loaderResult;
      try {
        loaderResult = await fetchBalanceTransactions(shopifyClient, {
          legacyPayoutId: legacyId,
          pageSize: input.transactions_limit,
          maxTransactions: input.max_transactions,
          startCursor: input.transactions_after,
          autoPaginate: input.auto_paginate,
          includeOrderNames: input.include_order_names,
        });
      } catch (err) {
        throw explainPayoutAccessError(err);
      }

      const totals = computeBreakdownTotals(loaderResult.transactions, payout.net, {
        truncated: loaderResult.truncated,
        capped: loaderResult.capped,
        fetched: loaderResult.transactions.length,
        max_transactions: loaderResult.capped ? input.max_transactions : undefined,
      });

      return {
        shop: { domain: shopDomain },
        payout,
        balance_transactions: loaderResult.transactions,
        balance_transactions_pageInfo: {
          hasNextPage: loaderResult.has_next_page,
          endCursor: loaderResult.end_cursor,
        },
        pagination: {
          auto_paginated: input.auto_paginate,
          pages_fetched: loaderResult.fetched_pages,
          transactions_fetched: loaderResult.transactions.length,
          truncated: loaderResult.truncated,
          capped: loaderResult.capped,
          max_transactions: input.max_transactions,
        },
        totals,
      };
    } catch (error) {
      handleToolError("fetch Shopify payout", error);
    }
  },
};

export { getShopifyPayout };
