import { gql } from "graphql-request";
import { z } from "zod";
import { handleToolError, type StoreContext } from "../lib/toolUtils.js";

const ORDER_ID_REGEX = /^(?:gid:\/\/shopify\/Order\/)?[1-9]\d*$/;
const CursorSchema = z.string().min(1).max(1024).refine(
  (cursor) => cursor.trim() === cursor,
  "Cursor must be copied verbatim without surrounding whitespace",
);

const GetOrderTimelineInputSchema = z.object({
  orderId: z
    .string()
    .trim()
    .regex(
      ORDER_ID_REGEX,
      'orderId must be a positive numeric Shopify Order ID (e.g. "8054938337547") or a Shopify Order GID (e.g. "gid://shopify/Order/8054938337547")',
    )
    .describe('Placed Shopify Order numeric ID or Order GID ("gid://shopify/Order/8054938337547").'),
  limit: z.number().int().min(1).max(50).default(25).describe("Maximum number of timeline events per page (1-50, default 25)"),
  after: CursorSchema.optional().describe("Opaque pagination cursor from pageInfo.endCursor"),
  includeComments: z.boolean().default(true).describe('Include staff CommentEvent entries (false passes query="comments:false")'),
  reverse: z.boolean().default(false).describe("Reverse chronological sort order (false = oldest first, true = newest first)"),
});

export type GetOrderTimelineInput = z.input<typeof GetOrderTimelineInputSchema>;

export interface OrderTimelineEvent {
  __typename: "BasicEvent" | "CommentEvent";
  id: string;
  createdAt: string;
  action: string;
  message: string;
  rawMessage?: string | null;
  /** True only for BasicEvent with exact action === "mail_sent". Records sending activity; delivery is unknown. */
  isMailSent: boolean;
}

const GET_ORDER_TIMELINE_QUERY = gql`
  #graphql
  query GetOrderTimeline($id: ID!, $first: Int!, $after: String, $query: String, $reverse: Boolean) {
    order(id: $id) {
      id
      name
      note
      events(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: $reverse) {
        edges {
          node {
            __typename
            id
            createdAt
            action
            message
            ... on CommentEvent {
              rawMessage
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

export function normalizeOrderGid(orderId: string): string {
  const trimmed = orderId.trim();
  if (!ORDER_ID_REGEX.test(trimmed)) throw new Error(`Invalid orderId "${orderId}".`);
  return trimmed.startsWith("gid://shopify/Order/") ? trimmed : `gid://shopify/Order/${trimmed}`;
}

export const getOrderTimeline = {
  name: "get-order-timeline",
  description:
    "Get an order's timeline events (BasicEvent and staff CommentEvent) and current Order.note snapshot. BasicEvent with action 'mail_sent' records sending activity only; recipient delivery is unknown.",
  schema: GetOrderTimelineInputSchema,

  execute: async (rawInput: GetOrderTimelineInput, ctx: StoreContext) => {
    try {
      const input = GetOrderTimelineInputSchema.parse(rawInput);
      const id = normalizeOrderGid(input.orderId);
      const data = (await ctx.client.request(GET_ORDER_TIMELINE_QUERY, {
        id,
        first: input.limit,
        reverse: input.reverse,
        ...(input.after ? { after: input.after } : {}),
        ...(input.includeComments ? {} : { query: "comments:false" }),
      })) as {
        order?: {
          id?: unknown;
          name?: unknown;
          note?: string | null;
          events?: {
            edges?: Array<{ node?: Record<string, unknown> | null } | null> | null;
            pageInfo?: { hasNextPage?: unknown; endCursor?: string | null } | null;
          } | null;
        } | null;
      } | null;

      if (!data?.order || typeof data.order.id !== "string" || typeof data.order.name !== "string") {
        throw new Error(
          `Order not found or not visible: ${id} on store ${ctx.storeKey} (${ctx.domain}). Orders older than 60 days may not be visible without older-order permissions.`,
        );
      }

      const connection = data.order.events;
      if (!connection || !Array.isArray(connection.edges) || typeof connection.pageInfo?.hasNextPage !== "boolean") {
        throw new Error(`Malformed or missing events page in Shopify response for ${id}.`);
      }

      const cursor = CursorSchema.safeParse(connection.pageInfo.endCursor);
      const endCursor = cursor.success ? cursor.data : null;
      if (connection.pageInfo.hasNextPage && (!endCursor || endCursor === input.after)) {
        throw new Error(`Order timeline pagination for ${id} reported hasNextPage=true without a new endCursor.`);
      }

      const events: OrderTimelineEvent[] = connection.edges.map((edge) => {
        const node = edge?.node;
        const validRaw =
          node?.__typename !== "CommentEvent" || node.rawMessage == null || typeof node.rawMessage === "string";
        if (
          !node ||
          (node.__typename !== "BasicEvent" && node.__typename !== "CommentEvent") ||
          typeof node.id !== "string" ||
          typeof node.createdAt !== "string" ||
          typeof node.action !== "string" ||
          typeof node.message !== "string" ||
          !validRaw
        ) {
          throw new Error(`Malformed or null timeline event node in Shopify response for ${id}.`);
        }
        return {
          __typename: node.__typename,
          id: node.id,
          createdAt: node.createdAt,
          action: node.action,
          message: node.message,
          ...(node.__typename === "CommentEvent" ? { rawMessage: (node.rawMessage as string | null) ?? null } : {}),
          isMailSent: node.__typename === "BasicEvent" && node.action === "mail_sent",
        };
      });

      return {
        order: { id: data.order.id, name: data.order.name, currentNote: data.order.note ?? null },
        events,
        pageInfo: { hasNextPage: connection.pageInfo.hasNextPage, endCursor },
      };
    } catch (error) {
      handleToolError("fetch order timeline", error);
    }
  },
};
