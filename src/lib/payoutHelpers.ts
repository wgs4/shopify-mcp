/**
 * Shared helpers for Shopify Payments payout tools (Tools 1, 2, 4 in the
 * payout-reconciliation PRD). Pure functions — no I/O, no GraphQL client.
 *
 * The Shopify Admin API exposes payouts via `shopifyPaymentsAccount.payouts`
 * and the per-order detail via `shopifyPaymentsAccount.balanceTransactions`.
 * Both require the `read_shopify_payments_payouts` Custom App scope.
 *
 * Field-naming note: Shopify's `ShopifyPaymentsPayoutSummary` uses a few
 * counter-intuitive field names — `refundsFee` is the GROSS refund amount
 * (what was returned to customers), and `refundsFeeGross` is the fee
 * component on those refunds. We surface the full raw summary so callers
 * never have to guess, and we expose a normalized convenience view too.
 */

import type { ShopifyMoney } from "./toolUtils.js";

// ── Raw GraphQL node shapes ─────────────────────────────────────────────

export interface RawPayoutSummary {
  adjustmentsFee: ShopifyMoney;
  adjustmentsGross: ShopifyMoney;
  advanceFees: ShopifyMoney;
  advanceGross: ShopifyMoney;
  chargesFee: ShopifyMoney;
  chargesGross: ShopifyMoney;
  refundsFee: ShopifyMoney;
  refundsFeeGross: ShopifyMoney;
  reservedFundsFee: ShopifyMoney;
  reservedFundsGross: ShopifyMoney;
  retriedPayoutsFee: ShopifyMoney;
  retriedPayoutsGross: ShopifyMoney;
}

export interface RawPayoutNode {
  id: string;
  legacyResourceId: string;
  issuedAt: string;
  status: string;
  net: ShopifyMoney;
  summary: RawPayoutSummary;
}

export interface RawAssociatedOrder {
  id: string;
  name: string;
}

export interface RawBalanceTxnNode {
  id: string;
  type: string;
  amount: ShopifyMoney;
  fee: ShopifyMoney;
  net: ShopifyMoney;
  transactionDate: string;
  sourceId: string | number | null;
  sourceType: string | null;
  sourceOrderTransactionId: string | number | null;
  associatedOrder: RawAssociatedOrder | null;
  adjustmentReason: string | null;
}

// ── Normalized output shapes ────────────────────────────────────────────

export interface NormalizedPayoutSummary {
  charges_gross: number;
  charges_fee: number;
  refunds_gross: number; // == raw summary.refundsFee
  refunds_fee_recovered: number; // == raw summary.refundsFeeGross
  adjustments_gross: number;
  adjustments_fee: number;
  reserved_funds_gross: number;
  reserved_funds_fee: number;
  retried_payouts_gross: number;
  retried_payouts_fee: number;
  advance_gross: number;
  advance_fees: number;
}

export interface NormalizedPayout {
  id: string;
  legacy_resource_id: string;
  issued_at: string;
  status: string;
  currency: string;
  net: number;
  summary: NormalizedPayoutSummary;
  admin_url: string;
}

export interface NormalizedBalanceTxn {
  id: string;
  type: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  transaction_date: string;
  source_order: { id: string; name: string } | null;
  source_id: string | null;
  source_type: string | null;
  source_order_transaction_id: string | null;
  adjustment_reason: string | null;
}

export interface BreakdownTotals {
  charges_count: number;
  charges_gross: number;
  charges_fee: number;
  refunds_count: number;
  refunds_gross: number;
  refunds_fee: number;
  adjustments_count: number;
  adjustments_total: number;
  other_count: number;
  other_total: number;
  computed_net: number;
  reconciles: boolean;
  delta: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────

const RECONCILE_TOLERANCE = 0.005;

/**
 * Money is parsed into a JavaScript `number` rounded to 2 decimal places.
 * This assumes 2-decimal currencies (USD, CAD, EUR, GBP, etc.) — fine for the
 * intended WGS use case where all four stores transact in USD against USD
 * banks (see PRD §"Currency conversion"). If a 0-decimal currency (JPY) or
 * a 3-decimal currency (BHD, KWD) ever shows up, the rounding logic in
 * `computeBreakdownTotals` will silently truncate sub-unit precision. The
 * downstream xTuple writer (postgres-mcp Tool 3) is the place where a strict
 * `currencyCode === 'USD'` guard should hard-fail before posting.
 */
function parseMoney(money: ShopifyMoney | null | undefined): number {
  if (!money) return 0;
  const n = Number.parseFloat(money.amount);
  return Number.isFinite(n) ? n : 0;
}

function moneyCurrency(...candidates: Array<ShopifyMoney | null | undefined>): string {
  for (const m of candidates) {
    if (m?.currencyCode) return m.currencyCode;
  }
  return "USD";
}

function bigIntFieldToString(value: string | number | null): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/**
 * Resolve a payout id input (numeric legacy id, GID, or string of either)
 * into both the GID form (for `node(id:...)`) and the legacy numeric form
 * (for `balanceTransactions(query:"payout_id:N")`).
 *
 * Throws on input that cannot be parsed.
 */
export function parsePayoutId(input: string | number): {
  legacyId: string;
  gid: string;
} {
  if (input === null || input === undefined) {
    throw new Error("payout_id is required");
  }

  const raw = String(input).trim();
  if (!raw) {
    throw new Error("payout_id is required");
  }

  if (raw.startsWith("gid://shopify/ShopifyPaymentsPayout/")) {
    const legacy = raw.slice("gid://shopify/ShopifyPaymentsPayout/".length);
    if (!/^\d+$/.test(legacy)) {
      throw new Error(`Invalid payout GID: ${raw}`);
    }
    return { gid: raw, legacyId: legacy };
  }

  if (raw.startsWith("gid://")) {
    throw new Error(
      `Expected a ShopifyPaymentsPayout GID but got: ${raw}`,
    );
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `payout_id must be numeric or a ShopifyPaymentsPayout GID, got: ${raw}`,
    );
  }

  return {
    legacyId: raw,
    gid: `gid://shopify/ShopifyPaymentsPayout/${raw}`,
  };
}

/**
 * Build the Shopify connection `query` string for filtering payouts by date
 * window and optional status. Shopify's payout search supports:
 *   issued_at:>=YYYY-MM-DD  issued_at:<=YYYY-MM-DD  status:paid
 */
export function buildPayoutListQuery(args: {
  since?: string;
  until?: string;
  status?: string;
}): string | undefined {
  const parts: string[] = [];
  if (args.since) parts.push(`issued_at:>=${args.since}`);
  if (args.until) parts.push(`issued_at:<=${args.until}`);
  if (args.status) parts.push(`status:${args.status}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Build the canonical Shopify admin URL for a payout. */
export function buildPayoutAdminUrl(
  shopDomain: string,
  legacyId: string,
): string {
  return `https://${shopDomain}/admin/payments/payouts/${legacyId}`;
}

function formatPayoutSummary(raw: RawPayoutSummary): NormalizedPayoutSummary {
  return {
    charges_gross: parseMoney(raw.chargesGross),
    charges_fee: parseMoney(raw.chargesFee),
    refunds_gross: parseMoney(raw.refundsFee),
    refunds_fee_recovered: parseMoney(raw.refundsFeeGross),
    adjustments_gross: parseMoney(raw.adjustmentsGross),
    adjustments_fee: parseMoney(raw.adjustmentsFee),
    reserved_funds_gross: parseMoney(raw.reservedFundsGross),
    reserved_funds_fee: parseMoney(raw.reservedFundsFee),
    retried_payouts_gross: parseMoney(raw.retriedPayoutsGross),
    retried_payouts_fee: parseMoney(raw.retriedPayoutsFee),
    advance_gross: parseMoney(raw.advanceGross),
    advance_fees: parseMoney(raw.advanceFees),
  };
}

/** Normalize a raw GraphQL payout node into the output shape. */
export function formatPayoutNode(
  node: RawPayoutNode,
  shopDomain: string,
): NormalizedPayout {
  const currency = moneyCurrency(
    node.net,
    node.summary?.chargesGross,
    node.summary?.refundsFee,
  );
  return {
    id: node.id,
    legacy_resource_id: node.legacyResourceId,
    issued_at: node.issuedAt,
    status: node.status,
    currency,
    net: parseMoney(node.net),
    summary: formatPayoutSummary(node.summary),
    admin_url: buildPayoutAdminUrl(shopDomain, node.legacyResourceId),
  };
}

/** Normalize a raw balance-transaction node into the output shape. */
export function formatBalanceTxnNode(
  node: RawBalanceTxnNode,
): NormalizedBalanceTxn {
  const source_order = node.associatedOrder
    ? { id: node.associatedOrder.id, name: node.associatedOrder.name }
    : null;

  return {
    id: node.id,
    type: node.type,
    amount: parseMoney(node.amount),
    fee: parseMoney(node.fee),
    net: parseMoney(node.net),
    currency: moneyCurrency(node.amount, node.net, node.fee),
    transaction_date: node.transactionDate,
    source_order,
    source_id: bigIntFieldToString(node.sourceId),
    source_type: node.sourceType,
    source_order_transaction_id: bigIntFieldToString(
      node.sourceOrderTransactionId,
    ),
    adjustment_reason: node.adjustmentReason,
  };
}

/**
 * Sum and bucket balance-transaction net/gross/fee figures, and compare the
 * computed payout net against the payout-side `net` field as a sanity check.
 *
 * `reconciles` will be false (and `delta` non-zero) when balanceTransactions
 * was truncated (e.g. > transactions_limit). Callers should surface that to
 * the user rather than silently trust the partial total.
 */
export function computeBreakdownTotals(
  txns: NormalizedBalanceTxn[],
  payoutNet: number,
): BreakdownTotals {
  let charges_count = 0;
  let charges_gross = 0;
  let charges_fee = 0;
  let refunds_count = 0;
  let refunds_gross = 0;
  let refunds_fee = 0;
  let adjustments_count = 0;
  let adjustments_total = 0;
  let other_count = 0;
  let other_total = 0;
  let computed_net = 0;

  for (const t of txns) {
    computed_net += t.net;
    const txnType = (t.type || "").toLowerCase();
    if (txnType === "charge") {
      charges_count += 1;
      charges_gross += t.amount;
      charges_fee += t.fee;
    } else if (txnType === "refund") {
      refunds_count += 1;
      refunds_gross += t.amount;
      refunds_fee += t.fee;
    } else if (txnType === "adjustment") {
      adjustments_count += 1;
      adjustments_total += t.net;
    } else {
      other_count += 1;
      other_total += t.net;
    }
  }

  const delta = round2(computed_net - payoutNet);
  return {
    charges_count,
    charges_gross: round2(charges_gross),
    charges_fee: round2(charges_fee),
    refunds_count,
    refunds_gross: round2(refunds_gross),
    refunds_fee: round2(refunds_fee),
    adjustments_count,
    adjustments_total: round2(adjustments_total),
    other_count,
    other_total: round2(other_total),
    computed_net: round2(computed_net),
    reconciles: Math.abs(delta) < RECONCILE_TOLERANCE,
    delta,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Error helpers ───────────────────────────────────────────────────────

/**
 * Wrap GraphQL errors so that the missing-scope case ("Access denied for
 * shopifyPaymentsAccount field") surfaces as an actionable message rather
 * than a raw GraphQL dump.
 */
export function explainPayoutAccessError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("shopifyPaymentsAccount") &&
    (message.includes("Access denied") || message.includes("ACCESS_DENIED"))
  ) {
    return new Error(
      "Shopify Payments payouts API is not accessible. The Custom App is missing the `read_shopify_payments_payouts` scope. " +
        "Grant it in Shopify admin → Settings → Apps and sales channels → Develop apps → (this app) → Configure Admin API scopes, " +
        "then restart the MCP server so the token exchange picks up the new scope.",
    );
  }
  return err instanceof Error ? err : new Error(message);
}
