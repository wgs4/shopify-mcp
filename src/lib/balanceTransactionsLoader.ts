/**
 * Pagination loader for Shopify Payments balance_transactions.
 * Separated from `payoutHelpers.ts` so that file can stay pure / I/O-free.
 *
 * ⚠️  Why REST and not GraphQL?
 *
 * The GraphQL `shopifyPaymentsAccount.balanceTransactions(query: "payout_id:N")`
 * connection silently ignores the `payout_id` filter — Shopify returns
 * `warnings: [{field:"payout_id", code:"invalid_field"}]` in the response
 * extensions and serves the entire account history instead. PR #2 used that
 * connection and only fetched the first 250 rows, which made it look correct
 * for tiny payouts but silently broken for any payout that exceeded one page.
 * The REST endpoint /admin/api/{v}/shopify_payments/balance/transactions.json
 * accepts `payout_id` as a real query parameter, filters server-side, and
 * paginates via the standard Link header (`rel="next"`).
 *
 * If/when Shopify makes payout filtering work on the GraphQL connection, we
 * can switch back. Until then REST is the only correct path.
 *
 * Order name enrichment: REST gives us the legacy `source_order_id` but not
 * the display name (e.g. "#29876"). To preserve the PR #2 response shape, we
 * make a follow-up batched GraphQL `nodes(ids: [...])` call (up to 250 ids
 * per batch) when the caller opts in.
 */

import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";
import {
  type NormalizedBalanceTxn,
} from "./payoutHelpers.js";

// ── REST response shape ────────────────────────────────────────────────

interface RestBalanceTxn {
  id: number;
  type: string; // lowercase: "charge" | "refund" | "transfer" | "payout" | "fee_refund" | etc.
  test: boolean;
  payout_id: number;
  payout_status: string;
  currency: string;
  amount: string;
  fee: string;
  net: string;
  source_id: number | null;
  source_type: string | null;
  source_order_id: number | null;
  source_order_transaction_id: number | null;
  processed_at: string;
  adjustment_order_transactions: unknown;
  adjustment_reason: string | null;
}

interface RestBalanceTxnsResponse {
  transactions: RestBalanceTxn[];
}

// ── Public API ─────────────────────────────────────────────────────────

export interface FetchBalanceTransactionsOptions {
  /** Legacy numeric payout id (used as the `payout_id` REST query parameter). */
  legacyPayoutId: string;
  /** Per-page size (Shopify REST allows up to 250). */
  pageSize: number;
  /** Hard cap on total transactions collected across all pages. */
  maxTransactions: number;
  /** If false, fetch a single REST page only (back-compat with PR #2 behavior). */
  autoPaginate: boolean;
  /**
   * Optional REST page-info cursor (the opaque `page_info` query param in
   * Shopify's Link-header URLs). When provided, the loader starts from this
   * cursor instead of the beginning.
   */
  startCursor?: string;
  /**
   * If true, do one or more batched GraphQL `nodes(ids: [...])` lookups to
   * fill in `source_order.name` on each transaction. Off by default for
   * minimal cost; the get-payout tool opts in.
   */
  includeOrderNames?: boolean;
}

export interface FetchBalanceTransactionsResult {
  transactions: NormalizedBalanceTxn[];
  /** True if more pages exist that we did not fetch. */
  truncated: boolean;
  /** True if auto-pagination stopped because it hit `maxTransactions`. */
  capped: boolean;
  /** Number of REST roundtrips made. */
  fetched_pages: number;
  /** Last REST `page_info` cursor seen — caller can resume from here if truncated. */
  end_cursor: string | null;
  /** Convenience flag: equals `truncated` (kept for parity with GraphQL pageInfo shape). */
  has_next_page: boolean;
}

const DEFAULT_API_VERSION = "2026-01";

/**
 * Walk REST balance_transactions pages until the Link header has no `rel="next"`,
 * the cap is hit, or `autoPaginate=false` stops us after the first page.
 */
export async function fetchBalanceTransactions(
  graphqlClient: GraphQLClient,
  opts: FetchBalanceTransactionsOptions,
): Promise<FetchBalanceTransactionsResult> {
  if (opts.maxTransactions <= 0) {
    throw new Error("maxTransactions must be > 0");
  }
  if (opts.pageSize <= 0) {
    throw new Error("pageSize must be > 0");
  }

  const domain = process.env.MYSHOPIFY_DOMAIN;
  if (!domain) {
    throw new Error(
      "MYSHOPIFY_DOMAIN environment variable is not set — cannot build REST URL",
    );
  }
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error(
      "SHOPIFY_ACCESS_TOKEN environment variable is not set — auth not initialized",
    );
  }
  const apiVersion = process.env.SHOPIFY_API_VERSION ?? DEFAULT_API_VERSION;

  const transactions: NormalizedBalanceTxn[] = [];
  let nextUrl: string | null = buildInitialUrl({
    domain,
    apiVersion,
    legacyPayoutId: opts.legacyPayoutId,
    pageSize: opts.pageSize,
    startCursor: opts.startCursor,
  });

  let fetchedPages = 0;
  let lastEndCursor: string | null = opts.startCursor ?? null;
  let truncated = false;
  let capped = false;
  const expectedPayoutIdNum = Number.parseInt(opts.legacyPayoutId, 10);
  if (!Number.isFinite(expectedPayoutIdNum)) {
    throw new Error(
      `Invalid legacyPayoutId for REST query: ${opts.legacyPayoutId}`,
    );
  }

  // Guards: detect repeated cursors and zero-progress pages so a misbehaving
  // Shopify response can't drive an infinite loop or duplicate-row inflation.
  const seenCursors = new Set<string>();
  if (opts.startCursor) seenCursors.add(opts.startCursor);

  while (nextUrl) {
    const remaining = opts.maxTransactions - transactions.length;
    if (remaining <= 0) {
      truncated = true;
      capped = true;
      break;
    }

    // Honor the remaining-cap as the page limit on subsequent pages where the
    // remaining-budget is smaller than pageSize. Note: rewriting the limit on
    // the Link-provided URL is fine because the page_info cursor encodes its
    // own size; trimming `limit` smaller than the original is supported.
    const effectiveUrl = applyLimit(nextUrl, Math.min(opts.pageSize, remaining));

    const res = await fetch(effectiveUrl, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Shopify REST balance/transactions request failed (${res.status}): ${body.slice(0, 500)}`,
      );
    }

    fetchedPages += 1;
    const data = (await res.json()) as RestBalanceTxnsResponse;

    // Defensive: Shopify shouldn't ever return a non-array, but trust nothing.
    if (!Array.isArray(data?.transactions)) {
      throw new Error(
        "Shopify REST balance/transactions returned unexpected shape (missing `transactions` array)",
      );
    }

    // Validate every row belongs to the requested payout. If Shopify ever
    // misroutes or the caller-supplied cursor was from a different payout,
    // this hard-fails rather than silently mixing books.
    const beforeLen = transactions.length;
    for (const t of data.transactions) {
      if (t.payout_id !== expectedPayoutIdNum) {
        throw new Error(
          `Shopify REST returned a transaction (id ${t.id}) with payout_id ${t.payout_id} but we asked for payout_id ${expectedPayoutIdNum}. Refusing to mix books.`,
        );
      }
      transactions.push(restTxnToNormalized(t));
      if (transactions.length >= opts.maxTransactions) break;
    }
    const pageRowsAdded = transactions.length - beforeLen;

    const linkHeader = res.headers.get("link") ?? res.headers.get("Link");
    const nextLink = parseNextLink(linkHeader);

    if (nextLink) {
      lastEndCursor = extractPageInfo(nextLink);
    }

    // No-progress guard: a Link-next that returned zero new rows would loop
    // forever. Treat as truncated and break.
    if (nextLink && pageRowsAdded === 0) {
      truncated = true;
      capped = false;
      break;
    }

    if (!nextLink) {
      // No more pages.
      truncated = false;
      capped = false;
      nextUrl = null;
      break;
    }

    if (!opts.autoPaginate) {
      truncated = true;
      capped = false;
      break;
    }

    if (transactions.length >= opts.maxTransactions) {
      truncated = true;
      capped = true;
      break;
    }

    // Repeated-cursor guard: if Shopify's Link header points back to a cursor
    // we've already followed, abort rather than spin.
    const nextCursor = extractPageInfo(nextLink);
    if (nextCursor && seenCursors.has(nextCursor)) {
      throw new Error(
        `Shopify REST returned a repeated page_info cursor (${nextCursor}) — refusing to loop. ` +
          "Likely a Shopify-side bug; retry the request or page manually.",
      );
    }
    if (nextCursor) seenCursors.add(nextCursor);

    nextUrl = nextLink;
  }

  if (opts.includeOrderNames) {
    await enrichOrderNames(graphqlClient, transactions);
  }

  return {
    transactions,
    truncated,
    capped,
    fetched_pages: fetchedPages,
    end_cursor: lastEndCursor,
    has_next_page: truncated,
  };
}

// ── REST → normalized conversion ─────────────────────────────────────

function restTxnToNormalized(t: RestBalanceTxn): NormalizedBalanceTxn {
  const orderIdNum = t.source_order_id;
  const source_order =
    orderIdNum != null
      ? {
          // Shopify Admin GIDs for orders use the legacy id directly.
          id: `gid://shopify/Order/${orderIdNum}`,
          // Name is filled in by enrichOrderNames when opted in; otherwise null
          // so the field shape is stable across both modes.
          name: "",
        }
      : null;

  return {
    id: `gid://shopify/ShopifyPaymentsBalanceTransaction/${t.id}`,
    type: t.type,
    amount: parseMoney(t.amount),
    fee: parseMoney(t.fee),
    net: parseMoney(t.net),
    currency: t.currency,
    transaction_date: t.processed_at,
    source_order,
    source_id: t.source_id != null ? String(t.source_id) : null,
    source_type: t.source_type,
    source_order_transaction_id:
      t.source_order_transaction_id != null
        ? String(t.source_order_transaction_id)
        : null,
    adjustment_reason: t.adjustment_reason,
  };
}

function parseMoney(s: string | null | undefined): number {
  if (s == null) return 0;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// ── URL + Link header helpers ─────────────────────────────────────────

function buildInitialUrl(args: {
  domain: string;
  apiVersion: string;
  legacyPayoutId: string;
  pageSize: number;
  startCursor?: string;
}): string {
  const base = `https://${args.domain}/admin/api/${args.apiVersion}/shopify_payments/balance/transactions.json`;
  const params = new URLSearchParams();
  params.set("limit", String(args.pageSize));
  if (args.startCursor) {
    // page_info already encodes the payout_id; including a literal payout_id
    // alongside is redundant and Shopify rejects most combinations of the two.
    params.set("page_info", args.startCursor);
  } else {
    params.set("payout_id", args.legacyPayoutId);
  }
  return `${base}?${params.toString()}`;
}

function applyLimit(url: string, limit: number): string {
  const u = new URL(url);
  u.searchParams.set("limit", String(limit));
  return u.toString();
}

/** Parse the Shopify Link header and return the `rel="next"` URL if present. */
export function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  // Header format: <url1>; rel="prev", <url2>; rel="next"
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?([^",;]+)"?/);
    if (match && match[2].trim() === "next") {
      return match[1];
    }
  }
  return null;
}

function extractPageInfo(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("page_info");
  } catch {
    return null;
  }
}

// ── Order name enrichment ─────────────────────────────────────────────

const ORDER_NAME_BATCH = 250;

const ORDER_NODES_QUERY = gql`
  #graphql

  query PayoutOrderNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
      }
    }
  }
`;

async function enrichOrderNames(
  client: GraphQLClient,
  txns: NormalizedBalanceTxn[],
): Promise<void> {
  const idSet = new Set<string>();
  for (const t of txns) {
    if (t.source_order?.id) idSet.add(t.source_order.id);
  }
  if (idSet.size === 0) return;

  const ids = Array.from(idSet);
  const idToName = new Map<string, string>();

  for (let i = 0; i < ids.length; i += ORDER_NAME_BATCH) {
    const batch = ids.slice(i, i + ORDER_NAME_BATCH);
    const data = (await client.request(ORDER_NODES_QUERY, { ids: batch })) as {
      nodes: Array<{ id: string; name?: string } | null>;
    };
    for (const node of data.nodes) {
      if (node && node.id && node.name) {
        idToName.set(node.id, node.name);
      }
    }
  }

  for (const t of txns) {
    if (t.source_order && idToName.has(t.source_order.id)) {
      t.source_order.name = idToName.get(t.source_order.id) ?? "";
    }
  }
}
