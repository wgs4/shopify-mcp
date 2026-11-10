import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, type StoreContext } from "../lib/toolUtils.js";

export const DEFAULT_RETURNS_LIMIT = 5;
export const MAX_RETURNS_LIMIT = 5;
const CursorSchema = z.string().min(1).max(1024).refine(
  (cursor) => cursor.trim() === cursor,
  "Cursor must be copied verbatim without surrounding whitespace",
);

const SUMMARY_NOTE =
  "Return labels and Shopify workflow statuses (e.g. REFUNDED, RETURNED, CLOSED) do not prove physical warehouse receipt; Shopify also may not know about a buyer's self-shipped or off-platform return parcel.";

export const GetOrderReturnsInputSchema = z.object({
  orderId: z.string().trim().regex(/^(gid:\/\/shopify\/Order\/)?[1-9]\d*$/, "orderId must be a Shopify Order GID or positive integer string"),
  returnId: z.string().trim().regex(/^(gid:\/\/shopify\/Return\/)?[1-9]\d*$/, "returnId must be a Shopify Return GID or positive integer string").optional(),
  reverseFulfillmentOrderId: z.string().trim().regex(/^(gid:\/\/shopify\/ReverseFulfillmentOrder\/)?[1-9]\d*$/, "reverseFulfillmentOrderId must be a Shopify ReverseFulfillmentOrder GID or positive integer string").optional(),
  limit: z.number().int().min(1).max(MAX_RETURNS_LIMIT).default(DEFAULT_RETURNS_LIMIT),
  after: CursorSchema.optional().describe("Opaque endCursor for the selected connection"),
});

const REVERSE_DELIVERY_FRAGMENT = gql`
  #graphql
  fragment OrderReturnReverseDelivery on ReverseDelivery {
    id
    deliverable {
      __typename
      ... on ReverseDeliveryShippingDeliverable {
        tracking { number carrierName url }
        label { createdAt }
      }
    }
  }
`;

const RFO_FRAGMENT = gql`
  #graphql
  fragment OrderReturnRfo on ReverseFulfillmentOrder {
    id status
    reverseDeliveries(first: 3) {
      pageInfo { hasNextPage hasPreviousPage endCursor }
      edges { node { ...OrderReturnReverseDelivery } }
    }
  }
`;

export const GET_ORDER_RETURNS_QUERY = `${gql`
  #graphql
  query GetOrderReturns($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      id name returnStatus
      returns(first: $first, after: $after) {
        pageInfo { hasNextPage hasPreviousPage endCursor }
        edges { node {
          id name status
          reverseFulfillmentOrders(first: 3) {
            pageInfo { hasNextPage hasPreviousPage endCursor }
            edges { node { ...OrderReturnRfo } }
          }
        } }
      }
    }
  }
`}\n${RFO_FRAGMENT}\n${REVERSE_DELIVERY_FRAGMENT}`;

export const GET_RETURN_RFOS_QUERY = `${gql`
  #graphql
  query GetReturnReverseFulfillmentOrders($id: ID!, $first: Int!, $after: String) {
    return(id: $id) {
      id name status
      order { id name }
      reverseFulfillmentOrders(first: $first, after: $after) {
        pageInfo { hasNextPage hasPreviousPage endCursor }
        edges { node { ...OrderReturnRfo } }
      }
    }
  }
`}\n${RFO_FRAGMENT}\n${REVERSE_DELIVERY_FRAGMENT}`;

export const GET_RFO_DELIVERIES_QUERY = `${gql`
  #graphql
  query GetReverseFulfillmentOrderDeliveries($id: ID!, $first: Int!, $after: String) {
    reverseFulfillmentOrder(id: $id) {
      id status
      order { id name }
      reverseDeliveries(first: $first, after: $after) {
        pageInfo { hasNextPage hasPreviousPage endCursor }
        edges { node { ...OrderReturnReverseDelivery } }
      }
    }
  }
`}\n${REVERSE_DELIVERY_FRAGMENT}`;

export interface PageInfo { hasNextPage: boolean; hasPreviousPage: boolean; endCursor: string | null }
interface Connection<T> { pageInfo: PageInfo; edges: Array<{ node: T }> }
interface GqlDeliveryNode {
  id: string;
  deliverable: {
    __typename: string;
    tracking?: { number: string | null; carrierName: string | null; url: string | null } | null;
    label?: { createdAt: string | null } | null;
  } | null;
}
interface GqlRfoNode { id: string; status: string; reverseDeliveries: Connection<GqlDeliveryNode> }
interface GqlReturnNode { id: string; name: string; status: string; reverseFulfillmentOrders: Connection<GqlRfoNode> }

export interface ReverseDeliveryItem {
  id: string;
  deliverableType: string | null;
  hasLabel: boolean | null;
  tracking: { number: string | null; carrierName: string | null; url: string | null } | null;
}
export interface ReverseFulfillmentOrderItem { id: string; status: string; pageInfo: PageInfo; reverseDeliveries: ReverseDeliveryItem[] }
export interface ReturnItem { id: string; name: string; status: string; pageInfo: PageInfo; reverseFulfillmentOrders: ReverseFulfillmentOrderItem[] }
export interface GetOrderReturnsResult {
  store: string;
  order: { id: string; name: string; returnStatus: string | null };
  returns: ReturnItem[];
  reverseFulfillmentOrder?: ReverseFulfillmentOrderItem;
  pageInfo: PageInfo;
  truncated: boolean;
  summary: { hasInboundTracking: boolean | null; note: string };
}

const toGid = (kind: string, id: string) => (id.startsWith("gid://") ? id : `gid://shopify/${kind}/${id}`);
const cleanStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const getOrderReturns = {
  name: "get-order-returns",
  description:
    "Get an order's returns and inbound return shipment tracking from Shopify ReverseFulfillmentOrder and ReverseDelivery records (requires read_orders and read_returns). Supports nested cursor pagination via returnId or reverseFulfillmentOrderId.",
  schema: GetOrderReturnsInputSchema,

  execute: async (rawInput: Record<string, unknown>, ctx: StoreContext): Promise<GetOrderReturnsResult> => {
    try {
      const input = GetOrderReturnsInputSchema.parse(rawInput);
      if (input.returnId && input.reverseFulfillmentOrderId) {
        throw new Error("Provide at most one of returnId or reverseFulfillmentOrderId.");
      }
      const orderId = toGid("Order", input.orderId);
      let observedTracking = false, truncated = false, incomplete = false;
      let earlierPages = Boolean(input.after || input.returnId || input.reverseFulfillmentOrderId);

      const readConn = <T>(conn: Connection<T> | null | undefined, after?: string) => {
        const pageInfo = conn?.pageInfo;
        if (
          !conn || !Array.isArray(conn.edges) ||
          typeof pageInfo?.hasNextPage !== "boolean" ||
          typeof pageInfo.hasPreviousPage !== "boolean"
        ) {
          throw new Error(`Malformed or missing return connection for ${orderId}.`);
        }
        const cursor = CursorSchema.safeParse(pageInfo.endCursor);
        if (pageInfo.hasNextPage && (!cursor.success || cursor.data === after || conn.edges.length === 0)) {
          throw new Error("Pagination cursor did not advance or cannot be reused.");
        }
        if (pageInfo.hasNextPage) truncated = true;
        if (pageInfo.hasPreviousPage) earlierPages = true;
        const nodes: T[] = [];
        for (const edge of conn.edges) {
          if (edge && typeof edge === "object" && edge.node && typeof edge.node === "object") nodes.push(edge.node);
          else incomplete = true;
        }
        return {
          nodes,
          pageInfo: {
            hasNextPage: pageInfo.hasNextPage,
            hasPreviousPage: pageInfo.hasPreviousPage,
            endCursor: cursor.success ? cursor.data : null,
          },
        };
      };

      const mapRfo = (rfo: GqlRfoNode, after?: string): ReverseFulfillmentOrderItem | null => {
        const id = cleanStr(rfo.id), status = cleanStr(rfo.status);
        if (!id || !status) { incomplete = true; return null; }
        const rdConn = readConn(rfo.reverseDeliveries, after);
        const reverseDeliveries: ReverseDeliveryItem[] = [];
        for (const rd of rdConn.nodes) {
          const rdId = cleanStr(rd.id);
          if (!rdId) { incomplete = true; continue; }
          let deliverableType: string | null = null, hasLabel: boolean | null = null, tracking: ReverseDeliveryItem["tracking"] = null;
          if (!("deliverable" in rd)) incomplete = true;
          else if (rd.deliverable === null) hasLabel = false;
          else if (typeof rd.deliverable !== "object") incomplete = true;
          else {
            deliverableType = cleanStr(rd.deliverable.__typename);
            if (deliverableType !== "ReverseDeliveryShippingDeliverable") incomplete = true;
            else {
              if (!("label" in rd.deliverable)) incomplete = true;
              else if (rd.deliverable.label === null) hasLabel = false;
              else if (cleanStr(rd.deliverable.label?.createdAt)) hasLabel = true;
              else incomplete = true;

              if (!("tracking" in rd.deliverable)) incomplete = true;
              else if (rd.deliverable.tracking !== null) {
                if (typeof rd.deliverable.tracking !== "object") incomplete = true;
                else {
                  const rawTracking = rd.deliverable.tracking;
                  if ([rawTracking.number, rawTracking.url].some((value) => value !== null && typeof value !== "string")) {
                    incomplete = true;
                  }
                  const number = cleanStr(rawTracking.number);
                  const carrierName = cleanStr(rawTracking.carrierName);
                  const url = cleanStr(rawTracking.url);
                  if (number || url) observedTracking = true;
                  if (number || carrierName || url) tracking = { number, carrierName, url };
                }
              }
            }
          }
          reverseDeliveries.push({ id: rdId, deliverableType, hasLabel, tracking });
        }
        return { id, status, pageInfo: rdConn.pageInfo, reverseDeliveries };
      };

      const mapReturn = (ret: GqlReturnNode, after?: string): ReturnItem | null => {
        const id = cleanStr(ret.id), name = cleanStr(ret.name), status = cleanStr(ret.status);
        if (!id || !name || !status) { incomplete = true; return null; }
        const rfoConn = readConn(ret.reverseFulfillmentOrders, after);
        const reverseFulfillmentOrders = rfoConn.nodes.map((n) => mapRfo(n)).filter((x): x is ReverseFulfillmentOrderItem => x !== null);
        return { id, name, status, pageInfo: rfoConn.pageInfo, reverseFulfillmentOrders };
      };

      const checkParentOrder = (label: string, node: { order: { id: string; name: string } | null } | null | undefined) => {
        if (!node) throw new Error(`${label} not found (check shop/store, read_returns, and read_all_orders for orders older than 60 days).`);
        const parentId = cleanStr(node.order?.id), parentName = cleanStr(node.order?.name);
        if (!parentId || !parentName || parentId !== orderId) {
          throw new Error(`${label} does not belong to order ${orderId}.`);
        }
        return { id: parentId, name: parentName, returnStatus: null };
      };

      if (input.reverseFulfillmentOrderId) {
        const rfoId = toGid("ReverseFulfillmentOrder", input.reverseFulfillmentOrderId);
        const data = await ctx.client.request<{ reverseFulfillmentOrder: (GqlRfoNode & { order: { id: string; name: string } | null }) | null }>(
          GET_RFO_DELIVERIES_QUERY, { id: rfoId, first: input.limit, after: input.after },
        );
        const order = checkParentOrder(`ReverseFulfillmentOrder ${rfoId}`, data?.reverseFulfillmentOrder);
        const reverseFulfillmentOrder = mapRfo(data!.reverseFulfillmentOrder!, input.after);
        if (!reverseFulfillmentOrder) throw new Error(`ReverseFulfillmentOrder ${rfoId} response is incomplete.`);
        return {
          store: ctx.storeKey, order, returns: [], reverseFulfillmentOrder, pageInfo: reverseFulfillmentOrder.pageInfo,
          truncated, summary: { hasInboundTracking: observedTracking ? true : null, note: SUMMARY_NOTE },
        };
      }

      if (input.returnId) {
        const returnId = toGid("Return", input.returnId);
        const data = await ctx.client.request<{ return: (GqlReturnNode & { order: { id: string; name: string } | null }) | null }>(
          GET_RETURN_RFOS_QUERY, { id: returnId, first: input.limit, after: input.after },
        );
        const order = checkParentOrder(`Return ${returnId}`, data?.return);
        const mapped = mapReturn(data!.return!, input.after);
        if (!mapped) throw new Error(`Return ${returnId} response is incomplete.`);
        return {
          store: ctx.storeKey, order, returns: [mapped], pageInfo: mapped.pageInfo,
          truncated, summary: { hasInboundTracking: observedTracking ? true : null, note: SUMMARY_NOTE },
        };
      }

      const data = await ctx.client.request<{ order: { id: string; name: string; returnStatus: string | null; returns: Connection<GqlReturnNode> } | null }>(
        GET_ORDER_RETURNS_QUERY, { id: orderId, first: input.limit, after: input.after },
      );
      if (!data?.order) throw new Error(`Order ${orderId} not found (check shop/store, read_orders, and read_all_orders for orders older than 60 days).`);
      const resolvedId = cleanStr(data.order.id), orderName = cleanStr(data.order.name);
      if (resolvedId !== orderId || !orderName) throw new Error(`Order ${orderId} response has unexpected order identity.`);
      const retConn = readConn(data.order.returns, input.after);
      const returns = retConn.nodes.map((n) => mapReturn(n)).filter((x): x is ReturnItem => x !== null);
      const hasInboundTracking = observedTracking ? true : truncated || earlierPages || incomplete ? null : false;
      return {
        store: ctx.storeKey, order: { id: resolvedId, name: orderName, returnStatus: cleanStr(data.order.returnStatus) },
        returns, pageInfo: retConn.pageInfo, truncated, summary: { hasInboundTracking, note: SUMMARY_NOTE },
      };
    } catch (error) {
      handleToolError("fetch order returns", error);
    }
  },
};
