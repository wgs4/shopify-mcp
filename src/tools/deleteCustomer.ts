import { gql } from "graphql-request";
import { z } from "zod";
import { checkUserErrors, handleToolError, type StoreContext } from "../lib/toolUtils.js";

// Input schema for deleting a customer
const DeleteCustomerInputSchema = z.object({
  id: z.string().regex(/^\d+$/, "Customer ID must be numeric")
});

type DeleteCustomerInput = z.infer<typeof DeleteCustomerInputSchema>;

const deleteCustomer = {
  name: "delete-customer",
  description: "Delete a customer",
  schema: DeleteCustomerInputSchema,

  execute: async (input: DeleteCustomerInput, ctx: StoreContext) => {
    try {
      const { id } = input;

      // Convert numeric ID to GID format
      const customerGid = `gid://shopify/Customer/${id}`;

      const query = gql`
        #graphql

        mutation customerDelete($input: CustomerDeleteInput!) {
          customerDelete(input: $input) {
            deletedCustomerId
            userErrors {
              field
              message
            }
          }
        }
      `;

      const data = (await ctx.client.request(query, {
        input: { id: customerGid }
      })) as {
        customerDelete: {
          deletedCustomerId: string | null;
          userErrors: Array<{ field: string; message: string }>;
        };
      };

      checkUserErrors(data.customerDelete.userErrors, "delete customer");

      return { deletedCustomerId: data.customerDelete.deletedCustomerId };
    } catch (error) {
      handleToolError("delete customer", error);
    }
  }
};

export { deleteCustomer };
