import { describe, expect, jest, test } from "@jest/globals";
import type { StoreContext } from "../src/lib/toolUtils.js";
import {
  GET_ORDER_RETURNS_QUERY,
  GET_RETURN_RFOS_QUERY,
  GET_RFO_DELIVERIES_QUERY,
  getOrderReturns,
} from "../src/tools/getOrderReturns.js";

const orderId = "gid://shopify/Order/123";
const returnId = "gid://shopify/Return/456";
const rfoId = "gid://shopify/ReverseFulfillmentOrder/789";
const order = { id: orderId, name: "#1001", returnStatus: "IN_PROGRESS" };
const noMorePages = { hasNextPage: false, hasPreviousPage: false, endCursor: null };

function connection<T>(nodes: T[], pageInfo = noMorePages as {
  hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null;
}) {
  return { pageInfo, edges: nodes.map((node) => ({ node })) };
}

function delivery(tracking: unknown) {
  return {
    id: "gid://shopify/ReverseDelivery/234",
    deliverable: {
      __typename: "ReverseDeliveryShippingDeliverable",
      tracking,
      label: { createdAt: "2026-11-01T00:00:00Z" },
    },
  };
}

function reverseOrder(reverseDeliveries = connection([delivery(null)])) {
  return { id: rfoId, status: "OPEN", reverseDeliveries };
}

function returnRecord(reverseFulfillmentOrders = connection([reverseOrder()])) {
  return { id: returnId, name: "#1001-R1", status: "OPEN", reverseFulfillmentOrders };
}

function withReturns(returns = connection([returnRecord()])) {
  return { order: { ...order, returns } };
}

function harness(response: unknown) {
  const request = jest.fn(async (_query: string, _vars: unknown) => {
    if (response instanceof Error) throw response;
    return response;
  });
  const ctx = { client: { request }, storeKey: "wgs" } as unknown as StoreContext;
  return { request, ctx };
}

describe("get-order-returns", () => {
  test("reads only reverse-delivery tracking and label presence", async () => {
    const tracking = { number: "TRACK-001", carrierName: "UPS", url: "https://example.test/track" };
    const { ctx, request } = harness(withReturns(connection([
      returnRecord(connection([reverseOrder(connection([delivery(tracking)]))])),
    ])));
    const result = await getOrderReturns.execute({ orderId: "123" }, ctx);

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(GET_ORDER_RETURNS_QUERY, {
      id: orderId, first: 5, after: undefined,
    });
    expect(GET_ORDER_RETURNS_QUERY).not.toMatch(/\b(fulfillments|publicFileUrl|customer|shippingAddress)\b/);
    expect(result.returns[0].reverseFulfillmentOrders[0].reverseDeliveries[0]).toMatchObject({
      hasLabel: true, tracking,
    });
    expect(result.summary.hasInboundTracking).toBe(true);
  });

  test("distinguishes a complete empty connection, invisible order, and access denial", async () => {
    const empty = await getOrderReturns.execute({ orderId }, harness(withReturns(connection([]))).ctx);
    expect(empty.returns).toEqual([]);
    expect(empty.summary.hasInboundTracking).toBe(false);

    await expect(getOrderReturns.execute({ orderId }, harness({ order: null }).ctx))
      .rejects.toThrow(/read_all_orders/);
    await expect(getOrderReturns.execute({ orderId }, harness(new Error("Access denied for order field")).ctx))
      .rejects.toThrow("Failed to fetch order returns: Access denied for order field");
    await expect(getOrderReturns.execute({ orderId }, harness({ order: { ...order, returns: null } }).ctx))
      .rejects.toThrow(/Malformed or missing return connection/);
  });

  test("distinguishes unavailable tracking fields from explicit nulls", async () => {
    for (const [tracking, expected] of [
      [{ carrierName: "UPS" }, null],
      [{ carrierName: "UPS", number: null, url: null }, false],
    ]) {
      const { ctx } = harness(withReturns(connection([
        returnRecord(connection([reverseOrder(connection([delivery(tracking)]))])),
      ])));
      expect((await getOrderReturns.execute({ orderId }, ctx)).summary.hasInboundTracking).toBe(expected);
    }
  });

  test("keeps the absence of tracking indeterminate when nested or earlier pages exist", async () => {
    const pageInfo = { ...noMorePages, hasNextPage: true, endCursor: "delivery-cursor" };
    const { ctx } = harness(withReturns(connection([
      returnRecord(connection([reverseOrder(connection([delivery(null)], pageInfo))])),
    ])));
    const result = await getOrderReturns.execute({ orderId }, ctx);

    expect(result.truncated).toBe(true);
    expect(result.summary.hasInboundTracking).toBeNull();
    expect(result.returns[0].reverseFulfillmentOrders[0].pageInfo.endCursor).toBe("delivery-cursor");

    const lastPage = await getOrderReturns.execute(
      { orderId, after: "returns-cursor" },
      harness(withReturns(connection([]))).ctx,
    );
    expect(lastPage.summary.hasInboundTracking).toBeNull();
  });

  test("fails rather than returning a padded, oversized, or repeated continuation cursor", async () => {
    for (const endCursor of ["same", " same ", "x".repeat(1025)]) {
      const { ctx } = harness(withReturns(connection(
        [returnRecord()], { ...noMorePages, hasNextPage: true, endCursor },
      )));
      await expect(getOrderReturns.execute({ orderId, after: "same" }, ctx))
        .rejects.toThrow(/Pagination cursor did not advance or cannot be reused/);
    }
  });

  test("routes either nested continuation to its parent and checks order ownership", async () => {
    const parentReturn = harness({ return: { ...returnRecord(), order } });
    const returnPage = await getOrderReturns.execute(
      { orderId, returnId: "456", after: "rfo-cursor" }, parentReturn.ctx,
    );
    expect(parentReturn.request).toHaveBeenCalledWith(GET_RETURN_RFOS_QUERY, {
      id: returnId, first: 5, after: "rfo-cursor",
    });
    expect(returnPage.summary.hasInboundTracking).toBeNull();

    const parentRfo = harness({ reverseFulfillmentOrder: { ...reverseOrder(), order } });
    const rfoPage = await getOrderReturns.execute(
      { orderId, reverseFulfillmentOrderId: rfoId, after: "delivery-cursor" }, parentRfo.ctx,
    );
    expect(parentRfo.request).toHaveBeenCalledWith(GET_RFO_DELIVERIES_QUERY, {
      id: rfoId, first: 5, after: "delivery-cursor",
    });
    expect(rfoPage.reverseFulfillmentOrder?.id).toBe(rfoId);
    expect(rfoPage.summary.hasInboundTracking).toBeNull();

    const wrongOrder = { ...order, id: "gid://shopify/Order/999" };
    await expect(getOrderReturns.execute(
      { orderId, returnId },
      harness({ return: { ...returnRecord(), order: wrongOrder } }).ctx,
    )).rejects.toThrow(/does not belong to order/);
    await expect(getOrderReturns.execute(
      { orderId, reverseFulfillmentOrderId: rfoId },
      harness({ reverseFulfillmentOrder: { ...reverseOrder(), order: wrongOrder } }).ctx,
    )).rejects.toThrow(/does not belong to order/);
  });

  test("rejects unsupported IDs, oversized pages, and conflicting nested IDs before reading Shopify", async () => {
    const { ctx, request } = harness({});
    for (const input of [
      { orderId: "#1001" },
      { orderId, limit: 6 },
      { orderId, returnId: rfoId },
      { orderId, returnId, reverseFulfillmentOrderId: rfoId },
    ]) {
      await expect(getOrderReturns.execute(input, ctx)).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
});
