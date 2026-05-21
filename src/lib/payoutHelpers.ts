/**
 * Shared helpers for Shopify Payments payout tools (Tools 1, 2, 4 in the
 * payout-reconciliation PRD). Pure functions — no I/O, no GraphQL client.
 * The pagination loader that DOES need a client lives in
 * `balanceTransactionsLoader.ts` so this file stays trivially testable.
 *
 * The Shopify Admin API exposes payouts via `shopifyPaymentsAccount.payouts`
 * and the per-order detail via `shopifyPaymentsAccount.balanceTransactions`.
 * Both require the `read_shopify_payments_payouts` Custom App scope and the
 * parent `read_shopify_payments_accounts` scope.
 *
 * Field-naming note: Shopify's `ShopifyPaymentsPayoutSummary` uses a few
 * counter-intuitive field names — `refundsFee` is the GROSS refund amount
 * (what was returned to customers), and `refundsFeeGross` is the fee
 * component on those refunds. We surface the full raw summary so callers
 * never have to guess, and we expose a normalized convenience view too.
 *
 * Classification note: balance_transactions get bucketed by `type` into
 * named buckets (`charges`, `refunds`, `adjustments`, `transfers`, `disputes`,
 * `fee_refunds`) plus a catch-all `other`. `TRANSFER` rows are Shopify
 * Payments' internal reserve/release moves — they DO count toward
 * `payout.net` (so `computed_net` includes them, preserving the
 * "line items match bank-reported total" reconcile semantic), but they are
 * surfaced as their own visible bucket and excluded from
 * `customer_revenue_net` (the "real customer money" view).
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

/** Reconciliation status — see `buildReconciliationNotes` for prose form. */
export type ReconciliationStatus = "reconciled" | "unreconciled" | "partial";

/**
 * Context for `computeBreakdownTotals` so it can distinguish "fully fetched
 * and didn't reconcile" (a real data quality issue) from "partial data,
 * reconciliation not evaluable" (just a pagination cap).
 */
export interface ReconcileContext {
  /** True when more pages exist that we didn't fetch (caller paged manually OR loop hit cap). */
  truncated: boolean;
  /** True when auto-pagination stopped because it hit `max_transactions`. */
  capped: boolean;
  /** Total transactions actually fetched and included in the totals. */
  fetched: number;
  /** Max-transactions cap value (when capped=true), for the note. */
  max_transactions?: number;
}

export interface BreakdownTotals {
  // ── Charges ─────────────────────────────────────────
  charges_count: number;
  charges_gross: number;
  charges_fee: number;

  // ── Refunds ─────────────────────────────────────────
  refunds_count: number;
  refunds_gross: number;
  refunds_fee: number;

  // ── Adjustments ────────────────────────────────────
  adjustments_count: number;
  adjustments_total: number;

  // ── Transfers (NEW: Shopify Payments internal reserve/release moves) ─
  transfers_count: number;
  transfers_total: number;

  // ── Disputes (NEW: chargeback-related ledger entries) ────────────────
  disputes_count: number;
  disputes_total: number;

  // ── Fee refunds (NEW: refunds of previously-charged Shopify fees) ────
  fee_refunds_count: number;
  fee_refunds_total: number;

  // ── Payout debits (NEW: the inverse ledger entry that DRAWS DOWN the
  //    account on payout). Excluded from `computed_net` because it IS the
  //    inverse of `payout.net` — including it would always zero out and the
  //    reconcile check would lose its meaning.
  payouts_count: number;
  payouts_total: number;

  // ── Other (catch-all for forward-compat with unknown enum values) ────
  other_count: number;
  other_total: number;

  // ── Aggregate views ─────────────────────────────────────────────────
  /** Sum of net across all bucketed txns; matches `payout.net` when complete. */
  computed_net: number;
  /**
   * "Real customer money" view: charges + refunds + disputes + fee_refunds +
   * adjustments. Excludes transfers (internal reserve moves) and `other`.
   */
  customer_revenue_net: number;
  /** computed_net - payout.net. Signed; zero means reconciled. */
  delta: number;
  /** Legacy back-compat flag — true iff reconciliation_status === "reconciled". */
  reconciles: boolean;
  /** "reconciled" | "unreconciled" | "partial" — see buildReconciliationNotes. */
  reconciliation_status: ReconciliationStatus;
  /** Plain-English explanations of the reconciliation outcome. */
  reconciliation_notes: string[];
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
 * Sum and bucket balance-transaction figures, then compare the computed
 * line-item sum against the payout-side `net` to produce a reconciliation
 * status + plain-English notes.
 *
 * `computed_net` includes ALL txn types (including TRANSFER) because that's
 * what Shopify's `payout.net` field is summed from. Excluding TRANSFER would
 * break the reconcile check for any store with rolling reserves.
 *
 * `customer_revenue_net` is the "real customer money" view: it excludes
 * TRANSFER (internal reserve moves) and `other` (forward-compat catch-all).
 *
 * `reconciliation_status` rules:
 *   - "partial"      — context.truncated true (more pages exist or we hit cap).
 *                      Cannot evaluate reconciliation against incomplete data.
 *   - "reconciled"   — full data, `|computed_net - payout.net| < tolerance`.
 *   - "unreconciled" — full data, delta exceeds tolerance.
 */
export function computeBreakdownTotals(
  txns: NormalizedBalanceTxn[],
  payoutNet: number,
  context?: ReconcileContext,
): BreakdownTotals {
  let charges_count = 0;
  let charges_gross = 0;
  let charges_fee = 0;
  let refunds_count = 0;
  let refunds_gross = 0;
  let refunds_fee = 0;
  let adjustments_count = 0;
  let adjustments_total = 0;
  let transfers_count = 0;
  let transfers_total = 0;
  let disputes_count = 0;
  let disputes_total = 0;
  let fee_refunds_count = 0;
  let fee_refunds_total = 0;
  let payouts_count = 0;
  let payouts_total = 0;
  let other_count = 0;
  let other_total = 0;
  let computed_net = 0;
  let customer_revenue_net = 0;

  for (const t of txns) {
    const txnType = (t.type || "").toLowerCase();
    switch (txnType) {
      case "charge":
        charges_count += 1;
        charges_gross += t.amount;
        charges_fee += t.fee;
        customer_revenue_net += t.net;
        computed_net += t.net;
        break;
      case "refund":
        refunds_count += 1;
        refunds_gross += t.amount;
        refunds_fee += t.fee;
        customer_revenue_net += t.net;
        computed_net += t.net;
        break;
      case "adjustment":
        adjustments_count += 1;
        adjustments_total += t.net;
        customer_revenue_net += t.net;
        computed_net += t.net;
        break;
      case "transfer":
        transfers_count += 1;
        transfers_total += t.net;
        // counted toward payout net (Shopify includes them) but not toward
        // customer_revenue_net — they're internal reserve moves.
        computed_net += t.net;
        break;
      case "dispute":
        disputes_count += 1;
        disputes_total += t.net;
        customer_revenue_net += t.net;
        computed_net += t.net;
        break;
      case "fee_refund":
        fee_refunds_count += 1;
        fee_refunds_total += t.net;
        customer_revenue_net += t.net;
        computed_net += t.net;
        break;
      case "payout":
        // The PAYOUT-type balance_transaction is the inverse ledger entry of
        // the payout itself (its net == -payout.net). It zeros the account
        // balance after the payout completes. Excluded from `computed_net` so
        // the reconcile check "line items sum to payout.net" stays meaningful.
        payouts_count += 1;
        payouts_total += t.net;
        break;
      default:
        other_count += 1;
        other_total += t.net;
        // Counted in computed_net so unclassified entries show up as a delta
        // until we explicitly classify them.
        computed_net += t.net;
    }
  }

  const delta = round2(computed_net - payoutNet);

  let reconciliation_status: ReconciliationStatus;
  if (context?.truncated) {
    reconciliation_status = "partial";
  } else if (Math.abs(delta) < RECONCILE_TOLERANCE) {
    reconciliation_status = "reconciled";
  } else {
    reconciliation_status = "unreconciled";
  }

  const totals: Omit<BreakdownTotals, "reconciliation_notes"> = {
    charges_count,
    charges_gross: round2(charges_gross),
    charges_fee: round2(charges_fee),
    refunds_count,
    refunds_gross: round2(refunds_gross),
    refunds_fee: round2(refunds_fee),
    adjustments_count,
    adjustments_total: round2(adjustments_total),
    transfers_count,
    transfers_total: round2(transfers_total),
    disputes_count,
    disputes_total: round2(disputes_total),
    fee_refunds_count,
    fee_refunds_total: round2(fee_refunds_total),
    payouts_count,
    payouts_total: round2(payouts_total),
    other_count,
    other_total: round2(other_total),
    computed_net: round2(computed_net),
    customer_revenue_net: round2(customer_revenue_net),
    delta,
    reconciles: reconciliation_status === "reconciled",
    reconciliation_status,
  };

  return {
    ...totals,
    reconciliation_notes: buildReconciliationNotes(totals, {
      payoutNet,
      context,
    }),
  };
}

/**
 * Produce human-readable explanations of why a payout reconciled (or didn't).
 * Caller can also invoke this independently with custom totals if needed.
 */
export function buildReconciliationNotes(
  totals: Omit<BreakdownTotals, "reconciliation_notes">,
  opts: { payoutNet: number; context?: ReconcileContext } = { payoutNet: 0 },
): string[] {
  const notes: string[] = [];
  const ctx = opts.context;
  const txnLabel = (n: number) => (n === 1 ? "1 transaction" : `${n} transactions`);

  // Lead with the headline reconciliation outcome.
  if (totals.reconciliation_status === "reconciled") {
    notes.push(
      `Reconciled: line-item sum matches Shopify payout net (delta $${totals.delta.toFixed(
        2,
      )}).`,
    );
  } else if (totals.reconciliation_status === "partial") {
    if (ctx?.capped && ctx?.max_transactions !== undefined) {
      notes.push(
        `Partial data: ${ctx.fetched} transactions fetched, hit max_transactions cap of ${ctx.max_transactions}. ` +
          `Reconciliation cannot be evaluated against incomplete data — raise max_transactions or page manually via transactions_after.`,
      );
    } else if (ctx?.truncated) {
      notes.push(
        `Partial data: ${ctx.fetched} transactions fetched, more pages exist. ` +
          `Pass auto_paginate=true (default) or page manually via transactions_after to fetch the rest.`,
      );
    } else {
      // Fallback when caller didn't provide context but status is partial.
      notes.push(
        "Partial data: not all transactions were fetched. Reconciliation cannot be evaluated.",
      );
    }
  } else {
    notes.push(
      `Unreconciled: $${Math.abs(totals.delta).toFixed(2)} ${
        totals.delta < 0 ? "short" : "over"
      } against Shopify payout net (computed_net $${totals.computed_net.toFixed(
        2,
      )} vs payout.net $${opts.payoutNet.toFixed(2)}). ` +
        "Check the `other` bucket for unclassified transaction types.",
    );
  }

  // Then surface the visible-but-non-customer-revenue buckets so the reader
  // understands why customer_revenue_net differs from computed_net.
  if (totals.transfers_count > 0) {
    notes.push(
      `Includes $${Math.abs(totals.transfers_total).toFixed(2)} across ${txnLabel(
        totals.transfers_count,
      )} of type TRANSFER (Shopify Payments internal reserve/release movements — counted toward payout net but not toward customer_revenue_net).`,
    );
  }

  if (totals.disputes_count > 0) {
    notes.push(
      `Includes ${txnLabel(totals.disputes_count)} of type DISPUTE totaling $${totals.disputes_total.toFixed(
        2,
      )} (chargeback ledger entries).`,
    );
  }

  if (totals.fee_refunds_count > 0) {
    notes.push(
      `Includes ${txnLabel(totals.fee_refunds_count)} of type FEE_REFUND totaling $${totals.fee_refunds_total.toFixed(
        2,
      )} (refunds of previously-charged Shopify fees).`,
    );
  }

  if (totals.payouts_count > 0) {
    notes.push(
      `Excludes ${txnLabel(totals.payouts_count)} of type PAYOUT totaling $${totals.payouts_total.toFixed(
        2,
      )} from computed_net — this is the inverse ledger entry of the payout itself (Shopify's debit against the account balance), not a contribution to the payout amount.`,
    );
  }

  if (totals.other_count > 0) {
    notes.push(
      `${txnLabel(totals.other_count)} fell into the catch-all \`other\` bucket totaling $${totals.other_total.toFixed(
        2,
      )} — these are Shopify balance_transaction types not explicitly classified. Inspect each via the response's balance_transactions list.`,
    );
  }

  return notes;
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
