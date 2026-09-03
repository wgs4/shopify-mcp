// 60-day order visibility wall: horizon math, search-predicate analysis,
// and fail-closed guards. Tests must FAIL if the wall is missing and PASS
// once ScopeHorizonError is thrown for out-of-range / indeterminate queries.

import { describe, expect, jest, test } from "@jest/globals";

import { localDate, shopDayStart } from "./shopTime.js";
import {
  ORDER_WALL_DAYS,
  READ_ALL_ORDERS,
  ScopeHorizonError,
  analyzeDatePredicates,
  assertRangeVisible,
  completenessInfo,
  computeHorizon,
  extractDateBounds,
  firstVisibleDate,
  guardOrderQuery,
  horizonInfo,
} from "./orderWall.js";

const NOW_MS = Date.parse("2026-09-03T12:00:00.000Z");
const HORIZON = "2026-07-05T12:00:00.000Z";
const CHICAGO = "America/Chicago";
const SCOPES_ORDERS = ["read_orders"];
const SCOPES_ALL = ["read_orders", "read_all_orders"];

function guard(
  query: string | null | undefined,
  scopes: string[] = SCOPES_ORDERS,
) {
  return guardOrderQuery({
    scopes,
    query,
    nowMs: NOW_MS,
    tz: CHICAGO,
  });
}

function expectBeforeHorizon(fn: () => unknown): ScopeHorizonError {
  try {
    fn();
    throw new Error("expected ScopeHorizonError");
  } catch (err) {
    expect(err).toBeInstanceOf(ScopeHorizonError);
    const e = err as ScopeHorizonError;
    expect(e.reason).toBe("before_horizon");
    expect(e.name).toBe("ScopeHorizonError");
    expect(e.code).toBe("SCOPE_HORIZON");
    expect(e.missing).toBe(READ_ALL_ORDERS);
    expect(e.horizon).toBe(HORIZON);
    expect(e.visibleFrom).toBe(HORIZON);
    expect(e.message.startsWith("ScopeHorizonError: ")).toBe(true);
    expect(e.message).toContain(READ_ALL_ORDERS);
    expect(e.message).toContain(HORIZON);
    expect(e.message).toContain("Earliest accepted bound");
    expect(e.message).toContain(
      "Request read_all_orders for app shop-wgs-mcp-8-6-26 to see older orders.",
    );
    return e;
  }
}

function expectIndeterminate(fn: () => unknown): ScopeHorizonError {
  try {
    fn();
    throw new Error("expected ScopeHorizonError");
  } catch (err) {
    expect(err).toBeInstanceOf(ScopeHorizonError);
    const e = err as ScopeHorizonError;
    expect(e.reason).toBe("visibility_indeterminate");
    expect(e.name).toBe("ScopeHorizonError");
    expect(e.code).toBe("SCOPE_HORIZON");
    expect(e.missing).toBe(READ_ALL_ORDERS);
    expect(e.horizon).toBe(HORIZON);
    expect(e.visibleFrom).toBe(HORIZON);
    expect(e.message.startsWith("ScopeHorizonError: ")).toBe(true);
    expect(e.message).toMatch(/cannot prove the result is complete/);
    expect(e.message).toContain(READ_ALL_ORDERS);
    expect(e.message).toContain(HORIZON);
    expect(e.message).toContain("Earliest accepted bound");
    expect(e.message).toContain(
      "Request read_all_orders for app shop-wgs-mcp-8-6-26 to see older orders.",
    );
    return e;
  }
}

describe("computeHorizon", () => {
  test("subtracts exactly 60 days from the given instant", () => {
    expect(ORDER_WALL_DAYS).toBe(60);
    expect(computeHorizon(NOW_MS)).toBe(HORIZON);
    expect(computeHorizon(Date.parse("2026-09-03T00:00:00.000Z"))).toBe(
      "2026-07-05T00:00:00.000Z",
    );
  });

  test("defaults to Date.now()", () => {
    const spy = jest.spyOn(Date, "now").mockReturnValue(NOW_MS);
    try {
      expect(computeHorizon()).toBe(HORIZON);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("horizonInfo / completenessInfo", () => {
  test("reports the missing scope and shop date when tz is given", () => {
    const info = horizonInfo(SCOPES_ORDERS, NOW_MS, CHICAGO);
    expect(info.wall_days).toBe(60);
    expect(info.horizon).toBe(HORIZON);
    expect(info.horizon_shop_date).toBe(localDate(HORIZON, CHICAGO));
    expect(info.first_visible_date).toBe("2026-07-06");
    expect(info.scope_missing).toBe(READ_ALL_ORDERS);
  });

  test("scope_missing is null when read_all_orders is present", () => {
    const info = horizonInfo(SCOPES_ALL, NOW_MS);
    expect(info.scope_missing).toBeNull();
    expect(info.horizon_shop_date).toBeNull();
  });

  test("completeness is partial without the scope and complete with it", () => {
    expect(completenessInfo(SCOPES_ORDERS, NOW_MS)).toEqual({
      status: "partial",
      reason: "read_all_orders_missing",
      visible_from: HORIZON,
    });
    expect(completenessInfo(SCOPES_ALL, NOW_MS)).toEqual({
      status: "complete",
      reason: null,
      visible_from: null,
    });
  });
});

describe("analyzeDatePredicates", () => {
  test("empty / null / no date fields yields no predicates", () => {
    for (const q of [null, undefined, "", "status:open", "  "]) {
      const a = analyzeDatePredicates(q);
      expect(a.predicates).toEqual([]);
      expect(a.createdAtLowerIso).toBeNull();
      expect(a.indeterminate).toBe(false);
    }
  });

  test("parses >= > <= < = range, quoted ISO, years, and dates", () => {
    const ge = analyzeDatePredicates("created_at:>=2025-01-01");
    expect(ge.predicates[0]).toMatchObject({
      field: "created_at",
      op: ">=",
      lower: "2025-01-01T00:00:00.000Z",
      upper: null,
      negated: false,
      malformed: false,
    });
    expect(ge.createdAtLowerIso).toBe("2025-01-01T00:00:00.000Z");

    const gtYear = analyzeDatePredicates("created_at:>2024");
    expect(gtYear.predicates[0]).toMatchObject({
      field: "created_at",
      op: ">",
      lower: "2025-01-01T00:00:00.000Z",
    });

    const le = analyzeDatePredicates("created_at:<=2024");
    expect(le.predicates[0]).toMatchObject({
      field: "created_at",
      op: "<=",
      lower: null,
      upper: "2024-12-31T23:59:59.999Z",
    });

    const lt = analyzeDatePredicates("created_at:<2024-06-01");
    expect(lt.predicates[0]).toMatchObject({
      field: "created_at",
      op: "<",
      lower: null,
      upper: "2024-06-01T00:00:00.000Z",
    });

    const eqYear = analyzeDatePredicates("created_at:2024");
    expect(eqYear.predicates[0]).toMatchObject({
      field: "created_at",
      op: "=",
      lower: "2024-01-01T00:00:00.000Z",
      upper: "2024-12-31T23:59:59.999Z",
    });

    const quoted = analyzeDatePredicates(
      "created_at:'2020-10-21T23:39:20Z'",
    );
    expect(quoted.predicates[0]).toMatchObject({
      field: "created_at",
      op: "=",
      lower: "2020-10-21T23:39:20.000Z",
      upper: "2020-10-21T23:39:20.000Z",
    });

    const offset = analyzeDatePredicates(
      "created_at:>='2026-08-01T00:00:00-05:00'",
    );
    expect(offset.predicates[0].lower).toBe("2026-08-01T05:00:00.000Z");
    expect(offset.createdAtLowerIso).toBe("2026-08-01T05:00:00.000Z");

    const doubleQuoted = analyzeDatePredicates(
      'created_at:>="2026-08-01T00:00:00-05:00"',
    );
    expect(doubleQuoted.createdAtLowerIso).toBe("2026-08-01T05:00:00.000Z");

    const spaced = analyzeDatePredicates("created_at: >= 2026-08-01");
    expect(spaced.createdAtLowerIso).toBe("2026-08-01T00:00:00.000Z");

    const gtInstant = analyzeDatePredicates(
      "created_at:>2026-08-01T00:00:00.000Z",
    );
    expect(gtInstant.predicates[0]).toMatchObject({
      op: ">",
      lower: "2026-08-01T00:00:00.000Z",
    });

    const range = analyzeDatePredicates(
      "created_at:2025-01-01..2025-03-31",
    );
    expect(range.predicates[0]).toMatchObject({
      field: "created_at",
      op: "range",
      lower: "2025-01-01T00:00:00.000Z",
      upper: "2025-03-31T23:59:59.999Z",
    });
  });

  test("processed_at and updated_at are recognized (case-insensitive)", () => {
    const a = analyzeDatePredicates(
      "PROCESSED_AT:>=2026-08-01 UPDATED_AT:>=2026-08-15",
    );
    expect(a.predicates.map((p) => p.field)).toEqual([
      "processed_at",
      "updated_at",
    ]);
    expect(a.createdAtLowerIso).toBeNull();
    expect(a.indeterminate).toBe(true);
  });

  test("two created_at lower bounds AND together as the later instant", () => {
    const a = analyzeDatePredicates(
      "created_at:>=2020-01-01 created_at:>=2026-08-01",
    );
    expect(a.createdAtLowerIso).toBe("2026-08-01T00:00:00.000Z");
    expect(a.indeterminate).toBe(false);
  });

  test("OR with dates is indeterminate", () => {
    const a = analyzeDatePredicates(
      "created_at:>=2026-08-01 OR created_at:>=2020-01-01",
    );
    expect(a.hasOr).toBe(true);
    expect(a.indeterminate).toBe(true);
    expect(a.indeterminateReasons.some((r) => /OR/.test(r))).toBe(true);
  });

  test("negated predicates are flagged", () => {
    const minus = analyzeDatePredicates("-created_at:>=2026-08-01");
    expect(minus.predicates[0].negated).toBe(true);
    expect(minus.createdAtLowerIso).toBeNull();
    expect(minus.indeterminate).toBe(true);

    const notWord = analyzeDatePredicates("NOT created_at:>=2026-08-01");
    expect(notWord.predicates[0].negated).toBe(true);
    expect(notWord.indeterminate).toBe(true);
  });

  test("malformed values are flagged and never throw", () => {
    const a = analyzeDatePredicates("created_at:>=garbage");
    expect(a.predicates[0].malformed).toBe(true);
    expect(a.indeterminate).toBe(true);
    expect(() => analyzeDatePredicates("created_at:>=garbage")).not.toThrow();
    expect(() => analyzeDatePredicates("created_at:")).not.toThrow();
    expect(analyzeDatePredicates("created_at:").predicates[0].malformed).toBe(
      true,
    );
    expect(
      analyzeDatePredicates("created_at:2025-01-01..").predicates[0].malformed,
    ).toBe(true);
    expect(
      analyzeDatePredicates("created_at:..2025-01-01").predicates[0].malformed,
    ).toBe(true);
    expect(
      analyzeDatePredicates("created_at:2025-01-01..2025-02-01..2025-03-01")
        .predicates[0].malformed,
    ).toBe(true);
  });

  test("upper-only created_at is indeterminate (no lower bound)", () => {
    const a = analyzeDatePredicates("created_at:<2026-09-01");
    expect(a.createdAtLowerIso).toBeNull();
    expect(a.indeterminate).toBe(true);
  });

  test("updated_at-only is indeterminate", () => {
    const a = analyzeDatePredicates("updated_at:>=2026-08-01");
    expect(a.createdAtLowerIso).toBeNull();
    expect(a.indeterminate).toBe(true);
  });

  test("created_at lower plus updated_at is safe (conjunctive created_at present)", () => {
    const a = analyzeDatePredicates(
      "created_at:>=2026-08-01 updated_at:>=2026-08-15",
    );
    expect(a.createdAtLowerIso).toBe("2026-08-01T00:00:00.000Z");
    expect(a.indeterminate).toBe(false);
  });

  test("AND is not OR", () => {
    const a = analyzeDatePredicates(
      "created_at:>=2026-08-01 AND updated_at:>=2026-08-15",
    );
    expect(a.hasOr).toBe(false);
    expect(a.indeterminate).toBe(false);
  });
});

describe("extractDateBounds", () => {
  test("lower is the EARLIEST of all non-negated lowers (reach, not tightness)", () => {
    const b = extractDateBounds(
      "created_at:>=2020-01-01 created_at:>=2026-08-01",
    );
    expect(b.lower).toBe("2020-01-01T00:00:00.000Z");
    expect(b.fields).toEqual(["created_at"]);
  });

  test("upper is the min of uppers; upper-only leaves lower null", () => {
    const b = extractDateBounds("created_at:<2024-06-01");
    expect(b.lower).toBeNull();
    expect(b.upper).toBe("2024-06-01T00:00:00.000Z");
    const tightest = extractDateBounds(
      "created_at:<=2025-06-01 created_at:<=2024-06-01",
    );
    expect(tightest.upper).toBe("2024-06-01T23:59:59.999Z");
  });

  test("ignores negated and malformed predicates", () => {
    expect(extractDateBounds("-created_at:>=2024-01-01")).toEqual({
      lower: null,
      upper: null,
      fields: [],
    });
    expect(extractDateBounds("created_at:>=garbage")).toEqual({
      lower: null,
      upper: null,
      fields: [],
    });
  });

  test("records processed_at / updated_at fields", () => {
    const b = extractDateBounds(
      "processed_at:>=2024-01-01 updated_at:<=2024-06-01",
    );
    expect(b.fields).toEqual(["processed_at", "updated_at"]);
    expect(b.lower).toBe("2024-01-01T00:00:00.000Z");
  });

  test("never throws on null or garbage", () => {
    expect(extractDateBounds(null)).toEqual({
      lower: null,
      upper: null,
      fields: [],
    });
    expect(extractDateBounds(undefined)).toEqual({
      lower: null,
      upper: null,
      fields: [],
    });
    expect(extractDateBounds("created_at:>=garbage status:open")).toEqual({
      lower: null,
      upper: null,
      fields: [],
    });
  });
});

describe("assertRangeVisible", () => {
  test("PRD regression: 2024-01-01..2024-12-31 without read_all_orders throws", () => {
    const err = expectBeforeHorizon(() =>
      assertRangeVisible({
        scopes: SCOPES_ORDERS,
        sinceIso: "2024-01-01T00:00:00.000Z",
        untilIso: "2024-12-31T23:59:59.999Z",
        nowMs: NOW_MS,
        tz: CHICAGO,
        requestedSince: "2024-01-01",
        requestedUntil: "2024-12-31",
      }),
    );
    expect(err.requestedSince).toBe("2024-01-01");
    expect(err.requestedUntil).toBe("2024-12-31");
    expect(err.message).toContain("2024-01-01");
    expect(err.message).toContain("2024-12-31");
    expect(err.horizonShopDate).toBe(localDate(HORIZON, CHICAGO));
  });

  test("read_all_orders present never throws, even for 2024", () => {
    expect(() =>
      assertRangeVisible({
        scopes: SCOPES_ALL,
        sinceIso: "2024-01-01T00:00:00.000Z",
        untilIso: "2024-12-31T23:59:59.999Z",
        nowMs: NOW_MS,
      }),
    ).not.toThrow();
  });

  test("inside the window does not throw", () => {
    const info = assertRangeVisible({
      scopes: SCOPES_ORDERS,
      sinceIso: "2026-08-01T00:00:00.000Z",
      untilIso: "2026-09-01T00:00:00.000Z",
      nowMs: NOW_MS,
    });
    expect(info.scope_missing).toBe(READ_ALL_ORDERS);
  });

  test("instant equal to the horizon is visible; one ms before is not", () => {
    expect(() =>
      assertRangeVisible({
        scopes: SCOPES_ORDERS,
        sinceIso: HORIZON,
        nowMs: NOW_MS,
      }),
    ).not.toThrow();
    expectBeforeHorizon(() =>
      assertRangeVisible({
        scopes: SCOPES_ORDERS,
        sinceIso: new Date(Date.parse(HORIZON) - 1).toISOString(),
        nowMs: NOW_MS,
      }),
    );
  });

  test("untilIso is probed only when sinceIso is null", () => {
    expectBeforeHorizon(() =>
      assertRangeVisible({
        scopes: SCOPES_ORDERS,
        sinceIso: null,
        untilIso: "2024-06-01T00:00:00.000Z",
        nowMs: NOW_MS,
      }),
    );
    expect(() =>
      assertRangeVisible({
        scopes: SCOPES_ORDERS,
        sinceIso: null,
        untilIso: "2026-08-01T00:00:00.000Z",
        nowMs: NOW_MS,
      }),
    ).not.toThrow();
  });

  test("both bounds null does not throw", () => {
    expect(() =>
      assertRangeVisible({ scopes: SCOPES_ORDERS, nowMs: NOW_MS }),
    ).not.toThrow();
  });

  test("empty sinceIso falls through to untilIso", () => {
    expectBeforeHorizon(() =>
      assertRangeVisible({
        scopes: SCOPES_ORDERS,
        sinceIso: "",
        untilIso: "2024-06-01T00:00:00.000Z",
        nowMs: NOW_MS,
      }),
    );
    expect(() =>
      assertRangeVisible({
        scopes: SCOPES_ORDERS,
        sinceIso: "",
        untilIso: "",
        nowMs: NOW_MS,
      }),
    ).not.toThrow();
  });
});

describe("guardOrderQuery", () => {
  test("PRD regression: created_at range 2024-01-01..2024-12-31 throws", () => {
    expectBeforeHorizon(() =>
      guard("created_at:2024-01-01..2024-12-31"),
    );
  });

  test("created_at:>=2025-01-01 is before the horizon", () => {
    expectBeforeHorizon(() => guard("created_at:>=2025-01-01"));
  });

  test("created_at:<2024-06-01 is indeterminate (upper-only)", () => {
    expectIndeterminate(() => guard("created_at:<2024-06-01"));
  });

  test("created_at:2024 (year equality) is before the horizon", () => {
    expectBeforeHorizon(() => guard("created_at:2024"));
  });

  test("created_at:<=2024 is indeterminate (upper-only)", () => {
    expectIndeterminate(() => guard("created_at:<=2024"));
  });

  test("quoted ISO before the horizon throws before_horizon", () => {
    expectBeforeHorizon(() =>
      guard("created_at:'2020-10-21T23:39:20Z'"),
    );
  });

  test("status:open created_at:>=2026-08-01 inside the window does not throw", () => {
    const info = guard("status:open created_at:>=2026-08-01");
    expect(info.horizon).toBe(HORIZON);
    expect(info.scope_missing).toBe(READ_ALL_ORDERS);
  });

  test("negated created_at is indeterminate (not ignored)", () => {
    expectIndeterminate(() => guard("-created_at:>=2026-08-01"));
    expectIndeterminate(() => guard("NOT created_at:>=2024-01-01"));
  });

  test("malformed created_at is indeterminate (not ignored)", () => {
    expectIndeterminate(() => guard("created_at:>=garbage"));
  });

  test("processed_at / updated_at only are indeterminate", () => {
    expectIndeterminate(() => guard("processed_at:>=2026-08-01"));
    expectIndeterminate(() => guard("updated_at:>=2026-08-01"));
  });

  test("OR with dates is indeterminate", () => {
    expectIndeterminate(() =>
      guard("created_at:>=2026-08-01 OR status:open"),
    );
  });

  test("created_at:<2026-09-01 only is indeterminate", () => {
    expectIndeterminate(() => guard("created_at:<2026-09-01"));
  });

  test("created_at:>=2026-08-01 updated_at:>=2026-08-15 is safe", () => {
    expect(() =>
      guard("created_at:>=2026-08-01 updated_at:>=2026-08-15"),
    ).not.toThrow();
  });

  test("created_at:>=<horizon shop date> throws before_horizon (instant compare)", () => {
    const horizonShopDate = localDate(HORIZON, CHICAGO);
    const localMidnight = shopDayStart(horizonShopDate, CHICAGO);
    expect(Date.parse(localMidnight)).toBeLessThan(Date.parse(HORIZON));
    const err = expectBeforeHorizon(() =>
      guard(`created_at:>=${horizonShopDate}`),
    );
    expect(err.reason).toBe("before_horizon");
    // Date-only equality with the shop date is NOT treated as safe: the
    // UTC midnight of that date (how we parse YYYY-MM-DD) is before the
    // horizon instant.
    expect(Date.parse("2026-07-05T00:00:00.000Z")).toBeLessThan(
      Date.parse(HORIZON),
    );
  });

  test("created_at:>2024 throws before_horizon", () => {
    expectBeforeHorizon(() => guard("created_at:>2024"));
  });

  test("two created_at lowers: the later one is effective", () => {
    // Min-of-lowers would treat this as 2020 and throw; AND uses 2026-08-01.
    expect(() =>
      guard("created_at:>=2020-01-01 created_at:>=2026-08-01"),
    ).not.toThrow();
    expectBeforeHorizon(() =>
      guard("created_at:>=2020-01-01 created_at:>=2024-01-01"),
    );
  });

  test("quoted ISO with offset is compared as an instant", () => {
    expect(() =>
      guard("created_at:>='2026-08-01T00:00:00-05:00'"),
    ).not.toThrow();
    expectBeforeHorizon(() =>
      guard("created_at:>='2020-10-21T23:39:20-05:00'"),
    );
  });

  test("with read_all_orders present nothing ever throws", () => {
    const queries = [
      "created_at:2024-01-01..2024-12-31",
      "created_at:<2024-06-01",
      "created_at:>=garbage",
      "-created_at:>=2024-01-01",
      "created_at:>=2026-08-01 OR created_at:>=2020-01-01",
      "updated_at:>=2020-01-01",
      "created_at:>2024",
      null,
      "",
    ];
    for (const query of queries) {
      expect(() => guard(query, SCOPES_ALL)).not.toThrow();
      const info = guard(query, SCOPES_ALL);
      expect(info.scope_missing).toBeNull();
    }
  });

  test("predicates.length === 0 returns info (partial, no throw)", () => {
    for (const query of [null, undefined, "", "status:open", "tag:vip"]) {
      const info = guard(query);
      expect(info.scope_missing).toBe(READ_ALL_ORDERS);
      expect(info.horizon).toBe(HORIZON);
    }
  });
});

describe("firstVisibleDate", () => {
  test("exact-midnight horizon uses that UTC date", () => {
    expect(firstVisibleDate("2026-07-05T00:00:00.000Z")).toBe("2026-07-05");
  });

  test("mid-day horizon uses the next UTC calendar date", () => {
    expect(firstVisibleDate(HORIZON)).toBe("2026-07-06");
    expect(firstVisibleDate("2026-07-05T00:00:00.001Z")).toBe("2026-07-06");
  });
});

describe("guard-accepted advice date", () => {
  test("indeterminate advice date used as created_at:>= is accepted", () => {
    const err = expectIndeterminate(() => guard("created_at:<2026-09-01"));
    expect(err.message).toContain("Earliest accepted bound");
    const match = /created_at:>=(\d{4}-\d{2}-\d{2})/.exec(err.message);
    expect(match).not.toBeNull();
    const date = match![1];
    expect(date).toBe("2026-07-06");
    expect(() => guard(`created_at:>=${date}`)).not.toThrow();
  });

  test("before_horizon message also contains Earliest accepted bound", () => {
    const err = expectBeforeHorizon(() => guard("created_at:>=2025-01-01"));
    expect(err.message).toContain("Earliest accepted bound");
    expect(err.message).toContain("created_at:>=2026-07-06");
  });
});

describe("parenthesised groups", () => {
  test("NOT (created_at:>=X tag:y) is indeterminate", () => {
    expectIndeterminate(() =>
      guard("NOT (created_at:>=2026-08-01 tag:y)"),
    );
  });

  test("-(created_at:>=X tag:y) is indeterminate", () => {
    expectIndeterminate(() =>
      guard("-(created_at:>=2026-08-01 tag:y)"),
    );
  });

  test("tag:a NOT (tag:b created_at:>=X ) is indeterminate", () => {
    expectIndeterminate(() =>
      guard("tag:a NOT (tag:b created_at:>=2026-08-01 )"),
    );
  });

  test("(tag:a OR tag:b) without dates does not throw", () => {
    expect(() => guard("(tag:a OR tag:b)")).not.toThrow();
    const a = analyzeDatePredicates("(tag:a OR tag:b)");
    expect(a.predicates).toEqual([]);
    expect(a.indeterminate).toBe(false);
  });
});

describe("OR token is unquoted uppercase whitespace-delimited", () => {
  test("quoted lowercase or and OR inside a name are allowed", () => {
    expect(() =>
      guard("created_at:>=2026-08-01 tag:'pre or post'"),
    ).not.toThrow();
    expect(() =>
      guard("created_at:>=2026-08-01 name:OR-1234"),
    ).not.toThrow();
    expect(
      analyzeDatePredicates("created_at:>=2026-08-01 tag:'pre or post'").hasOr,
    ).toBe(false);
    expect(
      analyzeDatePredicates("created_at:>=2026-08-01 name:OR-1234").hasOr,
    ).toBe(false);
  });

  test("unquoted uppercase OR is indeterminate", () => {
    expectIndeterminate(() =>
      guard("created_at:>=2026-08-01 OR tag:x"),
    );
    expect(
      analyzeDatePredicates("created_at:>=2026-08-01 OR tag:x").hasOr,
    ).toBe(true);
  });
});

describe("analyzeDatePredicates performance", () => {
  test("8000 repeated predicates (200 kB) analyze in under 200 ms", () => {
    const pred = "created_at:>=2026-08-01 tag:keep ";
    const query = pred.repeat(8000);
    expect(query.length).toBeGreaterThanOrEqual(200_000);
    const t0 = Date.now();
    const a = analyzeDatePredicates(query);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(200);
    expect(a.predicates).toHaveLength(8000);
    expect(a.indeterminate).toBe(false);
  });
});
