import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError, type StoreContext } from "../lib/toolUtils.js";

// Input schema for deleteProduct
const DeleteProductInputSchema = z.object({
  id: z.string().min(1).describe("Shopify product GID, e.g. gid://shopify/Product/123"),
});

type DeleteProductInput = z.infer<typeof DeleteProductInputSchema>;

const deleteProduct = {
  name: "delete-product",
  description: "Delete a product",
  schema: DeleteProductInputSchema,

  execute: async (input: DeleteProductInput, ctx: StoreContext) => {
    try {
      const query = gql`
        #graphql

        mutation productDelete($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors {
              field
              message
            }
          }
        }
      `;

      const data = (await ctx.client.request(query, {
        input: { id: input.id },
      })) as {
        productDelete: {
          deletedProductId: string | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      };

      checkUserErrors(data.productDelete.userErrors, "delete product");

      return { deletedProductId: data.productDelete.deletedProductId };
    } catch (error) {
      handleToolError("delete product", error);
    }
  },
};

export { deleteProduct };
