import { gql } from "graphql-request";
import { z } from "zod";
import { getAccessScopes } from "../lib/accessScopes.js";
import { formatOrderSummary } from "../lib/formatters.js";
import {
  getOldestVisibleOrderCreatedAt,
  getShopTimezone,
} from "../lib/orderHistoryFetch.js";
import { horizonInfo } from "../lib/orderWall.js";
import { handleToolError, edgesToNodes, type ShopifyConnection, type StoreContext } from "../lib/toolUtils.js";

// Input schema for getting customer orders
const GetCustomerOrdersInputSchema = z.object({
  customerId: z.string().regex(/^\d+$/, "Customer ID must be numeric"),
  limit: z.number().default(10),
  after: z.string().optional().describe("Cursor for forward pagination"),
  before: z.string().optional().describe("Cursor for backward pagination"),
  sortKey: z.enum([
    "CREATED_AT", "ORDER_NUMBER", "TOTAL_PRICE", "FINANCIAL_STATUS",
    "FULFILLMENT_STATUS", "UPDATED_AT", "CUSTOMER_NAME", "PROCESSED_AT",
    "ID", "RELEVANCE"
  ]).optional().describe("Sort key for orders"),
  reverse: z.boolean().optional().describe("Reverse the sort order")
});

type GetCustomerOrdersInput = z.infer<typeof GetCustomerOrdersInputSchema>;

const getCustomerOrders = {
  name: "get-customer-orders",
  description: "Get orders for a specific customer",
  schema: GetCustomerOrdersInputSchema,

  execute: async (input: GetCustomerOrdersInput, ctx: StoreContext) => {
    try {
      const { customerId, limit, after, before, sortKey, reverse } = input;

      const scopes = await getAccessScopes(ctx.client);
      const tz = await getShopTimezone(ctx.client);
      const horizon = horizonInfo(scopes, undefined, tz);
      horizon.oldest_visible_order_created_at =
        await getOldestVisibleOrderCreatedAt(ctx.client);

      // Query to get orders for a specific customer
      const query = gql`
        #graphql

        query GetCustomerOrders($query: String!, $first: Int!, $after: String, $before: String, $sortKey: OrderSortKeys, $reverse: Boolean) {
          orders(query: $query, first: $first, after: $after, before: $before, sortKey: $sortKey, reverse: $reverse) {
            edges {
              node {
                id
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                subtotalPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                totalShippingPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                totalTaxSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                customer {
                  id
                  firstName
                  lastName
                  defaultEmailAddress {
                    emailAddress
                  }
                }
                lineItems(first: 5) {
                  edges {
                    node {
                      id
                      title
                      quantity
                      originalTotalSet {
                        shopMoney {
                          amount
                          currencyCode
                        }
                      }
                      variant {
                        id
                        title
                        sku
                      }
                    }
                  }
                }
                tags
                note
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
      `;

      // We use the query parameter to filter orders by customer ID
      const variables = {
        query: `customer_id:${customerId}`,
        first: limit,
        ...(after && { after }),
        ...(before && { before }),
        ...(sortKey && { sortKey }),
        ...(reverse !== undefined && { reverse })
      };

      const data = (await ctx.client.request(query, variables)) as {
        orders: ShopifyConnection<any>;
      };

      // Extract and format order data
      const orders = edgesToNodes(data.orders).map((order) =>
        formatOrderSummary(order, ctx.domain),
      );

      return {
        orders,
        pageInfo: data.orders.pageInfo,
        horizon,
      };
    } catch (error) {
      handleToolError("fetch customer orders", error);
    }
  }
};

export { getCustomerOrders };
