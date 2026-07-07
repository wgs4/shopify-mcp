import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

// Input schema for getDraftOrder
const GetDraftOrderInputSchema = z.object({
  draftOrder: z
    .string()
    .min(1)
    .describe(
      "Draft order name (e.g. 'D359'), bare number ('359'), or GID (gid://shopify/DraftOrder/123)",
    ),
});

type GetDraftOrderInput = z.infer<typeof GetDraftOrderInputSchema>;

// Will be initialized in index.ts
let shopifyClient: GraphQLClient;

interface DraftOrderRef {
  node: { id: string; name: string };
}

const getDraftOrder = {
  name: "get-draft-order",
  description:
    "Get a single draft order by name (e.g. D359), bare number, or GID — including line items with per-line quantities, SKU, unit price, status, note, and PO number. Fills the read gap left by create-/complete-draft-order.",
  schema: GetDraftOrderInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: GetDraftOrderInput) => {
    try {
      const trimmed = input.draftOrder.trim();
      let resolvedId: string;

      if (trimmed.startsWith("gid://")) {
        resolvedId = trimmed;
      } else {
        // Normalize to a draft-order name like "D359".
        let name = trimmed.replace(/^#/, "");
        if (/^\d+$/.test(name)) name = `D${name}`; // "359" -> "D359"
        name = name.toUpperCase(); // "d359" -> "D359"

        const findQuery = gql`
          #graphql

          query FindDraftOrderByName($query: String!) {
            draftOrders(first: 25, query: $query) {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        `;

        const runSearch = async (q: string): Promise<DraftOrderRef[]> => {
          const res = (await shopifyClient.request(findQuery, { query: q })) as {
            draftOrders: { edges: DraftOrderRef[] };
          };
          return res.draftOrders.edges;
        };

        // Prefer a name-scoped search, fall back to plain full-text.
        let edges = await runSearch(`name:${name}`);
        let exact = edges.find((e) => e.node.name === name);
        if (!exact) {
          edges = await runSearch(name);
          exact = edges.find((e) => e.node.name === name);
        }

        if (!exact) {
          const nearby = edges
            .map((e) => e.node.name)
            .slice(0, 10)
            .join(", ");
          throw new Error(
            `Draft order ${name} not found${nearby ? ` (nearby: ${nearby})` : ""}`,
          );
        }
        resolvedId = exact.node.id;
      }

      const query = gql`
        #graphql

        query GetDraftOrder($id: ID!) {
          draftOrder(id: $id) {
            id
            name
            status
            createdAt
            updatedAt
            completedAt
            invoiceUrl
            email
            note2
            poNumber
            taxExempt
            tags
            customer {
              id
              firstName
              lastName
              defaultEmailAddress {
                emailAddress
              }
            }
            order {
              id
              name
            }
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
            totalTaxSet {
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
            lineItems(first: 100) {
              edges {
                node {
                  id
                  name
                  title
                  variantTitle
                  sku
                  quantity
                  variant {
                    id
                    title
                    sku
                  }
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  discountedTotalSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      `;

      const data = (await shopifyClient.request(query, { id: resolvedId })) as {
        draftOrder: any;
      };

      if (!data.draftOrder) {
        throw new Error(`Draft order ${input.draftOrder} not found`);
      }

      const d = data.draftOrder;

      const lineItems = d.lineItems.edges.map((edge: any) => {
        const li = edge.node;
        return {
          id: li.id,
          name: li.name,
          title: li.title,
          variantTitle: li.variantTitle,
          sku: li.sku ?? li.variant?.sku ?? null,
          quantity: li.quantity,
          unitPrice: li.originalUnitPriceSet?.shopMoney ?? null,
          lineTotal: li.discountedTotalSet?.shopMoney ?? null,
          variant: li.variant
            ? { id: li.variant.id, title: li.variant.title, sku: li.variant.sku }
            : null,
        };
      });

      const totalQuantity = lineItems.reduce(
        (sum: number, li: { quantity: number }) => sum + li.quantity,
        0,
      );

      const draftOrder = {
        id: d.id,
        name: d.name,
        status: d.status,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        completedAt: d.completedAt,
        invoiceUrl: d.invoiceUrl,
        email: d.email,
        note: d.note2,
        poNumber: d.poNumber,
        taxExempt: d.taxExempt,
        tags: d.tags,
        customer: d.customer
          ? {
              id: d.customer.id,
              firstName: d.customer.firstName,
              lastName: d.customer.lastName,
              email: d.customer.defaultEmailAddress?.emailAddress ?? null,
            }
          : null,
        completedOrder: d.order ? { id: d.order.id, name: d.order.name } : null,
        totalPrice: d.totalPriceSet?.shopMoney ?? null,
        subtotalPrice: d.subtotalPriceSet?.shopMoney ?? null,
        totalTax: d.totalTaxSet?.shopMoney ?? null,
        totalShippingPrice: d.totalShippingPriceSet?.shopMoney ?? null,
        lineItemCount: lineItems.length,
        totalQuantity,
        lineItems,
      };

      return { draftOrder };
    } catch (error) {
      handleToolError("fetch draft order", error);
    }
  },
};

export { getDraftOrder };
