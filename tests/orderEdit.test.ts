import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { getOperationAST, parse } from "graphql";
import { _resetForTest } from "../src/lib/accessScopes.js";
import type { StoreContext } from "../src/lib/toolUtils.js";
import { orderEdit } from "../src/tools/orderEdit.js";

const ORDER = "gid://shopify/Order/1234567890123";
const LINE = "gid://shopify/LineItem/101";
const CALCULATED_LINE = "gid://shopify/CalculatedLineItem/101";
const VARIANT = "gid://shopify/ProductVariant/201";
const CALCULATED = "gid://shopify/CalculatedOrder/301";

function money(amount: string, currencyCode = "USD") {
  return { shopMoney: { amount, currencyCode } };
}

function connection<T>(nodes: T[], cursor: string | null = null) {
  return {
    edges: nodes.map((node) => ({ node })),
    pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
  };
}

function orderLine(overrides = {}) {
  return {
    id: LINE, sku: "OLD-SKU", title: "Original product", variantTitle: "8 ohm",
    currentQuantity: 2, unfulfilledQuantity: 2, ...overrides,
  };
}

function calculatedLine(overrides = {}) {
  return {
    id: CALCULATED_LINE, sku: "OLD-SKU", title: "Original product", variantTitle: "8 ohm",
    quantity: 2, editableQuantity: 2, editableQuantityBeforeChanges: 2, ...overrides,
  };
}

function originalOrder(overrides = {}) {
  return {
    id: ORDER, name: "#30965", displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED", cancelledAt: null, closed: false,
    lineItems: connection([orderLine()]),
    subtotal: money("20.00"), tax: money("1.20"), total: money("21.20"),
    totalOutstanding: money("0.00"), ...overrides,
  };
}

function calculatedOrder(overrides = {}) {
  return {
    id: CALCULATED, lineItems: connection([calculatedLine()]), addedLineItems: connection([]),
    subtotal: money("20.00"), taxLines: [{ priceSet: money("1.20") }],
    total: money("21.20"), totalOutstanding: money("0.00"), ...overrides,
  };
}

type Call = { operation: string; variables: Record<string, any>; query: string };

function setup(options: {
  order?: ReturnType<typeof originalOrder> | null;
  calculated?: ReturnType<typeof calculatedOrder>;
  committed?: ReturnType<typeof originalOrder>;
  scopes?: string[];
  orders?: ReturnType<typeof connection<{ id: string; name: string }>>;
  variants?: ReturnType<typeof connection<{ id: string; sku: string; title: string }>>;
  errorAt?: string;
  override?: (call: Call) => unknown;
} = {}) {
  const calls: Call[] = [];
  const initial = options.order === undefined ? originalOrder() : options.order;
  let staged = options.calculated ?? calculatedOrder();
  const request = jest.fn(async (query: unknown, variables: Record<string, any> = {}) => {
    const operation = getOperationAST(parse(String(query)))?.name?.value ?? "";
    const call = { operation, variables, query: String(query) };
    calls.push(call);
    const override = options.override?.(call);
    if (override !== undefined) {
      if (operation === "OrderEditBegin") {
        staged = (override as { orderEditBegin: { calculatedOrder: typeof staged } }).orderEditBegin.calculatedOrder;
      }
      return override;
    }
    if (operation === "CurrentAccessScopes") {
      return { currentAppInstallation: { accessScopes: (options.scopes ?? ["write_order_edits", "read_orders", "read_products"]).map((handle) => ({ handle })) } };
    }
    if (operation === "OrderEditReadOrder") return { order: initial };
    if (operation === "OrderEditFindOrder") return { orders: options.orders ?? connection([{ id: ORDER, name: "#30965" }]) };
    if (operation === "OrderEditFindVariant") return { productVariants: options.variants ?? connection([{ id: VARIANT, sku: "NEW-SKU", title: "New variant" }]) };
    if (operation === "OrderEditBegin") {
      return { orderEditBegin: payload("OrderEditBegin", staged) };
    }
    if (operation === "OrderEditAddVariant") {
      staged = {
        ...staged,
        addedLineItems: connection([calculatedLine({
          id: "gid://shopify/CalculatedLineItem/102", sku: "NEW-SKU", title: "New product",
          variantTitle: "16 ohm", quantity: variables.quantity,
        })]),
      };
      return { orderEditAddVariant: payload("OrderEditAddVariant", staged) };
    }
    if (operation === "OrderEditSetQuantity") {
      staged = {
        ...staged,
        lineItems: {
          ...staged.lineItems,
          edges: staged.lineItems.edges.map(({ node }) => ({
            node: node.id === variables.lineItemId ? { ...node, quantity: variables.quantity } : node,
          })),
        },
      };
      return { orderEditSetQuantity: payload("OrderEditSetQuantity", staged) };
    }
    if (operation === "OrderEditCommit") {
      return { orderEditCommit: {
        order: options.committed ?? originalOrder({
          lineItems: connection([...staged.lineItems.edges, ...staged.addedLineItems.edges].map(({ node }) => orderLine({
            ...node, id: node.id.replace("/CalculatedLineItem/", "/LineItem/"), currentQuantity: node.quantity,
          }))),
          subtotal: staged.subtotal, tax: money("1.20"), total: staged.total,
          totalOutstanding: staged.totalOutstanding,
        }),
        userErrors: errors(operation),
      } };
    }
    throw new Error(`Unexpected request ${operation}`);
  });
  function errors(operation: string) {
    return options.errorAt === operation ? [{ field: ["id"], message: "Shopify refused this edit" }] : [];
  }
  function payload(operation: string, calculated: ReturnType<typeof calculatedOrder>) {
    return { calculatedOrder: calculated, userErrors: errors(operation) };
  }
  const ctx: StoreContext = {
    client: { request } as unknown as StoreContext["client"], domain: "example.myshopify.com",
    storeKey: "example", apiVersion: "2026-01", getAccessToken: () => "unused-test-token",
  };
  return {
    calls, request, ctx,
    mutations: () => calls.filter((call) => getOperationAST(parse(call.query))?.operation === "mutation"),
    run: (input: Record<string, unknown> = {}) => orderEdit.execute({ orderId: ORDER, ...input }, ctx),
  };
}

beforeEach(() => _resetForTest());

describe("order-edit staging and commit", () => {
  test("default dry run stages add before quantity changes, returns both line connections, and never commits", async () => {
    const harness = setup();
    const result = await harness.run({ add: [{ variantId: VARIANT, quantity: 3 }], setQuantity: [{ lineItemId: LINE, quantity: 0 }] });
    expect(harness.mutations().map((call) => call.operation)).toEqual(["OrderEditBegin", "OrderEditAddVariant", "OrderEditSetQuantity"]);
    expect(harness.mutations()[1].query).toMatch(/allowDuplicates:\s*false/);
    expect(harness.mutations()[2].variables).toEqual({ id: CALCULATED, lineItemId: CALCULATED_LINE, quantity: 0, restock: true });
    expect(result.committed).toBe(false);
    expect(result.message).toBe("DRY RUN - nothing changed. Re-run with commit=true to apply.");
    expect(result.session).toMatch(/uncommitted.*expires/);
    expect(result.before.lineItems[0].quantity).toBe(2);
    expect(result.after.lineItems.map((line) => line.quantity)).toEqual([0, 3]);
    expect(result.lineTable).toEqual([
      expect.objectContaining({ sku: "OLD-SKU", beforeQuantity: 2, afterQuantity: 0 }),
      expect.objectContaining({ sku: "NEW-SKU", beforeQuantity: 0, afterQuantity: 3 }),
    ]);
    expect(result.after.totals.tax).toEqual({ amount: "1.20", currencyCode: "USD" });
  });

  test("commit runs begin -> add -> setQuantity -> commit and uses committed quantities and totals", async () => {
    const harness = setup({ committed: originalOrder({
      lineItems: connection([orderLine({ currentQuantity: 4 })]),
      displayFinancialStatus: "PARTIALLY_PAID",
      total: money("42.40"), totalOutstanding: money("21.20"),
    }) });
    const result = await harness.run({
      add: [{ variantId: VARIANT, quantity: 1 }], setQuantity: [{ sku: "OLD-SKU", quantity: 4 }],
      commit: true, staffNote: "Trevor's note, verbatim.\nSecond line.",
    });
    expect(harness.mutations().map((call) => call.operation)).toEqual(["OrderEditBegin", "OrderEditAddVariant", "OrderEditSetQuantity", "OrderEditCommit"]);
    expect(harness.mutations()[3].variables).toEqual({ id: CALCULATED, notifyCustomer: false, staffNote: "Trevor's note, verbatim.\nSecond line." });
    expect(result.committed).toBe(true);
    expect(result.session).toBeUndefined();
    expect(result.after.lineItems[0].quantity).toBe(4);
    expect(result.after.totals.total.amount).toBe("42.40");
    expect(result.order.displayFinancialStatus).toBe("PARTIALLY_PAID");
    expect(result.payment.direction).toBe("customer_owes");
    expect(result.warnings[0]).toMatch(/WARNING: Customer owes 21.20 USD.*NOT done/);
  });

  test("passes explicit restock=false and notifyCustomer=true", async () => {
    const harness = setup();
    await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }], restock: false, notifyCustomer: true, commit: true });
    expect(harness.mutations()[1].variables.restock).toBe(false);
    expect(harness.mutations()[2].variables.notifyCustomer).toBe(true);
    expect(harness.mutations()[2].variables).not.toHaveProperty("staffNote");
  });

  test("every invocation begins a fresh session", async () => {
    let count = 0;
    const harness = setup({ override: (call) => call.operation === "OrderEditBegin"
      ? { orderEditBegin: { calculatedOrder: calculatedOrder({ id: `${CALCULATED}${++count}` }), userErrors: [] } }
      : undefined });
    const first = await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] });
    const second = await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] });
    expect(first.calculatedOrderId).not.toBe(second.calculatedOrderId);
    expect(count).toBe(2);
    expect(harness.mutations().filter((call) => call.operation === "OrderEditCommit")).toHaveLength(0);
  });

  test("leaves untouched fulfilled lines in the preview", async () => {
    const harness = setup({
      order: originalOrder({ lineItems: connection([orderLine({ unfulfilledQuantity: 0 })]) }),
      calculated: calculatedOrder({ lineItems: connection([calculatedLine({ editableQuantity: 0, editableQuantityBeforeChanges: 0 })]) }),
    });
    const result = await harness.run({ add: [{ variantId: VARIANT, quantity: 1 }] });
    expect(result.after.lineItems[0].quantity).toBe(2);
    expect(harness.mutations().map((call) => call.operation)).toEqual(["OrderEditBegin", "OrderEditAddVariant"]);
  });
});

describe("order and SKU resolution", () => {
  test("normalizes a numeric orderId to an order GID", async () => {
    const harness = setup();
    await harness.run({ orderId: "1234567890123", add: [{ variantId: VARIANT, quantity: 1 }] });
    expect(harness.calls.find((call) => call.operation === "OrderEditReadOrder")?.variables.id).toBe(ORDER);
  });

  test.each(["#30965", "30965"])("resolves exact orderName %s", async (orderName) => {
    const harness = setup({ orders: connection([{ id: "wrong", name: "#309650" }, { id: ORDER, name: "#30965" }]) });
    await orderEdit.execute({ orderName, add: [{ variantId: VARIANT, quantity: 1 }] }, harness.ctx);
    expect(harness.calls.find((call) => call.operation === "OrderEditReadOrder")?.variables.id).toBe(ORDER);
  });

  test.each([[], [{ id: ORDER, name: "#30965" }, { id: "other", name: "30965" }]].map((orders) => ({ orders })))("rejects non-unique orderName matches $orders before beginning", async ({ orders }) => {
    const harness = setup({ orders: connection(orders) });
    await expect(orderEdit.execute({ orderName: "30965", add: [{ variantId: VARIANT, quantity: 1 }] }, harness.ctx)).rejects.toThrow(/exactly one order/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("paginates name search instead of accepting a unique first-page match", async () => {
    const harness = setup({
      orders: connection([{ id: ORDER, name: "#30965" }], "next"),
      override: (call) => call.operation === "OrderEditFindOrder" && call.variables.after === "next"
        ? { orders: connection([{ id: "other", name: "30965" }]) } : undefined,
    });
    await expect(orderEdit.execute({ orderName: "30965", add: [{ variantId: VARIANT, quantity: 1 }] }, harness.ctx)).rejects.toThrow(/found 2/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("reports a missing order before staging", async () => {
    const harness = setup({ order: null });
    await expect(harness.run({ add: [{ variantId: VARIANT, quantity: 1 }] })).rejects.toThrow(/not found.*read_all_orders/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("resolves one exact variant SKU and ignores fuzzy search hits", async () => {
    const harness = setup({ variants: connection([
      { id: "wrong", sku: "NEW-SKU-extra", title: "Wrong" },
      { id: VARIANT, sku: "NEW-SKU", title: "Right" },
    ]) });
    await harness.run({ add: [{ sku: "NEW-SKU", quantity: 1 }] });
    expect(harness.mutations()[1].variables.variantId).toBe(VARIANT);
  });

  test.each([[], [
    { id: VARIANT, sku: "NEW-SKU", title: "One" },
    { id: "gid://shopify/ProductVariant/202", sku: "NEW-SKU", title: "Two" },
  ]].map((variants) => ({ variants })))("rejects zero or multiple exact variant matches and lists candidates $variants", async ({ variants }) => {
    const harness = setup({ variants: connection(variants) });
    await expect(harness.run({ add: [{ sku: "NEW-SKU", quantity: 1 }] })).rejects.toThrow(/exactly one variant.*Matches:.*Search candidates:/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("finds duplicate variant SKUs on later pages", async () => {
    const harness = setup({
      variants: connection([{ id: VARIANT, sku: "NEW-SKU", title: "One" }], "next"),
      override: (call) => call.operation === "OrderEditFindVariant" && call.variables.after === "next"
        ? { productVariants: connection([{ id: "second", sku: "NEW-SKU", title: "Two" }]) } : undefined,
    });
    await expect(harness.run({ add: [{ sku: "NEW-SKU", quantity: 1 }] })).rejects.toThrow(/found 2/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("quotes and escapes SKU search values", async () => {
    const sku = 'A" OR sku:*\\B';
    const harness = setup({ variants: connection([{ id: VARIANT, sku, title: "Literal SKU" }]) });
    await harness.run({ add: [{ sku, quantity: 1 }] });
    expect(harness.calls.find((call) => call.operation === "OrderEditFindVariant")?.variables.query).toBe('sku:"A\\" OR sku:*\\\\B"');
  });

  test("SKU quantity lookup ignores historical zero-quantity lines", async () => {
    const harness = setup({ order: originalOrder({ lineItems: connection([
      orderLine({ id: "gid://shopify/LineItem/999", currentQuantity: 0, unfulfilledQuantity: 0 }), orderLine(),
    ]) }) });
    await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] });
    expect(harness.mutations()[1].variables.lineItemId).toBe(CALCULATED_LINE);
  });

  test.each([[], [orderLine(), orderLine({ id: "gid://shopify/LineItem/999" })]].map((lines) => ({ lines })))("rejects absent or ambiguous current line SKUs $lines", async ({ lines }) => {
    const harness = setup({ order: originalOrder({ lineItems: connection(lines) }) });
    await expect(harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] })).rejects.toThrow(/exactly one current line item/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("explicit lineItemId disambiguates repeated SKUs", async () => {
    const harness = setup({ order: originalOrder({ lineItems: connection([orderLine(), orderLine({ id: "gid://shopify/LineItem/999" })]) }) });
    await harness.run({ setQuantity: [{ lineItemId: LINE, quantity: 1 }] });
    expect(harness.mutations()[1].variables.lineItemId).toBe(CALCULATED_LINE);
  });
});

describe("refusals and mutation errors", () => {
  test("refuses cancelled orders before any edit mutation", async () => {
    const harness = setup({ order: originalOrder({ cancelledAt: "2026-10-31T00:00:00Z" }) });
    await expect(harness.run({ add: [{ variantId: VARIANT, quantity: 1 }], commit: true })).rejects.toThrow(/cancelled/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test.each([0, 1, 2, 4])("refuses quantity %i on a partially fulfilled line, including below fulfilled quantity", async (quantity) => {
    const harness = setup({ order: originalOrder({ lineItems: connection([orderLine({ unfulfilledQuantity: 1 })]) }) });
    await expect(harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity }] })).rejects.toThrow(/fulfilled quantity 1/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("refuses changes on a fully fulfilled line", async () => {
    const harness = setup({ order: originalOrder({ lineItems: connection([orderLine({ unfulfilledQuantity: 0 })]) }) });
    await expect(harness.run({ setQuantity: [{ lineItemId: LINE, quantity: 0 }] })).rejects.toThrow(/fulfilled quantity 2/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("refuses duplicate quantity targets even when one uses SKU and one uses ID", async () => {
    const harness = setup();
    await expect(harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }, { lineItemId: LINE, quantity: 0 }] })).rejects.toThrow(/Duplicate setQuantity/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test("refuses an unverified original-to-calculated ID mapping", async () => {
    const harness = setup({ calculated: calculatedOrder({ lineItems: connection([calculatedLine({ id: "gid://shopify/CalculatedLineItem/999" })]) }) });
    await expect(harness.run({ add: [{ variantId: VARIANT, quantity: 1 }], setQuantity: [{ lineItemId: LINE, quantity: 0 }] })).rejects.toThrow(/Cannot map original line/);
    expect(harness.mutations().map((call) => call.operation)).toEqual(["OrderEditBegin"]);
  });

  test.each([
    { editableQuantityBeforeChanges: 1 }, { quantity: 1 },
  ])("refuses a changed or newly fulfilled line detected by begin %j", async (overrides) => {
    const harness = setup({ calculated: calculatedOrder({ lineItems: connection([calculatedLine(overrides)]) }) });
    await expect(harness.run({ setQuantity: [{ lineItemId: LINE, quantity: 0 }] })).rejects.toThrow(/changed or has fulfilled units/);
    expect(harness.mutations()).toHaveLength(1);
  });

  test.each(["OrderEditBegin", "OrderEditAddVariant", "OrderEditSetQuantity", "OrderEditCommit"])("surfaces %s userErrors and stops immediately", async (errorAt) => {
    const harness = setup({ errorAt });
    await expect(harness.run({ add: [{ variantId: VARIANT, quantity: 1 }], setQuantity: [{ lineItemId: LINE, quantity: 1 }], commit: true })).rejects.toThrow(/Shopify refused this edit/);
    expect(harness.mutations().at(-1)?.operation).toBe(errorAt);
  });

  test.each([[], ["write_orders"], ["read_order_edits"]].map((scopes) => ({ scopes })))("fails fast without write_order_edits: $scopes", async ({ scopes }) => {
    const harness = setup({ scopes });
    await expect(harness.run({ add: [{ variantId: VARIANT, quantity: 1 }] })).rejects.toMatchObject({
      name: "MissingScopeError", code: "MISSING_SCOPE", message: expect.stringMatching(/app is missing write_order_edits.*re-authorize/),
    });
    expect(harness.calls.map((call) => call.operation)).toEqual(["CurrentAccessScopes"]);
  });

  test("does not retry failed mutation requests", async () => {
    const harness = setup({ override: (call) => {
      if (call.operation === "OrderEditAddVariant") throw new Error("network failure");
    } });
    await expect(harness.run({ add: [{ variantId: VARIANT, quantity: 1 }], commit: true })).rejects.toThrow(/Failed to edit order: network failure/);
    expect(harness.mutations().map((call) => call.operation)).toEqual(["OrderEditBegin", "OrderEditAddVariant"]);
  });

  test("commit transport errors report an unknown result and require reading before retrying", async () => {
    const harness = setup({ override: (call) => {
      if (call.operation === "OrderEditCommit") throw new Error("request timed out");
    } });
    await expect(harness.run({ add: [{ variantId: VARIANT, quantity: 1 }], commit: true })).rejects.toThrow(/Commit result unknown.*Read the order before retrying.*already have been applied.*timed out/);
    expect(harness.mutations().filter((call) => call.operation === "OrderEditCommit")).toHaveLength(1);
  });

  test("a failed read after commit returns committed=true and an explicitly incomplete table", async () => {
    const harness = setup({
      committed: originalOrder({ lineItems: connection([], "committed-next"), totalOutstanding: money("10.00") }),
      override: (call) => {
        if (call.operation === "OrderEditOrderLines") throw new Error("read failed");
      },
    });
    const result = await harness.run({ setQuantity: [{ lineItemId: LINE, quantity: 1 }], commit: true });
    expect(result.committed).toBe(true);
    expect(result.after.lineItemsComplete).toBe(false);
    expect(result.after.lineItems).toEqual([]);
    expect(result.lineTable[0].afterQuantity).toBeNull();
    expect(result.warnings[0]).toMatch(/Edit COMMITTED.*read failed.*do not repeat the edit/);
    expect(result.warnings[1]).toMatch(/Customer owes 10.00 USD/);
    expect(harness.mutations().filter((call) => call.operation === "OrderEditCommit")).toHaveLength(1);
  });

  test("a missing committed order payload reports an unknown result", async () => {
    const harness = setup({ override: (call) => call.operation === "OrderEditCommit"
      ? { orderEditCommit: { order: null, userErrors: [] } } : undefined });
    await expect(harness.run({ setQuantity: [{ lineItemId: LINE, quantity: 1 }], commit: true })).rejects.toThrow(/Commit result unknown.*Read order.*before retrying/);
  });
});

describe("validation, pagination, and balances", () => {
  test.each([
    {}, { orderId: ORDER }, { orderId: ORDER, add: [], setQuantity: [] },
    { orderId: ORDER, orderName: "30965", add: [{ variantId: VARIANT, quantity: 1 }] },
    { orderId: ORDER, add: [{ quantity: 1 }] },
    { orderId: ORDER, add: [{ variantId: VARIANT, sku: "NEW-SKU", quantity: 1 }] },
    { orderId: ORDER, add: [{ variantId: VARIANT, quantity: 0 }] },
    { orderId: ORDER, add: [{ variantId: VARIANT, quantity: 1.5 }] },
    { orderId: ORDER, add: [{ variantId: VARIANT, quantity: 2147483648 }] },
    { orderId: ORDER, setQuantity: [{ quantity: 1 }] },
    { orderId: ORDER, setQuantity: [{ sku: "OLD-SKU", lineItemId: LINE, quantity: 1 }] },
    { orderId: ORDER, setQuantity: [{ sku: "OLD-SKU", quantity: -1 }] },
    { orderId: ORDER, setQuantity: [{ sku: "OLD-SKU", quantity: 1.5 }] },
  ])("rejects invalid input without network calls: %j", async (input) => {
    const harness = setup();
    await expect(orderEdit.execute(input, harness.ctx)).rejects.toThrow();
    expect(harness.calls).toHaveLength(0);
  });

  test("reads later original and calculated pages before matching a target", async () => {
    const harness = setup({
      order: originalOrder({ lineItems: connection([], "order-next") }),
      calculated: calculatedOrder({ lineItems: connection([], "calc-next") }),
      override: (call) => {
        if (call.operation === "OrderEditOrderLines") return { order: { lineItems: connection([orderLine()]) } };
        if (call.operation === "OrderEditCalculatedLines") return { node: { lineItems: connection([calculatedLine()]) } };
      },
    });
    const result = await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] });
    expect(harness.mutations()[1].variables.lineItemId).toBe(CALCULATED_LINE);
    expect(result.before.lineItems[0].sku).toBe("OLD-SKU");
    expect(harness.calls.find((call) => call.operation === "OrderEditOrderLines")?.variables.after).toBe("order-next");
  });

  test("includes later added-line pages in the preview", async () => {
    const harness = setup({ override: (call) => {
      if (call.operation === "OrderEditAddVariant") return { orderEditAddVariant: {
        calculatedOrder: calculatedOrder({ addedLineItems: connection([], "added-next") }), userErrors: [],
      } };
      if (call.operation === "OrderEditCalculatedLines" && call.variables.added) return { node: {
        addedLineItems: connection([calculatedLine({ id: "gid://shopify/CalculatedLineItem/102", sku: "NEW-SKU", quantity: 1 })]),
      } };
    } });
    const result = await harness.run({ add: [{ variantId: VARIANT, quantity: 1 }] });
    expect(result.after.lineItems).toHaveLength(2);
    expect(result.after.lineItems[1].sku).toBe("NEW-SKU");
  });

  test("includes later committed-order pages", async () => {
    const harness = setup({
      committed: originalOrder({ lineItems: connection([], "committed-next") }),
      override: (call) => call.operation === "OrderEditOrderLines"
        ? { order: { lineItems: connection([orderLine({ currentQuantity: 1 })]) } } : undefined,
    });
    const result = await harness.run({ setQuantity: [{ lineItemId: LINE, quantity: 1 }], commit: true });
    expect(result.after.lineItems[0].quantity).toBe(1);
    expect(harness.calls.find((call) => call.operation === "OrderEditOrderLines")?.variables.after).toBe("committed-next");
  });

  test("refuses incomplete pagination with no cursor before staging", async () => {
    const lines = connection([orderLine()]);
    lines.pageInfo.hasNextPage = true;
    const harness = setup({ order: originalOrder({ lineItems: lines }) });
    await expect(harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 0 }] })).rejects.toThrow(/invalid pagination cursor/);
    expect(harness.mutations()).toHaveLength(0);
  });

  test.each([
    ["10.00", "customer_owes", /WARNING: Customer owes 10.00 USD/],
    ["-10.00", "customer_is_owed", /WARNING: Customer is owed 10.00 USD/],
    ["0.00", "settled", null],
  ])("reports outstanding %s as %s", async (amount, direction, warning) => {
    const harness = setup({ calculated: calculatedOrder({ totalOutstanding: money(amount as string) }) });
    const result = await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] });
    expect(result.payment.direction).toBe(direction);
    if (warning) {
      expect(result.warnings[0]).toMatch(warning as RegExp);
      expect(result.warnings[0]).toMatch(/NOT done.*dry-run projection/);
    } else expect(result.warnings).toEqual([]);
  });

  test("sums staged tax exactly without losing currency precision", async () => {
    const harness = setup({ calculated: calculatedOrder({
      taxLines: [{ priceSet: money("0.101", "KWD") }, { priceSet: money("0.202", "KWD") }],
      total: money("20.303", "KWD"),
    }) });
    const result = await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] });
    expect(result.after.totals.tax).toEqual({ amount: "0.303", currencyCode: "KWD" });
  });

  test("reports zero tax when Shopify returns no tax lines", async () => {
    const harness = setup({ calculated: calculatedOrder({ taxLines: [] }) });
    const result = await harness.run({ setQuantity: [{ sku: "OLD-SKU", quantity: 1 }] });
    expect(result.after.totals.tax.amount).toBe("0.00");
  });
});
