/**
 * Shop-local calendar helpers (pure, Intl only).
 *
 * Why this exists: Shopify order search and reporting are shop-timezone
 * concepts (America/Chicago for three stores, America/New_York for Fortin).
 * A UTC day boundary is the wrong cut: 2026-07-27T03:40:26Z is still
 * 2026-07-26 in Chicago. Hardcoding CST/CDT (or EST/EDT) would drift on
 * DST transition days, so every conversion goes through Intl.DateTimeFormat
 * with the shop's IANA zone.
 *
 * Pipelines:
 *
 *   ISO instant --localDate(tz)--> YYYY-MM-DD in the shop
 *              --monthKey(tz)--> YYYY-MM in the shop
 *
 *   YYYY-MM-DD --shopDayStart(tz)--> UTC instant of local midnight
 *              --shopDayStartOffsetIso(tz)--> same instant with numeric offset
 *                                            (Shopify search filter form)
 *
 *   ShopWindow is half-open [startIso, endIso):
 *
 *     startIso = shopDayStart(sinceDate, tz)
 *     endIso   = shopDayStart(nextDay(untilDate), tz)
 *
 *     [ startIso , endIso )
 *           ^           ^
 *        inclusive   exclusive  (an event AT endIso belongs to the next day)
 *
 * shopDayStart finds local midnight by guessing UTC midnight of `date`,
 * reading the zone offset at that instant via formatToParts, and correcting
 * the candidate. At most two correction rounds. After that, the candidate is
 * formatted back in `tz` and MUST render as `date` 00:00:00; if it does not,
 * we throw rather than guess (DST gaps where local midnight does not exist).
 * Invalid IANA names throw RangeError from Intl; we wrap that into Error
 * mentioning the timezone.
 */

export interface ShopWindow {
  sinceDate: string;
  untilDate: string;
  tz: string;
  startIso: string;
  endIso: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

function pad2(value: string | number): string {
  return String(value).padStart(2, "0");
}

function pad4(value: string | number): string {
  return String(value).padStart(4, "0");
}

function wrapTimeZoneError(tz: string, err: unknown): never {
  if (err instanceof RangeError) {
    throw new Error(`invalid timezone: ${tz}`);
  }
  throw err;
}

interface ZoneParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function partsAt(ms: number, tz: string): ZoneParts {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      calendar: "iso8601",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      hourCycle: "h23",
    });
    const bag: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
    for (const part of dtf.formatToParts(new Date(ms))) {
      if (part.type !== "literal") {
        bag[part.type] = part.value;
      }
    }
    return {
      year: bag.year ?? "",
      month: bag.month ?? "",
      day: bag.day ?? "",
      hour: bag.hour ?? "",
      minute: bag.minute ?? "",
      second: bag.second ?? "",
    };
  } catch (err) {
    wrapTimeZoneError(tz, err);
  }
}

/** Offset of `tz` at `ms`: local-as-UTC minus actual UTC (ms). Negative west of UTC. */
function offsetAt(ms: number, tz: string): number {
  const p = partsAt(ms, tz);
  const asUtc = Date.parse(
    `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}Z`,
  );
  return asUtc - ms;
}

function formatOffset(offsetMs: number): string {
  const sign = offsetMs >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMs);
  const hh = Math.floor(abs / 3_600_000);
  const mm = Math.floor((abs % 3_600_000) / 60_000);
  return `${sign}${pad2(hh)}:${pad2(mm)}`;
}

function requireValidDate(date: string): void {
  if (!isValidDate(date)) {
    throw new Error(`invalid date: ${date}`);
  }
}

/** Strict YYYY-MM-DD and a real Gregorian calendar date. */
export function isValidDate(date: string): boolean {
  const match = DATE_RE.exec(date);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(probe)) {
    return false;
  }
  const dt = new Date(probe);
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

/** Calendar date of `iso` in `tz` as YYYY-MM-DD. */
export function localDate(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error(`invalid instant: ${iso}`);
  }
  const p = partsAt(ms, tz);
  return `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** YYYY-MM of `iso` in `tz`. */
export function monthKey(iso: string, tz: string): string {
  return localDate(iso, tz).slice(0, 7);
}

/**
 * UTC instant (Z form) of local midnight starting `date` in `tz`.
 * DST-correct; throws if local midnight cannot be resolved.
 */
export function shopDayStart(date: string, tz: string): string {
  requireValidDate(date);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const targetAsUtc = Date.parse(
    `${pad4(year)}-${pad2(month)}-${pad2(day)}T00:00:00.000Z`,
  );
  let candidate = targetAsUtc;
  for (let round = 0; round < 2; round++) {
    const offsetMs = offsetAt(candidate, tz);
    candidate = targetAsUtc - offsetMs;
  }
  const p = partsAt(candidate, tz);
  const renderedDate = `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
  const renderedTime = `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
  if (renderedDate !== date || renderedTime !== "00:00:00") {
    throw new Error(`cannot resolve local midnight for ${date} in ${tz}`);
  }
  return new Date(candidate).toISOString();
}

/**
 * Same instant as shopDayStart, rendered with the numeric local offset
 * (e.g. 2025-01-01T00:00:00-06:00) for Shopify search filters.
 */
export function shopDayStartOffsetIso(date: string, tz: string): string {
  const utcIso = shopDayStart(date, tz);
  const offsetMs = offsetAt(Date.parse(utcIso), tz);
  return `${date}T00:00:00${formatOffset(offsetMs)}`;
}

/** YYYY-MM-DD plus one calendar day (UTC arithmetic on the date only). */
export function nextDay(date: string): string {
  requireValidDate(date);
  const nextMs = Date.parse(`${date}T00:00:00.000Z`) + MS_PER_DAY;
  const dt = new Date(nextMs);
  return `${pad4(dt.getUTCFullYear())}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Inclusive month keys from sinceDate's month through untilDate's month. */
export function monthsBetween(sinceDate: string, untilDate: string): string[] {
  requireValidDate(sinceDate);
  requireValidDate(untilDate);
  if (sinceDate > untilDate) {
    throw new Error("since must be <= until");
  }
  const keys: string[] = [];
  let year = Number(sinceDate.slice(0, 4));
  let month = Number(sinceDate.slice(5, 7));
  const endYear = Number(untilDate.slice(0, 4));
  const endMonth = Number(untilDate.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    keys.push(`${pad4(year)}-${pad2(month)}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return keys;
}

/** Inclusive day count between two YYYY-MM-DD dates. */
export function daysBetween(sinceDate: string, untilDate: string): number {
  requireValidDate(sinceDate);
  requireValidDate(untilDate);
  if (sinceDate > untilDate) {
    throw new Error("since must be <= until");
  }
  const start = Date.parse(`${sinceDate}T00:00:00.000Z`);
  const end = Date.parse(`${untilDate}T00:00:00.000Z`);
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

/**
 * Half-open shop-local window [startIso, endIso) covering sinceDate..untilDate
 * inclusive as calendar dates.
 */
export function buildShopWindow(
  sinceDate: string,
  untilDate: string,
  tz: string,
): ShopWindow {
  requireValidDate(sinceDate);
  requireValidDate(untilDate);
  if (sinceDate > untilDate) {
    throw new Error("since must be <= until");
  }
  return {
    sinceDate,
    untilDate,
    tz,
    startIso: shopDayStart(sinceDate, tz),
    endIso: shopDayStart(nextDay(untilDate), tz),
  };
}

/**
 * True when `iso` is in [w.startIso, w.endIso). null/undefined/unparseable
 * instants are outside the window.
 */
export function inWindow(
  iso: string | null | undefined,
  w: ShopWindow,
): boolean {
  if (iso == null) {
    return false;
  }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    return false;
  }
  const start = Date.parse(w.startIso);
  const end = Date.parse(w.endIso);
  return t >= start && t < end;
}
