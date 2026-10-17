import { gql } from "graphql-request";
import { z } from "zod";
import { edgesToNodes, handleToolError, type StoreContext } from "../lib/toolUtils.js";

const GetCollectionByIdInputSchema = z.object({
  collectionId: z
    .string()
    .min(1)
    .describe(
      "The collection ID (e.g. gid://shopify/Collection/123 or just 123)",
    ),
  productsFirst: z
    .number()
    .min(0)
    .max(100)
    .default(25)
    .optional()
    .describe(
      "Number of products to include (default 25, max 100, 0 to skip products)",
    ),
});
type GetCollectionByIdInput = z.infer<typeof GetCollectionByIdInputSchema>;

const getCollectionById = {
  name: "get-collection-by-id",
  description:
    "Get a single collection with full details including products (paginated), rules for smart collections, SEO, and image",
  schema: GetCollectionByIdInputSchema,

  execute: async (input: GetCollectionByIdInput, ctx: StoreContext) => {
    try {
      const collectionId = input.collectionId.startsWith("gid://")
        ? input.collectionId
        : `gid://shopify/Collection/${input.collectionId}`;
      const productsFirst = input.productsFirst ?? 25;

      const query = gql`
        #graphql

        query GetCollectionById($id: ID!, $productsFirst: Int!) {
          collection(id: $id) {
            id
            title
            handle
            descriptionHtml
            sortOrder
            templateSuffix
            updatedAt
            productsCount {
              count
            }
            ruleSet {
              appliedDisjunctively
              rules {
                column
                relation
                condition
              }
            }
            image {
              url
              altText
              width
              height
            }
            seo {
              title
              description
            }
            products(first: $productsFirst) {
              edges {
                node {
                  id
                  title
                  handle
                  status
                  vendor
                  productType
                  totalInventory
                  featuredMedia {
                    preview {
                      image {
                        url
                        altText
                      }
                    }
                  }
                  priceRangeV2 {
                    minVariantPrice {
                      amount
                      currencyCode
                    }
                    maxVariantPrice {
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

      const data: any = await ctx.client.request(query, {
        id: collectionId,
        productsFirst,
      });

      if (!data.collection) {
        throw new Error(`Collection not found: ${collectionId}`);
      }

      const collection = {
        ...data.collection,
        products: {
          items: edgesToNodes(data.collection.products),
          pageInfo: data.collection.products.pageInfo,
        },
      };

      return { collection };
    } catch (error) {
      handleToolError("fetch collection", error);
    }
  },
};

export { getCollectionById };
