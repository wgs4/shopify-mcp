import { gql } from "graphql-request";
import { z } from "zod";
import { getAccessScopes, hasScope, missingScopeError } from "../lib/accessScopes.js";
import {
  checkUserErrors,
  handleToolError,
  type ShopifyMoney,
  type ShopifyUserError,
  type StoreContext,
} from "../lib/toolUtils.js";

const OrderEditInputSchema = z.object({
  orderId: z.string().trim().regex(/^(gid:\/\/shopify\/Order\/)?\d+$/).optional()
    .describe("Order GID or numeric ID; use orderName for #30965 or 30965"),
  orderName: z.string().trim().min(1).optional().describe("Exact order name, e.g. #30965 or 30965"),
  add: z.array(z.object({
    variantId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/).optional(),
    sku: z.string().trim().min(1).optional(),
    quantity: z.number().int().positive().max(2147483647),
  }).refine((item) => (item.variantId !== undefined) !== (item.sku !== undefined), {
    message: "Provide exactly one of variantId or sku for each add",
  })).optional(),
  setQuantity: z.array(z.object({
    lineItemId: z.string().regex(/^gid:\/\/shopify\/LineItem\/\d+$/).optional(),
    sku: z.string().trim().min(1).optional(),
    quantity: z.number().int().nonnegative().max(2147483647),
  }).refine((item) => (item.lineItemId !== undefined) !== (item.sku !== undefined), {
    message: "Provide exactly one of lineItemId or sku for each setQuantity",
  })).optional(),
  restock: z.boolean().default(true).describe("Restock inventory when reducing or removing lines"),
  notifyCustomer: z.boolean().default(false).describe("Notify the customer only when committing"),
  staffNote: z.string().optional(),
  commit: z.boolean().default(false).describe("False stages a dry run; true commits the order edit"),
});

interface Connection<T> {
  edges: Array<{ node: T }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface Line {
  id: string;
  sku: string | null;
  title: string;
  variantTitle: string | null;
}

interface OrderLine extends Line {
  currentQuantity: number;
  unfulfilledQuantity: number;
}

interface CalculatedLine extends Line {
  quantity: number;
  editableQuantity: number;
  editableQuantityBeforeChanges: number;
}

type MoneyBag = { shopMoney: ShopifyMoney };

interface Order {
  id: string;
  name: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string;
  cancelledAt: string | null;
  closed: boolean;
  lineItems: Connection<OrderLine>;
  subtotal: MoneyBag | null;
  tax: MoneyBag;
  total: MoneyBag;
  totalOutstanding: MoneyBag;
}

interface CalculatedOrder {
  id: string;
  lineItems: Connection<CalculatedLine>;
  addedLineItems: Connection<CalculatedLine>;
  subtotal: MoneyBag | null;
  taxLines: Array<{ priceSet: MoneyBag }>;
  total: MoneyBag;
  totalOutstanding: MoneyBag;
}

const ORDER_LINE_FRAGMENT = gql`
  #graphql
  fragment OrderEditLine on LineItem {
    id sku title variantTitle currentQuantity unfulfilledQuantity
  }
`;

const ORDER_FRAGMENT = gql`
  #graphql
  fragment OrderEditOrder on Order {
    id name displayFinancialStatus displayFulfillmentStatus cancelledAt closed
    lineItems(first: 250) {
      edges { node { ...OrderEditLine } }
      pageInfo { hasNextPage endCursor }
    }
    subtotal: currentSubtotalPriceSet { shopMoney { amount currencyCode } }
    tax: currentTotalTaxSet { shopMoney { amount currencyCode } }
    total: currentTotalPriceSet { shopMoney { amount currencyCode } }
    totalOutstanding: totalOutstandingSet { shopMoney { amount currencyCode } }
  }
  ${ORDER_LINE_FRAGMENT}
`;

const CALCULATED_LINE_FRAGMENT = gql`
  #graphql
  fragment OrderEditCalculatedLine on CalculatedLineItem {
    id sku title variantTitle quantity editableQuantity editableQuantityBeforeChanges
  }
`;

const CALCULATED_FRAGMENT = gql`
  #graphql
  fragment OrderEditCalculatedOrder on CalculatedOrder {
    id
    lineItems(first: 250) {
      edges { node { ...OrderEditCalculatedLine } }
      pageInfo { hasNextPage endCursor }
    }
    addedLineItems(first: 250) {
      edges { node { ...OrderEditCalculatedLine } }
      pageInfo { hasNextPage endCursor }
    }
    subtotal: subtotalPriceSet { shopMoney { amount currencyCode } }
    taxLines { priceSet { shopMoney { amount currencyCode } } }
    total: totalPriceSet { shopMoney { amount currencyCode } }
    totalOutstanding: totalOutstandingSet { shopMoney { amount currencyCode } }
  }
  ${CALCULATED_LINE_FRAGMENT}
`;

async function allNodes<T>(
  connection: Connection<T>,
  next: (after: string) => Promise<Connection<T>>,
): Promise<T[]> {
  const nodes = connection.edges.map((edge) => edge.node);
  const seen = new Set<string>();
  while (connection.pageInfo.hasNextPage) {
    const cursor = connection.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) {
      throw new Error("Shopify returned an invalid pagination cursor; cannot safely edit an incomplete order");
    }
    seen.add(cursor);
    connection = await next(cursor);
    nodes.push(...connection.edges.map((edge) => edge.node));
  }
  return nodes;
}

function searchValue(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

async function resolveOrderId(input: z.infer<typeof OrderEditInputSchema>, ctx: StoreContext): Promise<string> {
  if (input.orderId) {
    return input.orderId.startsWith("gid://") ? input.orderId : `gid://shopify/Order/${input.orderId}`;
  }
  const name = input.orderName!.replace(/^#/, "");
  const query = gql`
    #graphql
    query OrderEditFindOrder($query: String!, $after: String) {
      orders(first: 250, query: $query, after: $after) {
        edges { node { id name } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const page = async (after?: string) => {
    const data = await ctx.client.request<{ orders: Connection<{ id: string; name: string }> }>(query, {
      query: `name:${searchValue(input.orderName!)}`, after,
    });
    return data.orders;
  };
  const matches = (await allNodes(await page(), page)).filter((order) => order.name.replace(/^#/, "") === name);
  if (matches.length !== 1) {
    throw new Error(`Order name ${input.orderName} must resolve to exactly one order; found ${matches.length}. Matches: ${JSON.stringify(matches)}. Older orders may require read_all_orders.`);
  }
  return matches[0].id;
}

async function resolveVariant(sku: string, ctx: StoreContext): Promise<string> {
  const query = gql`
    #graphql
    query OrderEditFindVariant($query: String!, $after: String) {
      productVariants(first: 250, query: $query, after: $after) {
        edges { node { id sku title } }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;
  const page = async (after?: string) => {
    const data = await ctx.client.request<{
      productVariants: Connection<{ id: string; sku: string | null; title: string }>;
    }>(query, { query: `sku:${searchValue(sku)}`, after });
    return data.productVariants;
  };
  const candidates = await allNodes(await page(), page);
  const matches = candidates.filter((variant) => variant.sku === sku);
  if (matches.length !== 1) {
    throw new Error(`SKU ${sku} must resolve to exactly one variant; found ${matches.length}. Matches: ${JSON.stringify(matches)}. Search candidates: ${JSON.stringify(candidates)}`);
  }
  return matches[0].id;
}

async function orderLines(order: Order, ctx: StoreContext): Promise<OrderLine[]> {
  return allNodes(order.lineItems, async (after) => {
    const data = await ctx.client.request<{ order: { lineItems: Connection<OrderLine> } | null }>(gql`
      #graphql
      query OrderEditOrderLines($id: ID!, $after: String!) {
        order(id: $id) {
          lineItems(first: 250, after: $after) {
            edges { node { ...OrderEditLine } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      ${ORDER_LINE_FRAGMENT}
    `, { id: order.id, after });
    if (!data.order) throw new Error("Order disappeared while reading its line items");
    return data.order.lineItems;
  });
}

async function calculatedLines(order: CalculatedOrder, ctx: StoreContext, added = false): Promise<CalculatedLine[]> {
  return allNodes(added ? order.addedLineItems : order.lineItems, async (after) => {
    const data = await ctx.client.request<{
      node: { lineItems?: Connection<CalculatedLine>; addedLineItems?: Connection<CalculatedLine> } | null;
    }>(gql`
      #graphql
      query OrderEditCalculatedLines($id: ID!, $after: String!, $added: Boolean!) {
        node(id: $id) {
          ... on CalculatedOrder {
            lineItems(first: 250, after: $after) @skip(if: $added) {
              edges { node { ...OrderEditCalculatedLine } }
              pageInfo { hasNextPage endCursor }
            }
            addedLineItems(first: 250, after: $after) @include(if: $added) {
              edges { node { ...OrderEditCalculatedLine } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      }
      ${CALCULATED_LINE_FRAGMENT}
    `, { id: order.id, after, added });
    const connection = added ? data.node?.addedLineItems : data.node?.lineItems;
    if (!connection) throw new Error("Order edit session disappeared while reading its line items");
    return connection;
  });
}

// CalculatedOrder exposes taxLines rather than totalTaxSet in API 2026-01.
// Sum the decimal strings exactly, including currencies with three decimal places.
function calculatedTax(order: CalculatedOrder): ShopifyMoney {
  const amounts = order.taxLines.map((line) => line.priceSet.shopMoney.amount);
  const scale = Math.max(2, ...amounts.map((amount) => amount.split(".")[1]?.length ?? 0));
  const total = amounts.reduce((sum, amount) => {
    const [whole, fraction = ""] = amount.split(".");
    return sum + BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  }, 0n);
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, "0");
  return {
    amount: `${total < 0n ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`,
    currencyCode: order.total.shopMoney.currencyCode,
  };
}

function orderTotals(order: Order) {
  return {
    subtotal: order.subtotal?.shopMoney ?? null,
    tax: order.tax.shopMoney,
    total: order.total.shopMoney,
    totalOutstanding: order.totalOutstanding.shopMoney,
  };
}

function lineSummary(line: Line, quantity: number) {
  return { id: line.id, sku: line.sku, title: line.title, variantTitle: line.variantTitle, quantity };
}

const orderEdit = {
  name: "order-edit",
  description: "Edit line items on a placed order: add variants, swap items, or set quantities (0 removes). Defaults to a fresh dry-run edit session; commit=true applies the changes. Requires write_order_edits. Refuses cancelled orders and quantity edits on fulfilled lines. Returns before/after lines, totals, and outstanding payment/refund warnings. Does not collect payment or issue refunds.",
  schema: OrderEditInputSchema,

  execute: async (rawInput: Record<string, unknown>, ctx: StoreContext) => {
    try {
      // Keep the top-level ZodObject intact: the MCP framework registers schema.shape.
      const input = OrderEditInputSchema.parse(rawInput);
      if ((input.orderId !== undefined) === (input.orderName !== undefined)) {
        throw new Error("Provide exactly one of orderId or orderName");
      }
      if (!input.add?.length && !input.setQuantity?.length) {
        throw new Error("At least one non-empty add or setQuantity is required");
      }
      if (!hasScope(await getAccessScopes(ctx.client), "write_order_edits")) {
        throw missingScopeError("order-edit (app is missing write_order_edits)", "write_order_edits");
      }

      const orderId = await resolveOrderId(input, ctx);
      const data = await ctx.client.request<{ order: Order | null }>(gql`
        #graphql
        query OrderEditReadOrder($id: ID!) {
          order(id: $id) { ...OrderEditOrder }
        }
        ${ORDER_FRAGMENT}
      `, { id: orderId });
      const order = data.order;
      if (!order) throw new Error(`Order ${orderId} not found; older orders may require read_all_orders`);
      if (order.cancelledAt) throw new Error(`Order ${order.name} is cancelled and cannot be edited`);
      const beforeLines = await orderLines(order, ctx);
      const touched = new Set<string>();
      const changes = (input.setQuantity ?? []).map((change) => {
        const matches = beforeLines.filter((line) => change.lineItemId
          ? line.id === change.lineItemId
          : line.sku === change.sku && line.currentQuantity > 0);
        if (matches.length !== 1) {
          throw new Error(`setQuantity ${change.lineItemId ?? change.sku} must match exactly one current line item; found ${matches.length}. Matches: ${JSON.stringify(matches)}`);
        }
        const line = matches[0];
        const fulfilled = line.currentQuantity - line.unfulfilledQuantity;
        if (fulfilled > 0) {
          throw new Error(`Line ${line.id} (${line.sku}) has fulfilled quantity ${fulfilled}; quantity edits on fulfilled lines are refused, including reductions below fulfilled quantity`);
        }
        if (touched.has(line.id)) throw new Error(`Duplicate setQuantity target ${line.id}`);
        touched.add(line.id);
        return { line, quantity: change.quantity };
      });
      const adds = [];
      for (const item of input.add ?? []) {
        adds.push({ variantId: item.variantId ?? await resolveVariant(item.sku!, ctx), quantity: item.quantity });
      }

      const begun = await ctx.client.request<{
        orderEditBegin: { calculatedOrder: CalculatedOrder | null; userErrors: ShopifyUserError[] };
      }>(gql`
        #graphql
        mutation OrderEditBegin($id: ID!) {
          orderEditBegin(id: $id) {
            calculatedOrder { ...OrderEditCalculatedOrder }
            userErrors { field message }
          }
        }
        ${CALCULATED_FRAGMENT}
      `, { id: orderId });
      checkUserErrors(begun.orderEditBegin.userErrors, "begin order edit");
      if (!begun.orderEditBegin.calculatedOrder) throw new Error("Shopify did not return a calculated order");
      let calculated = begun.orderEditBegin.calculatedOrder;
      const originals = await calculatedLines(calculated, ctx);
      const mappedChanges = changes.map(({ line, quantity }) => {
        // 2026-01 has no CalculatedLineItem.lineItem relation. Existing lines
        // retain the numeric ID under CalculatedLineItem; verify membership.
        const calculatedId = line.id.replace("gid://shopify/LineItem/", "gid://shopify/CalculatedLineItem/");
        const target = originals.find((item) => item.id === calculatedId);
        if (!target) throw new Error(`Cannot map original line ${line.id} to this order edit session`);
        if (target.quantity !== line.currentQuantity || target.editableQuantityBeforeChanges !== target.quantity) {
          throw new Error(`Line ${line.id} changed or has fulfilled units in the edit session; re-read the order before retrying`);
        }
        return { lineItemId: target.id, quantity };
      });

      for (const item of adds) {
        const result = await ctx.client.request<{
          orderEditAddVariant: { calculatedOrder: CalculatedOrder | null; userErrors: ShopifyUserError[] };
        }>(gql`
          #graphql
          mutation OrderEditAddVariant($id: ID!, $variantId: ID!, $quantity: Int!) {
            orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: false) {
              calculatedOrder { ...OrderEditCalculatedOrder }
              userErrors { field message }
            }
          }
          ${CALCULATED_FRAGMENT}
        `, { id: calculated.id, ...item });
        checkUserErrors(result.orderEditAddVariant.userErrors, "add order variant");
        if (!result.orderEditAddVariant.calculatedOrder) throw new Error("Shopify did not return the staged order after adding a variant");
        calculated = result.orderEditAddVariant.calculatedOrder;
      }
      for (const change of mappedChanges) {
        const result = await ctx.client.request<{
          orderEditSetQuantity: { calculatedOrder: CalculatedOrder | null; userErrors: ShopifyUserError[] };
        }>(gql`
          #graphql
          mutation OrderEditSetQuantity($id: ID!, $lineItemId: ID!, $quantity: Int!, $restock: Boolean!) {
            orderEditSetQuantity(id: $id, lineItemId: $lineItemId, quantity: $quantity, restock: $restock) {
              calculatedOrder { ...OrderEditCalculatedOrder }
              userErrors { field message }
            }
          }
          ${CALCULATED_FRAGMENT}
        `, { id: calculated.id, ...change, restock: input.restock });
        checkUserErrors(result.orderEditSetQuantity.userErrors, "set order line quantity");
        if (!result.orderEditSetQuantity.calculatedOrder) throw new Error("Shopify did not return the staged order after setting quantity");
        calculated = result.orderEditSetQuantity.calculatedOrder;
      }

      let afterLines = [
        ...await calculatedLines(calculated, ctx),
        ...await calculatedLines(calculated, ctx, true),
      ].map((line) => lineSummary(line, line.quantity));
      let afterTotals = {
        subtotal: calculated.subtotal?.shopMoney ?? null,
        tax: calculatedTax(calculated),
        total: calculated.total.shopMoney,
        totalOutstanding: calculated.totalOutstanding.shopMoney,
      };
      const warnings: string[] = [];
      let afterLinesComplete = true;
      let resultOrder = order;
      if (input.commit) {
        const committed = await ctx.client.request<{
          orderEditCommit: { order: Order | null; userErrors: ShopifyUserError[] };
        }>(gql`
          #graphql
          mutation OrderEditCommit($id: ID!, $notifyCustomer: Boolean!, $staffNote: String) {
            orderEditCommit(id: $id, notifyCustomer: $notifyCustomer, staffNote: $staffNote) {
              order { ...OrderEditOrder }
              userErrors { field message }
            }
          }
          ${ORDER_FRAGMENT}
        `, {
          id: calculated.id,
          notifyCustomer: input.notifyCustomer,
          ...(input.staffNote !== undefined && { staffNote: input.staffNote }),
        }).catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Commit result unknown for order ${order.name} (${order.id}). Read the order before retrying; the edit may already have been applied. ${message}`);
        });
        checkUserErrors(committed.orderEditCommit.userErrors, "commit order edit");
        if (!committed.orderEditCommit.order) throw new Error(`Commit result unknown: Shopify returned no order after commit. Read order ${order.id} before retrying; the edit may already have been applied.`);
        const updated = committed.orderEditCommit.order;
        resultOrder = updated;
        try {
          afterLines = (await orderLines(updated, ctx)).map((line) => lineSummary(line, line.currentQuantity));
        } catch (error) {
          afterLines = updated.lineItems.edges.map(({ node }) => lineSummary(node, node.currentQuantity));
          afterLinesComplete = false;
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`WARNING: Edit COMMITTED for order ${updated.name} (${updated.id}). Could not read all after-lines: ${message}. Re-read the order; do not repeat the edit.`);
        }
        afterTotals = orderTotals(updated);
      }

      const before = beforeLines.map((line) => lineSummary(line, line.currentQuantity));
      const originalId = (id: string) => id.replace("gid://shopify/CalculatedLineItem/", "gid://shopify/LineItem/");
      const lineTable = new Map(before.map((line) => [line.id, {
        id: line.id, sku: line.sku, title: line.title, variantTitle: line.variantTitle,
        beforeQuantity: line.quantity, afterQuantity: afterLinesComplete ? 0 : null,
      }]));
      for (const line of afterLines) {
        const id = originalId(line.id);
        const previous = lineTable.get(id);
        lineTable.set(id, {
          id, sku: line.sku, title: line.title, variantTitle: line.variantTitle,
          beforeQuantity: previous?.beforeQuantity ?? 0, afterQuantity: line.quantity,
        });
      }
      const outstanding = afterTotals.totalOutstanding;
      const balance = Number(outstanding.amount);
      const direction = balance > 0 ? "customer_owes" : balance < 0 ? "customer_is_owed" : "settled";
      if (balance !== 0) {
        warnings.push(`WARNING: ${balance > 0 ? "Customer owes" : "Customer is owed"} ${outstanding.amount.replace(/^-/, "")} ${outstanding.currencyCode}. Payment collection or refund is NOT done by this tool.${input.commit ? "" : " This is a dry-run projection."}`);
      }
      return {
        committed: input.commit,
        message: input.commit ? "Order edit committed successfully" : "DRY RUN - nothing changed. Re-run with commit=true to apply.",
        ...(!input.commit && { session: "This fresh, uncommitted calculated order simply expires; re-running creates a new edit session." }),
        order: {
          id: resultOrder.id, name: resultOrder.name, displayFinancialStatus: resultOrder.displayFinancialStatus,
          displayFulfillmentStatus: resultOrder.displayFulfillmentStatus, cancelledAt: resultOrder.cancelledAt, closed: resultOrder.closed,
        },
        calculatedOrderId: calculated.id,
        before: { lineItems: before, totals: orderTotals(order) },
        after: { lineItems: afterLines, lineItemsComplete: afterLinesComplete, totals: afterTotals },
        lineTable: [...lineTable.values()],
        payment: { direction, totalOutstanding: outstanding },
        warnings,
      };
    } catch (error) {
      handleToolError("edit order", error);
    }
  },
};

export { orderEdit };
