import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, type ShopifyConnection } from "../lib/toolUtils.js";
import {
  buildPayoutListQuery,
  explainPayoutAccessError,
  formatPayoutNode,
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

const ListShopifyPayoutsInputSchema = z.object({
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "since must be YYYY-MM-DD")
    .describe("Inclusive lower bound on payout issued_at (YYYY-MM-DD)"),
  until: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "until must be YYYY-MM-DD")
    .describe("Inclusive upper bound on payout issued_at (YYYY-MM-DD)"),
  status: z
    .enum(PAYOUT_STATUSES)
    .optional()
    .describe(
      "Optional payout status filter. Most reconciliation work uses status=paid.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(250)
    .default(50)
    .describe("Max payouts per page (Shopify caps at 250)"),
  after: z
    .string()
    .optional()
    .describe("Cursor for forward pagination (pageInfo.endCursor)"),
});

type ListShopifyPayoutsInput = z.infer<typeof ListShopifyPayoutsInputSchema>;

let shopifyClient: GraphQLClient;

const listShopifyPayouts = {
  name: "shopify-list-payouts",
  description:
    "List Shopify Payments payouts for this store in a date window. Returns each payout's id, issued_at, status, net amount, summary (charges/refunds/fees), currency, and the admin URL for the payout page. Requires the `read_shopify_payments_payouts` Custom App scope.",
  schema: ListShopifyPayoutsInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: ListShopifyPayoutsInput) => {
    try {
      const shopDomain = process.env.MYSHOPIFY_DOMAIN ?? "";
      const queryStr = buildPayoutListQuery({
        since: input.since,
        until: input.until,
        status: input.status,
      });

      const query = gql`
        #graphql

        query ListShopifyPayouts(
          $first: Int!
          $query: String
          $after: String
        ) {
          shopifyPaymentsAccount {
            payouts(first: $first, query: $query, after: $after) {
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
                hasPreviousPage
                startCursor
                endCursor
              }
            }
          }
        }
      `;

      const variables = {
        first: input.limit,
        ...(queryStr ? { query: queryStr } : {}),
        ...(input.after ? { after: input.after } : {}),
      };

      let data: {
        shopifyPaymentsAccount: {
          payouts: ShopifyConnection<RawPayoutNode>;
        } | null;
      };
      try {
        data = (await shopifyClient.request(query, variables)) as typeof data;
      } catch (err) {
        throw explainPayoutAccessError(err);
      }

      if (!data.shopifyPaymentsAccount) {
        return {
          shop: { domain: shopDomain },
          payouts: [],
          pageInfo: null,
          count: 0,
          warning:
            "shopifyPaymentsAccount returned null — Shopify Payments may not be enabled on this store.",
        };
      }

      const conn = data.shopifyPaymentsAccount.payouts;
      const payouts = conn.edges.map((edge) =>
        formatPayoutNode(edge.node, shopDomain),
      );

      return {
        shop: { domain: shopDomain },
        payouts,
        pageInfo: conn.pageInfo ?? null,
        count: payouts.length,
      };
    } catch (error) {
      handleToolError("list Shopify payouts", error);
    }
  },
};

export { listShopifyPayouts };
