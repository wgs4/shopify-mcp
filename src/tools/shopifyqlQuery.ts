import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError } from "../lib/toolUtils.js";

const ShopifyqlQueryInputSchema = z.object({
  query: z
    .string()
    .describe(
      'A ShopifyQL query string. Must include FROM (data source) and SHOW (metrics/dimensions). Example: FROM sales SHOW total_sales, gross_sales, discounts, net_sales GROUP BY day SINCE 2026-02-01 UNTIL 2026-02-28 ORDER BY day',
    ),
});

type ShopifyqlQueryInput = z.infer<typeof ShopifyqlQueryInputSchema>;

let shopifyClient: GraphQLClient;

const shopifyqlQuery = {
  name: "shopifyql-query",
  description:
    "Execute a ShopifyQL analytics query against the store's reporting engine. Returns the same data shown in Shopify Admin dashboards and reports (Total Sales, Sales by Product, etc). Use for accurate financial reporting including gross sales, discounts, reversals, net sales, shipping, taxes, and total sales. Requires the read_reports access scope.",
  schema: ShopifyqlQueryInputSchema,

  initialize(client: GraphQLClient) {
    shopifyClient = client;
  },

  execute: async (input: ShopifyqlQueryInput) => {
    try {
      const query = gql`
        #graphql

        query ShopifyQLQuery($query: String!) {
          shopifyqlQuery(query: $query) {
            tableData {
              columns {
                name
                dataType
                displayName
              }
              rows
            }
            parseErrors
          }
        }
      `;

      const variables = { query: input.query };

      const data = (await shopifyClient.request(query, variables)) as {
        shopifyqlQuery: {
          tableData: {
            columns: Array<{
              name: string;
              dataType: string;
              displayName: string;
            }>;
            rows: Array<Record<string, string>>;
          } | null;
          parseErrors: string[] | null;
        };
      };

      const result = data.shopifyqlQuery;

      if (result.parseErrors && result.parseErrors.length > 0) {
        return {
          error: "ShopifyQL parse error",
          parseErrors: result.parseErrors,
        };
      }

      if (!result.tableData) {
        return {
          error: "No data returned",
          columns: [],
          rows: [],
          totalRows: 0,
        };
      }

      return {
        columns: result.tableData.columns,
        rows: result.tableData.rows,
        totalRows: result.tableData.rows.length,
      };
    } catch (error) {
      handleToolError("execute ShopifyQL query", error);
    }
  },
};

export { shopifyqlQuery };
