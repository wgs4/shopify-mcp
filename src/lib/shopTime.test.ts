// Shop-local calendar helpers: DST-aware midnight, half-open windows.
//
// These tests must FAIL if shopTime.ts is missing the conversions and PASS
// once Intl-backed local midnight is wired in. Ground truth is Intl itself
// (America/Chicago and America/New_York, 2025 DST transitions).

import { describe, expect, test } from "@jest/globals";

import {
  buildShopWindow,
  daysBetween,
  inWindow,
  isValidDate,
  localDate,
  monthKey,
  monthsBetween,
  nextDay,
  shopDayStart,
  shopDayStartOffsetIso,
} from "./shopTime.js";

const CHICAGO = "America/Chicago";
const NEW_YORK = "America/New_York";
const UTC = "UTC";

function expectRoundTripMidnight(date: string, tz: string): void {
  const start = shopDayStart(date, tz);
  expect(localDate(start, tz)).toBe(date);
  const offsetIso = shopDayStartOffsetIso(date, tz);
  expect(offsetIso.startsWith(`${date}T00:00:00`)).toBe(true);
  expect(Date.parse(offsetIso)).toBe(Date.parse(start));
}

describe("isValidDate", () => {
  test("accepts strict zero-padded real calendar dates", () => {
    expect(isValidDate("2025-01-01")).toBe(true);
    expect(isValidDate("2024-02-29")).toBe(true);
    expect(isValidDate("2025-04-30")).toBe(true);
    expect(isValidDate("2025-12-31")).toBe(true);
  });

  test("rejects non-strict formats and impossible dates", () => {
    expect(isValidDate("2025-1-1")).toBe(false);
    expect(isValidDate("2025-02-30")).toBe(false);
    expect(isValidDate("2025-13-01")).toBe(false);
    expect(isValidDate("2025-00-01")).toBe(false);
    expect(isValidDate("2025-01-00")).toBe(false);
    expect(isValidDate("2025-02-29")).toBe(false);
    expect(isValidDate("2025-04-31")).toBe(false);
    expect(isValidDate("2025/01/01")).toBe(false);
    expect(isValidDate("")).toBe(false);
    expect(isValidDate("today")).toBe(false);
  });
});

describe("localDate / monthKey", () => {
  test("2026-07-27T03:40:26Z is still the 26th in Chicago and New York", () => {
    const iso = "2026-07-27T03:40:26Z";
    expect(localDate(iso, CHICAGO)).toBe("2026-07-26");
    expect(localDate(iso, NEW_YORK)).toBe("2026-07-26");
    expect(localDate(iso, UTC)).toBe("2026-07-27");
    expect(monthKey(iso, CHICAGO)).toBe("2026-07");
    expect(monthKey(iso, UTC)).toBe("2026-07");
  });

  test("monthKey follows the shop calendar across a UTC year boundary", () => {
    // 2026-01-01T05:30Z is still 2025-12-31 23:30 in Chicago (UTC-6).
    expect(localDate("2026-01-01T05:30:00.000Z", CHICAGO)).toBe("2025-12-31");
    expect(monthKey("2026-01-01T05:30:00.000Z", CHICAGO)).toBe("2025-12");
  });

  test("invalid instant throws", () => {
    expect(() => localDate("not-a-date", CHICAGO)).toThrow(/invalid instant/);
  });

  test("invalid timezone is wrapped into Error mentioning the zone", () => {
    expect(() => localDate("2025-01-01T00:00:00.000Z", "Not/AZone")).toThrow(
      /invalid timezone: Not\/AZone/,
    );
    expect(() => localDate("2025-01-01T00:00:00.000Z", "Not/AZone")).toThrow(
      Error,
    );
  });
});

describe("shopDayStart", () => {
  test("Chicago winter is UTC-6 and summer is UTC-5", () => {
    expect(shopDayStart("2025-01-01", CHICAGO)).toBe("2025-01-01T06:00:00.000Z");
    expect(shopDayStart("2025-07-01", CHICAGO)).toBe("2025-07-01T05:00:00.000Z");
  });

  test("New York winter is UTC-5 and summer is UTC-4", () => {
    expect(shopDayStart("2025-01-01", NEW_YORK)).toBe(
      "2025-01-01T05:00:00.000Z",
    );
    expect(shopDayStart("2025-07-01", NEW_YORK)).toBe(
      "2025-07-01T04:00:00.000Z",
    );
  });

  test("UTC local midnight is the Z midnight", () => {
    expect(shopDayStart("2025-01-01", UTC)).toBe("2025-01-01T00:00:00.000Z");
  });

  test("Chicago DST transition days (2025-03-09 spring, 2025-11-02 fall)", () => {
    // Spring-forward is 02:00 local; midnight is still CST (UTC-6).
    expect(shopDayStart("2025-03-09", CHICAGO)).toBe("2025-03-09T06:00:00.000Z");
    // The next day is fully CDT (UTC-5).
    expect(shopDayStart("2025-03-10", CHICAGO)).toBe("2025-03-10T05:00:00.000Z");
    // Fall-back is 02:00 local; midnight is still CDT (UTC-5).
    expect(shopDayStart("2025-11-02", CHICAGO)).toBe("2025-11-02T05:00:00.000Z");
    expect(shopDayStart("2025-11-03", CHICAGO)).toBe("2025-11-03T06:00:00.000Z");
  });

  test("normal days round-trip as date 00:00:00 in the shop zone", () => {
    for (const date of [
      "2025-01-01",
      "2025-07-01",
      "2025-03-09",
      "2025-03-10",
      "2025-11-02",
      "2025-11-03",
    ]) {
      expectRoundTripMidnight(date, CHICAGO);
      expectRoundTripMidnight(date, NEW_YORK);
      expectRoundTripMidnight(date, UTC);
    }
  });

  test("invalid date throws", () => {
    expect(() => shopDayStart("2025-02-30", CHICAGO)).toThrow(/invalid date/);
    expect(() => shopDayStart("2025-1-1", CHICAGO)).toThrow(/invalid date/);
  });

  test("invalid timezone is wrapped into Error mentioning the zone", () => {
    expect(() => shopDayStart("2025-01-01", "Not/AZone")).toThrow(
      /invalid timezone: Not\/AZone/,
    );
  });

  test("throws rather than guess when local midnight does not exist", () => {
    // America/Santiago springs forward through local midnight on 2025-09-07.
    expect(() => shopDayStart("2025-09-07", "America/Santiago")).toThrow(
      "cannot resolve local midnight for 2025-09-07 in America/Santiago",
    );
  });
});

describe("shopDayStartOffsetIso", () => {
  test("renders the local offset Shopify search filters expect", () => {
    expect(shopDayStartOffsetIso("2025-01-01", CHICAGO)).toBe(
      "2025-01-01T00:00:00-06:00",
    );
    expect(shopDayStartOffsetIso("2025-07-01", CHICAGO)).toBe(
      "2025-07-01T00:00:00-05:00",
    );
    expect(shopDayStartOffsetIso("2025-01-01", NEW_YORK)).toBe(
      "2025-01-01T00:00:00-05:00",
    );
    expect(shopDayStartOffsetIso("2025-07-01", NEW_YORK)).toBe(
      "2025-07-01T00:00:00-04:00",
    );
    expect(shopDayStartOffsetIso("2025-01-01", UTC)).toBe(
      "2025-01-01T00:00:00+00:00",
    );
    expect(shopDayStartOffsetIso("2025-01-01", "Asia/Kathmandu")).toBe(
      "2025-01-01T00:00:00+05:45",
    );
  });
});

describe("nextDay", () => {
  test("adds one calendar day with UTC date arithmetic", () => {
    expect(nextDay("2025-01-01")).toBe("2025-01-02");
    expect(nextDay("2025-01-31")).toBe("2025-02-01");
    expect(nextDay("2025-12-31")).toBe("2026-01-01");
    expect(nextDay("2024-02-28")).toBe("2024-02-29");
    expect(nextDay("2025-02-28")).toBe("2025-03-01");
  });

  test("rejects invalid dates", () => {
    expect(() => nextDay("2025-02-30")).toThrow(/invalid date/);
  });
});

describe("monthsBetween / daysBetween", () => {
  test("monthsBetween is inclusive across a year boundary", () => {
    expect(monthsBetween("2025-11-15", "2026-02-01")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  test("monthsBetween of a single month and a full year", () => {
    expect(monthsBetween("2025-06-01", "2025-06-30")).toEqual(["2025-06"]);
    expect(monthsBetween("2025-01-01", "2025-12-31")).toEqual([
      "2025-01",
      "2025-02",
      "2025-03",
      "2025-04",
      "2025-05",
      "2025-06",
      "2025-07",
      "2025-08",
      "2025-09",
      "2025-10",
      "2025-11",
      "2025-12",
    ]);
  });

  test("daysBetween is inclusive", () => {
    expect(daysBetween("2025-01-01", "2025-01-01")).toBe(1);
    expect(daysBetween("2025-01-01", "2025-01-02")).toBe(2);
    expect(daysBetween("2025-01-01", "2025-01-31")).toBe(31);
  });

  test("since > until throws", () => {
    expect(() => monthsBetween("2025-02-01", "2025-01-01")).toThrow(
      "since must be <= until",
    );
    expect(() => daysBetween("2025-02-01", "2025-01-01")).toThrow(
      "since must be <= until",
    );
  });

  test("invalid dates throw", () => {
    expect(() => monthsBetween("2025-02-30", "2025-03-01")).toThrow(
      /invalid date/,
    );
    expect(() => monthsBetween("2025-01-01", "2025-13-01")).toThrow(
      /invalid date/,
    );
    expect(() => daysBetween("2025-1-1", "2025-01-02")).toThrow(/invalid date/);
    expect(() => daysBetween("2025-01-01", "2025-02-30")).toThrow(
      /invalid date/,
    );
  });
});

describe("buildShopWindow / inWindow", () => {
  test("half-open end: event at endIso is out, one ms before is in", () => {
    const w = buildShopWindow("2025-01-01", "2025-01-31", CHICAGO);
    expect(w.startIso).toBe(shopDayStart("2025-01-01", CHICAGO));
    expect(w.endIso).toBe(shopDayStart("2025-02-01", CHICAGO));
    expect(w.sinceDate).toBe("2025-01-01");
    expect(w.untilDate).toBe("2025-01-31");
    expect(w.tz).toBe(CHICAGO);

    expect(inWindow(w.startIso, w)).toBe(true);
    expect(inWindow(w.endIso, w)).toBe(false);
    const oneMsBeforeEnd = new Date(Date.parse(w.endIso) - 1).toISOString();
    expect(inWindow(oneMsBeforeEnd, w)).toBe(true);
    const oneMsBeforeStart = new Date(Date.parse(w.startIso) - 1).toISOString();
    expect(inWindow(oneMsBeforeStart, w)).toBe(false);
  });

  test("single-day window", () => {
    const w = buildShopWindow("2025-07-04", "2025-07-04", CHICAGO);
    expect(w.startIso).toBe("2025-07-04T05:00:00.000Z");
    expect(w.endIso).toBe("2025-07-05T05:00:00.000Z");
    expect(inWindow("2025-07-04T05:00:00.000Z", w)).toBe(true);
    expect(inWindow("2025-07-05T05:00:00.000Z", w)).toBe(false);
  });

  test("null/undefined/unparseable instants are outside the window", () => {
    const w = buildShopWindow("2025-01-01", "2025-01-01", CHICAGO);
    expect(inWindow(null, w)).toBe(false);
    expect(inWindow(undefined, w)).toBe(false);
    expect(inWindow("", w)).toBe(false);
    expect(inWindow("garbage", w)).toBe(false);
  });

  test("since > until throws", () => {
    expect(() => buildShopWindow("2025-02-01", "2025-01-01", CHICAGO)).toThrow(
      "since must be <= until",
    );
  });

  test("invalid dates throw", () => {
    expect(() => buildShopWindow("2025-02-30", "2025-03-01", CHICAGO)).toThrow(
      /invalid date/,
    );
    expect(() => buildShopWindow("2025-01-01", "2025-13-01", CHICAGO)).toThrow(
      /invalid date/,
    );
  });

  test("invalid timezone throws a wrapped Error mentioning the zone", () => {
    expect(() => buildShopWindow("2025-01-01", "2025-01-02", "Not/AZone")).toThrow(
      /invalid timezone: Not\/AZone/,
    );
  });
});