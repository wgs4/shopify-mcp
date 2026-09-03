/**
 * 60-day order visibility wall.
 *
 * Why this exists: an app token with `read_orders` and without
 * `read_all_orders` only sees the last 60 days of orders. Older orders
 * vanish silently (HTTP 200, empty edges, no errors). Bulk operations
 * obey the same wall. A list tool that forwards a `created_at:>=2024-01-01`
 * query would return a convincing empty (or partial) set and the MCP host
 * would treat it as truth. We fail closed instead.
 *
 * Horizon comparisons are instant-to-instant (Date.parse on ISO strings).
 * Shop-local dates are display-only (horizon_shop_date). Bare YYYY-MM-DD
 * predicates are parsed as UTC midnight, so first_visible_date is the
 * earliest bare date the guard accepts (UTC midnight >= horizon).
 *
 * Pipelines:
 *
 *   nowMs - 60d ------------------------------- horizon ISO
 *                                                |
 *   scopes includes read_all_orders? --yes----> allow (complete)
 *         | no
 *         v
 *   query / sinceIso
 *         |
 *         +-- no date predicates -------------> allow (partial; caller warned)
 *         +-- cannot prove completeness -------> throw visibility_indeterminate
 *         +-- created_at lower < horizon -----> throw before_horizon
 *         \-- created_at lower >= horizon ----> allow (partial but in-window)
 *
 * analyzeDatePredicates never throws. guardOrderQuery throws ScopeHorizonError
 * whose message is self-contained (the MCP host relays only error.message).
 */

import { isValidDate, localDate, nextDay } from "./shopTime.js";

export const ORDER_WALL_DAYS = 60 as const;
export const READ_ALL_ORDERS = "read_all_orders";

const MS_PER_DAY = 86_400_000;
const ASK_SCOPE_PREFIX =
  "Earliest accepted bound: created_at:>=";

const YEAR_RE = /^\d{4}$/;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const PREDICATE_RE =
  /(?<![A-Za-z0-9_])(created_at|processed_at|updated_at)\s*:\s*(>=|<=|>|<)?\s*("[^"]*"|'[^']*'|[^\s]+)?/gi;

export type DatePredicateField = "created_at" | "processed_at" | "updated_at";
export type DatePredicateOp = ">=" | ">" | "<=" | "<" | "=" | "range";
export type ScopeHorizonReason = "before_horizon" | "visibility_indeterminate";

export interface DatePredicate {
  field: DatePredicateField;
  op: DatePredicateOp;
  raw: string;
  lower: string | null;
  upper: string | null;
  negated: boolean;
  malformed: boolean;
}

export interface DatePredicateAnalysis {
  predicates: DatePredicate[];
  hasOr: boolean;
  /** Latest (AND) lower bound from non-negated created_at predicates. */
  createdAtLowerIso: string | null;
  indeterminate: boolean;
  indeterminateReasons: string[];
}

export interface DateBounds {
  lower: string | null;
  upper: string | null;
  fields: string[];
}

export interface HorizonInfo {
  wall_days: 60;
  horizon: string;
  horizon_shop_date: string | null;
  first_visible_date: string;
  scope_missing: "read_all_orders" | null;
}

export interface Completeness {
  status: "complete" | "partial";
  reason: "read_all_orders_missing" | null;
  visible_from: string | null;
}

export interface ScopeHorizonErrorArgs {
  missing: string;
  horizon: string;
  horizonShopDate?: string | null;
  requestedSince?: string | null;
  requestedUntil?: string | null;
  reason: ScopeHorizonReason;
  visibleFrom?: string;
}

type ParsedToken =
  | { kind: "instant"; ms: number }
  | { kind: "period"; startMs: number; endMs: number; nextStartMs: number };

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function hasReadAllOrders(scopes: string[]): boolean {
  return scopes.includes(READ_ALL_ORDERS);
}

/**
 * First YYYY-MM-DD whose UTC midnight is >= the horizon instant.
 * Exact 00:00:00.000Z uses that date; any later time of day uses the next
 * UTC calendar date. Bare Shopify date predicates parse as UTC midnight,
 * so this is the earliest `created_at:>=YYYY-MM-DD` the guard accepts.
 */
export function firstVisibleDate(horizonIso: string): string {
  const ms = Date.parse(horizonIso);
  if (!Number.isFinite(ms)) {
    return horizonIso.slice(0, 10);
  }
  const utc = new Date(ms).toISOString();
  const date = utc.slice(0, 10);
  if (utc.slice(11) === "00:00:00.000Z") {
    return date;
  }
  const midnightMs = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(midnightMs + MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Concrete, guard-accepted lower-bound advice. ScopeHorizonError messages
 * (and the product-history indeterminate override) must end with this.
 */
export function earliestAcceptedBoundAdvice(horizonIso: string): string {
  const date = firstVisibleDate(horizonIso);
  return (
    `${ASK_SCOPE_PREFIX}${date} (or created_at:>='${horizonIso}'). ` +
    `Request read_all_orders for app shop-wgs-mcp-8-6-26 to see older orders.`
  );
}

function buildScopeHorizonMessage(args: ScopeHorizonErrorArgs): string {
  const shop = args.horizonShopDate
    ? ` (shop date ${args.horizonShopDate})`
    : "";
  const since = args.requestedSince ?? "null";
  const until = args.requestedUntil ?? "null";
  const advice = earliestAcceptedBoundAdvice(args.horizon);
  if (args.reason === "visibility_indeterminate") {
    return (
      `ScopeHorizonError: the query mentions order dates in a way that cannot prove the result is complete ` +
      `(visible from ${args.horizon}${shop}). ` +
      advice
    );
  }
  return (
    `ScopeHorizonError: orders before ${args.horizon}${shop} are not visible without ${args.missing}. ` +
    `Requested since=${since} until=${until}. ` +
    advice
  );
}

export class ScopeHorizonError extends Error {
  name = "ScopeHorizonError";
  code = "SCOPE_HORIZON";
  missing: string;
  horizon: string;
  horizonShopDate: string | null;
  requestedSince: string | null;
  requestedUntil: string | null;
  reason: ScopeHorizonReason;
  visibleFrom: string;

  constructor(args: ScopeHorizonErrorArgs) {
    super(buildScopeHorizonMessage(args));
    this.name = "ScopeHorizonError";
    this.missing = args.missing;
    this.horizon = args.horizon;
    this.horizonShopDate = args.horizonShopDate ?? null;
    this.requestedSince = args.requestedSince ?? null;
    this.requestedUntil = args.requestedUntil ?? null;
    this.reason = args.reason;
    this.visibleFrom = args.visibleFrom ?? args.horizon;
  }
}

/** ISO instant `nowMs - 60 days`. */
export function computeHorizon(nowMs: number = Date.now()): string {
  return toIso(nowMs - ORDER_WALL_DAYS * MS_PER_DAY);
}

export function horizonInfo(
  scopes: string[],
  nowMs?: number,
  tz?: string,
): HorizonInfo {
  const horizon = computeHorizon(nowMs ?? Date.now());
  return {
    wall_days: ORDER_WALL_DAYS,
    horizon,
    horizon_shop_date: tz ? localDate(horizon, tz) : null,
    first_visible_date: firstVisibleDate(horizon),
    scope_missing: hasReadAllOrders(scopes) ? null : READ_ALL_ORDERS,
  };
}

export function completenessInfo(
  scopes: string[],
  nowMs?: number,
): Completeness {
  if (hasReadAllOrders(scopes)) {
    return { status: "complete", reason: null, visible_from: null };
  }
  return {
    status: "partial",
    reason: "read_all_orders_missing",
    visible_from: computeHorizon(nowMs ?? Date.now()),
  };
}

function throwBeforeHorizon(
  info: HorizonInfo,
  requestedSince: string | null,
  requestedUntil: string | null,
): never {
  throw new ScopeHorizonError({
    missing: READ_ALL_ORDERS,
    horizon: info.horizon,
    horizonShopDate: info.horizon_shop_date,
    requestedSince,
    requestedUntil,
    reason: "before_horizon",
    visibleFrom: info.horizon,
  });
}

function throwIndeterminate(
  info: HorizonInfo,
  requestedSince: string | null,
  requestedUntil: string | null,
): never {
  throw new ScopeHorizonError({
    missing: READ_ALL_ORDERS,
    horizon: info.horizon,
    horizonShopDate: info.horizon_shop_date,
    requestedSince,
    requestedUntil,
    reason: "visibility_indeterminate",
    visibleFrom: info.horizon,
  });
}

function instantBeforeHorizon(iso: string, horizonIso: string): boolean {
  const t = Date.parse(iso);
  const h = Date.parse(horizonIso);
  return Number.isFinite(t) && Number.isFinite(h) && t < h;
}

/**
 * Product-history / explicit-range guard. Compares sinceIso (or untilIso
 * when sinceIso is absent) to the horizon as instants. Presence of
 * read_all_orders always succeeds.
 */
export function assertRangeVisible(args: {
  scopes: string[];
  sinceIso?: string | null;
  untilIso?: string | null;
  nowMs?: number;
  tz?: string;
  requestedSince?: string | null;
  requestedUntil?: string | null;
}): HorizonInfo {
  const info = horizonInfo(args.scopes, args.nowMs, args.tz);
  if (info.scope_missing === null) {
    return info;
  }
  const sinceIso = args.sinceIso ?? null;
  const untilIso = args.untilIso ?? null;
  const probe =
    sinceIso != null && sinceIso !== ""
      ? sinceIso
      : untilIso != null && untilIso !== ""
        ? untilIso
        : null;
  if (probe != null && instantBeforeHorizon(probe, info.horizon)) {
    throwBeforeHorizon(
      info,
      args.requestedSince ?? sinceIso,
      args.requestedUntil ?? untilIso,
    );
  }
  return info;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseToken(token: string): ParsedToken | null {
  const trimmed = token.trim();
  if (trimmed === "") {
    return null;
  }
  if (YEAR_RE.test(trimmed)) {
    const year = trimmed;
    const nextYear = String(Number(year) + 1).padStart(4, "0");
    const startMs = Date.parse(`${year}-01-01T00:00:00.000Z`);
    const nextStartMs = Date.parse(`${nextYear}-01-01T00:00:00.000Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(nextStartMs)) {
      return null;
    }
    return {
      kind: "period",
      startMs,
      endMs: nextStartMs - 1,
      nextStartMs,
    };
  }
  if (isValidDate(trimmed)) {
    const startMs = Date.parse(`${trimmed}T00:00:00.000Z`);
    const nextStartMs = Date.parse(`${nextDay(trimmed)}T00:00:00.000Z`);
    if (!Number.isFinite(startMs) || !Number.isFinite(nextStartMs)) {
      return null;
    }
    return {
      kind: "period",
      startMs,
      endMs: nextStartMs - 1,
      nextStartMs,
    };
  }
  if (DATETIME_RE.test(trimmed)) {
    const ms = Date.parse(trimmed);
    if (!Number.isFinite(ms)) {
      return null;
    }
    return { kind: "instant", ms };
  }
  return null;
}

function startMsOf(token: ParsedToken): number {
  return token.kind === "instant" ? token.ms : token.startMs;
}

function endMsOf(token: ParsedToken): number {
  return token.kind === "instant" ? token.ms : token.endMs;
}

function exclusiveLowerMs(token: ParsedToken): number {
  return token.kind === "instant" ? token.ms : token.nextStartMs;
}

function splitRange(value: string): [string, string] | null {
  const idx = value.indexOf("..");
  if (idx <= 0) {
    return null;
  }
  const left = value.slice(0, idx).trim();
  const right = value.slice(idx + 2).trim();
  if (!left || !right || right.includes("..")) {
    return null;
  }
  return [left, right];
}

function boundsFromValue(
  operator: ">=" | ">" | "<=" | "<" | undefined,
  rawValue: string,
): { op: DatePredicateOp; lower: string | null; upper: string | null } | null {
  const value = unquote(rawValue.trim());
  if (value === "") {
    return null;
  }
  if (value.includes("..")) {
    const parts = splitRange(value);
    if (!parts) {
      return null;
    }
    const left = parseToken(parts[0]);
    const right = parseToken(parts[1]);
    if (!left || !right) {
      return null;
    }
    return {
      op: "range",
      lower: toIso(startMsOf(left)),
      upper: toIso(endMsOf(right)),
    };
  }
  const token = parseToken(value);
  if (!token) {
    return null;
  }
  if (operator === ">=") {
    return { op: ">=", lower: toIso(startMsOf(token)), upper: null };
  }
  if (operator === ">") {
    return { op: ">", lower: toIso(exclusiveLowerMs(token)), upper: null };
  }
  if (operator === "<=") {
    return { op: "<=", lower: null, upper: toIso(endMsOf(token)) };
  }
  if (operator === "<") {
    return { op: "<", lower: null, upper: toIso(startMsOf(token)) };
  }
  return {
    op: "=",
    lower: toIso(startMsOf(token)),
    upper: toIso(endMsOf(token)),
  };
}

function isNegatedAt(query: string, fieldIndex: number): boolean {
  if (fieldIndex > 0 && query[fieldIndex - 1] === "-") {
    return true;
  }
  // Bounded tail so a 200 kB query of thousands of predicates stays O(n)
  // in the input length, not O(n * prefix) from a growing regex scan.
  const before = query.slice(Math.max(0, fieldIndex - 8), fieldIndex);
  return /(^|\s|\()NOT\s+$/i.test(before);
}

function hasUnquotedOrToken(query: string): boolean {
  const stripped = query.replace(/"[^"]*"|'[^']*'/g, " ");
  return /(^|\s)OR(\s|$)/.test(stripped);
}

function latestIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function earliestIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/**
 * Parse Shopify search date predicates. Never throws.
 *
 * created_at / processed_at / updated_at (case-insensitive), optional
 * operator, quoted or bare values, ISO datetimes, YYYY-MM-DD, YYYY, or a..b
 * ranges. A leading `-` or the word NOT negates. An unquoted uppercase
 * whitespace-delimited OR sets hasOr. Parentheses around a date predicate
 * make the analysis indeterminate.
 */
export function analyzeDatePredicates(
  query: string | null | undefined,
): DatePredicateAnalysis {
  const predicates: DatePredicate[] = [];
  if (query == null || query === "") {
    return {
      predicates,
      hasOr: false,
      createdAtLowerIso: null,
      indeterminate: false,
      indeterminateReasons: [],
    };
  }
  const hasOr = hasUnquotedOrToken(query);
  PREDICATE_RE.lastIndex = 0;
  for (const match of query.matchAll(PREDICATE_RE)) {
    const raw = match[0];
    const field = match[1].toLowerCase() as DatePredicateField;
    const operator = match[2] as ">=" | ">" | "<=" | "<" | undefined;
    const rawValue = match[3];
    const fieldIndex = match.index ?? 0;
    const negated = isNegatedAt(query, fieldIndex);
    if (rawValue == null || rawValue === "") {
      predicates.push({
        field,
        op: operator ?? "=",
        raw,
        lower: null,
        upper: null,
        negated,
        malformed: true,
      });
      continue;
    }
    const bounds = boundsFromValue(operator, rawValue);
    if (!bounds) {
      predicates.push({
        field,
        op: operator ?? "=",
        raw,
        lower: null,
        upper: null,
        negated,
        malformed: true,
      });
      continue;
    }
    predicates.push({
      field,
      op: bounds.op,
      raw,
      lower: bounds.lower,
      upper: bounds.upper,
      negated,
      malformed: false,
    });
  }

  let createdAtLowerIso: string | null = null;
  for (const pred of predicates) {
    if (pred.malformed || pred.negated) {
      continue;
    }
    if (pred.field === "created_at" && pred.lower != null) {
      createdAtLowerIso =
        createdAtLowerIso == null
          ? pred.lower
          : latestIso(createdAtLowerIso, pred.lower);
    }
  }

  const indeterminateReasons: string[] = [];
  if (hasOr && predicates.length > 0) {
    indeterminateReasons.push(
      "query contains OR; date predicates are not conjunctive",
    );
  }
  for (const pred of predicates) {
    if (pred.negated) {
      indeterminateReasons.push(`negated date predicate: ${pred.raw}`);
    }
    if (pred.malformed) {
      indeterminateReasons.push(`malformed date predicate: ${pred.raw}`);
    }
  }
  if (predicates.length > 0 && createdAtLowerIso == null) {
    indeterminateReasons.push(
      "no conjunctive created_at lower bound; query can reach before the horizon",
    );
  }
  if (
    predicates.length > 0 &&
    (query.includes("(") || query.includes(")"))
  ) {
    indeterminateReasons.push(
      "parenthesised groups cannot be proven conjunctive",
    );
  }

  return {
    predicates,
    hasOr,
    createdAtLowerIso,
    indeterminate: indeterminateReasons.length > 0,
    indeterminateReasons,
  };
}

/**
 * Earliest instant a query could reach (min of non-negated lowers) and the
 * tightest upper (min of uppers). Negated and malformed predicates are
 * ignored. Never throws.
 */
export function extractDateBounds(
  query: string | undefined | null,
): DateBounds {
  const analysis = analyzeDatePredicates(query);
  let lower: string | null = null;
  let upper: string | null = null;
  const fields: string[] = [];
  for (const pred of analysis.predicates) {
    if (pred.negated || pred.malformed) {
      continue;
    }
    if (!fields.includes(pred.field)) {
      fields.push(pred.field);
    }
    if (pred.lower != null) {
      lower = lower == null ? pred.lower : earliestIso(lower, pred.lower);
    }
    if (pred.upper != null) {
      upper = upper == null ? pred.upper : earliestIso(upper, pred.upper);
    }
  }
  return { lower, upper, fields };
}

/**
 * List-tool guard. With read_all_orders, always returns info. Without it:
 * no date predicates -> info; indeterminate query -> throw; created_at
 * lower instant before the horizon -> throw; else info.
 */
export function guardOrderQuery(args: {
  scopes: string[];
  query?: string | null;
  nowMs?: number;
  tz?: string;
}): HorizonInfo {
  const info = horizonInfo(args.scopes, args.nowMs, args.tz);
  if (info.scope_missing === null) {
    return info;
  }
  const analysis = analyzeDatePredicates(args.query);
  if (analysis.predicates.length === 0) {
    return info;
  }
  if (analysis.indeterminate) {
    throwIndeterminate(info, analysis.createdAtLowerIso, null);
  }
  const lower = analysis.createdAtLowerIso;
  if (lower != null && instantBeforeHorizon(lower, info.horizon)) {
    throwBeforeHorizon(info, lower, null);
  }
  return info;
}
