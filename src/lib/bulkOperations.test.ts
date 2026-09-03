// Regression tests for the Shopify bulk-operation runner.
//
// The runner is I/O: GraphQL submit/poll plus HTTP download. Every test
// injects a fake client, fake fetch, fake sleep, and fake clock so we
// never touch the network. These tests must FAIL if the state machine is
// missing and PASS once submit -> poll -> download is wired correctly.

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import type { GraphQLClient } from "graphql-request";

import {
  _getLastActivityMs,
  _resetForTest,
} from "./lifecycleWatchdog.js";
import {
  attachChildren,
  BulkOperationError,
  groupByParent,
  parseJsonl,
  runBulkQuery,
  type BulkOperationStatusNode,
  type BulkRunOptions,
} from "./bulkOperations.js";

afterEach(() => {
  _resetForTest();
});

const INNER = "{ orders { id name } }";
const OP_ID = "gid://shopify/BulkOperation/99";
const OP_ID_2 = "gid://shopify/BulkOperation/100";
const RESULT_URL = "https://storage.example.test/bulk-result.jsonl";

const JSONL_BODY = [
  '{"id":"gid://shopify/Order/1","name":"#1"}',
  '{"id":"gid://shopify/LineItem/1","__parentId":"gid://shopify/Order/1","sku":"ABC"}',
  "",
].join("\n");

// ── Fakes ───────────────────────────────────────────────────────────────

function fakeClock(start = 0) {
  let t = start;
  const delays: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      delays.push(ms);
      t += ms;
    },
    delays,
  };
}

function fakeClient(responses: unknown[]) {
  let i = 0;
  const request = jest.fn(async () => {
    if (i >= responses.length) {
      throw new Error(`unexpected extra GraphQL request (index ${i})`);
    }
    const next = responses[i];
    i += 1;
    if (next instanceof Error) {
      throw next;
    }
    return next;
  });
  const client = {
    request,
    rawRequest: jest.fn(),
  } as unknown as GraphQLClient;
  return { client, request };
}

function submitOk(id = OP_ID, status = "CREATED") {
  return {
    bulkOperationRunQuery: {
      bulkOperation: {
        id,
        status,
        createdAt: "2026-01-01T00:00:00Z",
      },
      userErrors: [],
    },
  };
}

function submitErrors(
  errors: Array<{ message: string; code?: string | null; field?: string[] | null }>,
  op: { id: string; status: string } | null = null,
) {
  return {
    bulkOperationRunQuery: {
      bulkOperation: op,
      userErrors: errors,
    },
  };
}

function pollNode(
  partial: Partial<{
    id: string;
    status: string;
    errorCode: string | null;
    objectCount: unknown;
    rootObjectCount: unknown;
    fileSize: unknown;
    url: string | null;
    partialDataUrl: string | null;
    createdAt: string;
    completedAt: string | null;
  }>,
) {
  return {
    bulkOperation: {
      id: OP_ID,
      status: "RUNNING",
      errorCode: null,
      objectCount: 0,
      rootObjectCount: 0,
      fileSize: null,
      url: null,
      partialDataUrl: null,
      createdAt: "2026-01-01T00:00:00Z",
      completedAt: null,
      ...partial,
    },
  };
}

function okFetch(body = JSONL_BODY): typeof fetch {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    body: null,
    text: async () => body,
  }));
  return fetchMock as unknown as typeof fetch;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function streamFetch(
  chunks: string[],
  textImpl?: () => Promise<string>,
): typeof fetch {
  const fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    body: streamFromChunks(chunks),
    text:
      textImpl ??
      (async () => {
        throw new Error("text() should not be called when body is a stream");
      }),
  }));
  return fetchMock as unknown as typeof fetch;
}

function documentBody(doc: unknown): string {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc === "object") {
    const loc = (doc as { loc?: { source?: { body?: string } } }).loc;
    if (typeof loc?.source?.body === "string") return loc.source.body;
  }
  try {
    return JSON.stringify(doc) ?? "";
  } catch {
    return "";
  }
}

function expectNoCancel(request: { mock: { calls: unknown[][] } }) {
  for (const call of request.mock.calls) {
    expect(documentBody(call[0])).not.toMatch(/bulkOperationCancel/);
  }
}

async function expectBulkReject(
  promise: Promise<unknown>,
): Promise<BulkOperationError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BulkOperationError);
    return err as BulkOperationError;
  }
  throw new Error("expected runBulkQuery to reject");
}

function runOpts(
  clock: ReturnType<typeof fakeClock>,
  extra: BulkRunOptions = {},
): BulkRunOptions {
  return {
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  };
}

// ── parseJsonl ──────────────────────────────────────────────────────────

describe("parseJsonl", () => {
  test("parses objects and skips blank lines", () => {
    const text = [
      '{"id":"a"}',
      "",
      "  ",
      '{"id":"b","n":1}',
      "\t",
      '{"id":"c"}',
    ].join("\n");
    expect(parseJsonl(text)).toEqual([
      { id: "a" },
      { id: "b", n: 1 },
      { id: "c" },
    ]);
  });

  test("empty string and only blanks yield []", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("\n\n  \n")).toEqual([]);
  });

  test("malformed line names line 2", () => {
    const text = '{"id":"ok"}\nnot-json\n{"id":"later"}';
    expect(() => parseJsonl(text)).toThrow(/line 2/);
  });

  test("CRLF line breaks still number physical lines", () => {
    const text = '{"id":"ok"}\r\n{bad';
    expect(() => parseJsonl(text)).toThrow(/line 2/);
  });

  test.each([
    ["null", "null"],
    ["array", "[1,2]"],
    ["string", '"nope"'],
    ["number", "12"],
  ])("non-object JSON (%s) is malformed", (_label, line) => {
    const text = `{"id":"ok"}\n${line}`;
    expect(() => parseJsonl(text)).toThrow(/line 2/);
    expect(() => parseJsonl(text)).toThrow(/expected a JSON object/);
  });
});

// ── groupByParent / attachChildren ──────────────────────────────────────

describe("groupByParent", () => {
  test("handles children before parents and keeps orphans", () => {
    const earlyChild = {
      id: "gid://shopify/LineItem/1",
      __parentId: "gid://shopify/Order/1",
    };
    const parent = { id: "gid://shopify/Order/1", name: "#1" };
    const orphan = {
      id: "gid://shopify/LineItem/9",
      __parentId: "gid://shopify/Order/missing",
    };
    const laterChild = {
      id: "gid://shopify/LineItem/2",
      __parentId: "gid://shopify/Order/1",
    };
    const emptyParentId = { id: "gid://shopify/Order/2", __parentId: "" };
    const numericParent = { id: "c-num", __parentId: 99 };

    const grouped = groupByParent([
      earlyChild,
      orphan,
      parent,
      laterChild,
      emptyParentId,
      numericParent,
    ]);

    expect(grouped.roots).toEqual([parent, emptyParentId]);
    expect(grouped.childrenByParent.get("gid://shopify/Order/1")).toEqual([
      earlyChild,
      laterChild,
    ]);
    expect(grouped.childrenByParent.get("gid://shopify/Order/missing")).toEqual([
      orphan,
    ]);
    expect(grouped.childrenByParent.get("99")).toEqual([numericParent]);
    expect(grouped.roots.find((r) => r.id === orphan.id)).toBeUndefined();
  });

  test("empty input", () => {
    const grouped = groupByParent([]);
    expect(grouped.roots).toEqual([]);
    expect(grouped.childrenByParent.size).toBe(0);
  });
});

describe("attachChildren", () => {
  test("attaches only children whose id matches the kind prefix", () => {
    const rows = [
      {
        id: "gid://shopify/LineItem/1",
        __parentId: "gid://shopify/Order/1",
        sku: "A",
      },
      { id: "gid://shopify/Order/1", name: "#1" },
      {
        id: "gid://shopify/Fulfillment/1",
        __parentId: "gid://shopify/Order/1",
      },
      {
        id: "gid://shopify/LineItem/2",
        __parentId: "gid://shopify/Order/1",
        sku: "B",
      },
      {
        id: "gid://shopify/LineItem/9",
        __parentId: "gid://shopify/Order/missing",
      },
      { id: "gid://shopify/Order/2", name: "#2" },
    ];

    const result = attachChildren<{
      id: string;
      name?: string;
      lineItems: Record<string, unknown>[];
    }>(rows, "lineItems", "LineItem");

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("gid://shopify/Order/1");
    expect(result[0].name).toBe("#1");
    expect(result[0].lineItems).toEqual([
      {
        id: "gid://shopify/LineItem/1",
        __parentId: "gid://shopify/Order/1",
        sku: "A",
      },
      {
        id: "gid://shopify/LineItem/2",
        __parentId: "gid://shopify/Order/1",
        sku: "B",
      },
    ]);
    expect(result[1].id).toBe("gid://shopify/Order/2");
    expect(result[1].lineItems).toEqual([]);
  });

  test("does not mutate the input rows", () => {
    const parent = { id: "gid://shopify/Order/1" };
    const child = {
      id: "gid://shopify/LineItem/1",
      __parentId: "gid://shopify/Order/1",
    };
    const rows = [parent, child];
    attachChildren(rows, "lineItems", "LineItem");
    expect(parent).toEqual({ id: "gid://shopify/Order/1" });
    expect(rows).toHaveLength(2);
  });

  test("root without id gets an empty child array; non-string child ids are dropped", () => {
    const rows = [
      { name: "no-id" },
      { id: 123, __parentId: "missing" },
      {
        id: "gid://shopify/LineItem/1",
        __parentId: "gid://shopify/Order/1",
      },
      { id: "gid://shopify/Order/1" },
    ];
    const result = attachChildren(rows, "lineItems", "LineItem");
    expect(result[0].name).toBe("no-id");
    expect(result[0].lineItems).toEqual([]);
    expect(result[1].id).toBe("gid://shopify/Order/1");
    expect(result[1].lineItems).toHaveLength(1);
  });
});

// ── runBulkQuery ────────────────────────────────────────────────────────

describe("runBulkQuery", () => {
  test("submit -> RUNNING -> RUNNING -> RUNNING -> COMPLETED with url parses rows, counts polls, bumps activity, backoff 2000/3000/4500", async () => {
    _resetForTest();
    const before = _getLastActivityMs();
    await new Promise((r) => setTimeout(r, 8));

    const clock = fakeClock();
    const ticks: BulkOperationStatusNode[] = [];
    const fetchImpl = okFetch();
    const { client, request } = fakeClient([
      submitOk(),
      pollNode({ status: "RUNNING", objectCount: "1" }),
      pollNode({ status: "RUNNING", objectCount: "2" }),
      pollNode({ status: "RUNNING", objectCount: "3" }),
      pollNode({
        status: "COMPLETED",
        objectCount: "2",
        rootObjectCount: "1",
        fileSize: "88",
        url: RESULT_URL,
        completedAt: "2026-01-01T00:01:00Z",
      }),
    ]);

    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, {
        fetchImpl,
        onTick: (op) => ticks.push(op),
      }),
    );

    expect(result.id).toBe(OP_ID);
    expect(result.objectCount).toBe(2);
    expect(result.rootObjectCount).toBe(1);
    expect(result.url).toBe(RESULT_URL);
    expect(result.polls).toBe(4);
    expect(result.elapsedMs).toBe(2000 + 3000 + 4500);
    expect(result.rows).toEqual([
      { id: "gid://shopify/Order/1", name: "#1" },
      {
        id: "gid://shopify/LineItem/1",
        __parentId: "gid://shopify/Order/1",
        sku: "ABC",
      },
    ]);
    expect(clock.delays).toEqual([2000, 3000, 4500]);
    expect(ticks).toHaveLength(4);
    expect(ticks[3].fileSize).toBe(88);
    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[0][1]).toEqual({ q: INNER });
    expect(request.mock.calls[1][1]).toEqual({ id: OP_ID });
    expect(_getLastActivityMs()).toBeGreaterThan(before);
    expectNoCancel(request);
  });

  test("poll backoff is capped at 10000", async () => {
    const clock = fakeClock();
    const running = pollNode({ status: "RUNNING" });
    const { client } = fakeClient([
      submitOk(),
      running,
      running,
      running,
      running,
      running,
      running,
      pollNode({ status: "COMPLETED", url: null }),
    ]);

    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.polls).toBe(7);
    expect(clock.delays).toEqual([2000, 3000, 4500, 6750, 10000, 10000]);
    expect(Math.max(...clock.delays)).toBe(10000);
  });

  test("COMPLETED with url null yields rows [] and does not fetch", async () => {
    const clock = fakeClock();
    const fetchImpl = jest.fn(async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;
    const { client } = fakeClient([
      submitOk(),
      pollNode({
        status: "COMPLETED",
        url: null,
        objectCount: undefined,
        rootObjectCount: undefined,
      }),
    ]);

    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { fetchImpl }),
    );
    expect(result.rows).toEqual([]);
    expect(result.url).toBeNull();
    expect(result.polls).toBe(1);
    expect(result.objectCount).toBe(0);
    expect(clock.delays).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("CREATED is treated as in-progress like RUNNING", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "CREATED" }),
      pollNode({ status: "COMPLETED", url: null }),
    ]);
    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.polls).toBe(2);
    expect(clock.delays).toEqual([2000]);
  });

  test("default sleep is setTimeout-based (tiny interval, first poll in-progress)", async () => {
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "RUNNING" }),
      pollNode({ status: "COMPLETED", url: null }),
    ]);
    const result = await runBulkQuery(client, INNER, { pollIntervalMs: 5 });
    expect(result.rows).toEqual([]);
    expect(result.polls).toBe(2);
  });

  test("OPERATION_IN_PROGRESS twice then success", async () => {
    const clock = fakeClock();
    const { client, request } = fakeClient([
      submitErrors([
        { code: "OPERATION_IN_PROGRESS", message: "already running" },
      ]),
      submitErrors([
        { code: "OPERATION_IN_PROGRESS", message: "already running" },
      ]),
      submitOk(),
      pollNode({ status: "COMPLETED", url: null }),
    ]);

    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.polls).toBe(1);
    expect(clock.delays).toEqual([10000, 10000]);
    expect(request).toHaveBeenCalledTimes(4);
    expectNoCancel(request);
  });

  test("busy via message 'already in progress' then success", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitErrors([
        { message: "A bulk mutation operation is already in progress" },
      ]),
      submitOk(),
      pollNode({ status: "COMPLETED", url: null }),
    ]);
    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.id).toBe(OP_ID);
    expect(clock.delays).toEqual([10000]);
  });

  test("busy via message 'limit reached' then success", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitErrors([{ message: "The bulk operation limit reached for this shop" }]),
      submitOk(),
      pollNode({ status: "COMPLETED", url: null }),
    ]);
    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.id).toBe(OP_ID);
  });

  test("LIMIT_REACHED past busyDeadline throws with code", async () => {
    const clock = fakeClock();
    const busy = submitErrors([
      { code: "LIMIT_REACHED", message: "too many bulk ops" },
    ]);
    const { client } = fakeClient([busy, busy, busy, busy]);

    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, {
          busyDeadlineMs: 25_000,
          busyRetryIntervalMs: 10_000,
        }),
      ),
    );
    expect(err.code).toBe("LIMIT_REACHED");
    expect(err.message).toMatch(/too many bulk ops/);
    expect(clock.delays).toEqual([10000, 10000, 10000]);
  });

  test("OPERATION_IN_PROGRESS past busyDeadline throws with code", async () => {
    const clock = fakeClock();
    const busy = submitErrors([
      { code: "OPERATION_IN_PROGRESS", message: "wait" },
    ]);
    const { client } = fakeClient([busy, busy]);
    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, { busyDeadlineMs: 0, busyRetryIntervalMs: 10_000 }),
      ),
    );
    expect(err.code).toBe("OPERATION_IN_PROGRESS");
    expect(err.bulkOperationId).toBeNull();
  });

  test("INVALID userError throws INVALID with the message", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitErrors([{ code: "INVALID", message: "syntax error in bulk query" }]),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("INVALID");
    expect(err.message).toMatch(/syntax error in bulk query/);
    expect(err.name).toBe("BulkOperationError");
  });

  test("any other userError is INVALID", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitErrors([{ code: "THROTTLED", message: "slow down" }]),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("INVALID");
    expect(err.message).toMatch(/slow down/);
  });

  test("submit with no operation and no userErrors is INVALID", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      { bulkOperationRunQuery: { bulkOperation: null, userErrors: [] } },
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("INVALID");
    expect(err.bulkOperationId).toBeNull();
  });

  test("FAILED ACCESS_DENIED mentions access scope", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "FAILED", errorCode: "ACCESS_DENIED" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("ACCESS_DENIED");
    expect(err.message).toMatch(/access scope/i);
    expect(err.message).toMatch(/ACCESS_DENIED/);
    expect(err.bulkOperationId).toBe(OP_ID);
  });

  test("FAILED TIMEOUT suggests a narrower range", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "FAILED", errorCode: "TIMEOUT" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toMatch(/narrower/);
    expect(err.message).toMatch(/TIMEOUT/);
  });

  test("FAILED INTERNAL_SERVER_ERROR is resubmitted once then succeeds", async () => {
    const clock = fakeClock();
    const { client, request } = fakeClient([
      submitOk(OP_ID),
      pollNode({
        id: OP_ID,
        status: "FAILED",
        errorCode: "INTERNAL_SERVER_ERROR",
      }),
      submitOk(OP_ID_2),
      pollNode({
        id: OP_ID_2,
        status: "COMPLETED",
        url: null,
        objectCount: 0,
      }),
    ]);
    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.id).toBe(OP_ID_2);
    expect(result.polls).toBe(2);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls[2][1]).toEqual({ q: INNER });
    expect(request.mock.calls[3][1]).toEqual({ id: OP_ID_2 });
  });

  test("FAILED INTERNAL_SERVER_ERROR resubmitted once then fails", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(OP_ID),
      pollNode({
        id: OP_ID,
        status: "FAILED",
        errorCode: "INTERNAL_SERVER_ERROR",
      }),
      submitOk(OP_ID_2),
      pollNode({
        id: OP_ID_2,
        status: "FAILED",
        errorCode: "INTERNAL_SERVER_ERROR",
      }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("FAILED");
    expect(err.message).toMatch(/INTERNAL_SERVER_ERROR/);
    expect(err.bulkOperationId).toBe(OP_ID_2);
  });

  test("FAILED with a different errorCode throws FAILED", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "FAILED", errorCode: null }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("FAILED");
    expect(err.message).toMatch(/unknown/);
  });

  test("CANCELED throws CANCELED", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "CANCELED" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("CANCELED");
    expect(err.bulkOperationId).toBe(OP_ID);
  });

  test("CANCELING throws CANCELED", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "CANCELING" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("CANCELED");
  });

  test("EXPIRED throws EXPIRED", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "EXPIRED" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("EXPIRED");
    expect(err.message).toMatch(/expired/i);
  });

  test("unexpected status throws FAILED", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "NOPE" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("FAILED");
    expect(err.message).toMatch(/NOPE/);
  });

  test("missing status node throws FAILED", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      { bulkOperation: null },
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("FAILED");
    expect(err.bulkOperationId).toBe(OP_ID);
  });

  test("deadline exceeded throws DEADLINE with the operation id in the message", async () => {
    const clock = fakeClock();
    const { client, request } = fakeClient([
      submitOk(),
      pollNode({ status: "RUNNING" }),
      pollNode({ status: "RUNNING" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, { deadlineMs: 2500, pollIntervalMs: 2000 }),
      ),
    );
    expect(err.code).toBe("DEADLINE");
    expect(err.message).toMatch(OP_ID);
    expect(err.message).toMatch(
      /did not finish within 2\.5 s; it keeps running on Shopify \(not cancelled\)/,
    );
    expect(err.message).not.toMatch(/resume/i);
    expect(err.bulkOperationId).toBe(OP_ID);
    expectNoCancel(request);
  });

  test("poll 503 then RUNNING then COMPLETED retries the status request", async () => {
    const clock = fakeClock();
    const err503 = Object.assign(new Error("Service Unavailable"), {
      response: { status: 503 },
    });
    const { client } = fakeClient([
      submitOk(),
      err503,
      pollNode({ status: "RUNNING" }),
      pollNode({ status: "COMPLETED", url: null }),
    ]);
    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { pollIntervalMs: 2000 }),
    );
    expect(result.id).toBe(OP_ID);
    expect(result.polls).toBe(2);
    expect(clock.delays).toContain(1000);
    expect(clock.delays).toContain(2000);
  });

  test("objectCount string 300000 throws TOO_MANY_OBJECTS and suggests a narrower range", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "RUNNING", objectCount: "300000" }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("TOO_MANY_OBJECTS");
    expect(err.message).toMatch(/300000/);
    expect(err.message).toMatch(/narrower date range/);
    expect(err.bulkOperationId).toBe(OP_ID);
  });

  test("COMPLETED with 250000 objects and a null URL throws INCONSISTENT", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({
        status: "COMPLETED",
        url: null,
        objectCount: 250000,
      }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("INCONSISTENT");
    expect(err.message).toBe(
      `Bulk operation ${OP_ID} completed with 250000 objects but no result URL; refusing to treat it as empty`,
    );
    expect(err.bulkOperationId).toBe(OP_ID);
  });

  test("objectCount equal to maxObjects with matching streamed rows is allowed", async () => {
    const clock = fakeClock();
    const fetchImpl = okFetch('{"id":"a"}\n{"id":"b"}');
    const { client } = fakeClient([
      submitOk(),
      pollNode({
        status: "COMPLETED",
        url: RESULT_URL,
        objectCount: 2,
      }),
    ]);
    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { fetchImpl, maxObjects: 2 }),
    );
    expect(result.objectCount).toBe(2);
    expect(result.rows).toEqual([{ id: "a" }, { id: "b" }]);
  });

  test("coerces string counts and treats garbage fileSize/objectCount as empty", async () => {
    const clock = fakeClock();
    const ticks: BulkOperationStatusNode[] = [];
    const { client } = fakeClient([
      submitOk(),
      pollNode({
        status: "RUNNING",
        objectCount: "12",
        rootObjectCount: "4",
        fileSize: "99",
      }),
      pollNode({
        status: "RUNNING",
        objectCount: "nope",
        rootObjectCount: undefined,
        fileSize: "",
      }),
      pollNode({
        status: "COMPLETED",
        url: null,
        objectCount: "12",
        fileSize: "oops",
      }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, { onTick: (op) => ticks.push(op) }),
      ),
    );
    expect(ticks[0]).toMatchObject({
      objectCount: 12,
      rootObjectCount: 4,
      fileSize: 99,
    });
    expect(ticks[1]).toMatchObject({
      objectCount: 0,
      rootObjectCount: 0,
      fileSize: null,
    });
    expect(ticks[2]).toMatchObject({ objectCount: 12, fileSize: null });
    expect(err.code).toBe("INCONSISTENT");
    expect(err.message).toMatch(/completed with 12 objects but no result URL/);
  });

  test("download non-2xx then ok on retry", async () => {
    const clock = fakeClock();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => "unavailable",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{"id":"gid://shopify/Order/1"}',
      });
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: RESULT_URL, objectCount: 1 }),
    ]);

    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { fetchImpl: fetchMock as unknown as typeof fetch }),
    );
    expect(result.rows).toEqual([{ id: "gid://shopify/Order/1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clock.delays).toEqual([1000]);
  });

  test("download failing twice throws DOWNLOAD_FAILED", async () => {
    const clock = fakeClock();
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "err",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "err",
      });
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: RESULT_URL }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, { fetchImpl: fetchMock as unknown as typeof fetch }),
      ),
    );
    expect(err.code).toBe("DOWNLOAD_FAILED");
    expect(err.message).toMatch(/storage\.example\.test/);
    expect(err.message).toContain(OP_ID);
    expect(err.message).not.toContain(RESULT_URL);
    expect(err.bulkOperationId).toBe(OP_ID);
    expect(clock.delays).toEqual([1000]);
  });

  test("DOWNLOAD_FAILED message never includes a signed URL", async () => {
    const clock = fakeClock();
    const signed =
      "https://storage.googleapis.com/bucket/obj?GoogleAccessId=sa@proj.iam.gserviceaccount.com&Signature=abc123XYZ&Expires=1700000000";
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"));
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: signed }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, { fetchImpl: fetchMock as unknown as typeof fetch }),
      ),
    );
    expect(err.code).toBe("DOWNLOAD_FAILED");
    expect(err.message).toContain("storage.googleapis.com");
    expect(err.message).not.toContain("Signature=");
    expect(err.message).not.toContain("GoogleAccessId");
    expect(err.message).not.toContain(signed);
  });

  test("download network error twice throws DOWNLOAD_FAILED", async () => {
    const clock = fakeClock();
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("ECONNRESET"));
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: RESULT_URL }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, { fetchImpl: fetchMock as unknown as typeof fetch }),
      ),
    );
    expect(err.code).toBe("DOWNLOAD_FAILED");
    expect(err.message).toMatch(/ECONNRESET/);
  });

  test("empty url string is treated as no download", async () => {
    const clock = fakeClock();
    const fetchImpl = jest.fn(async () => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch;
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: "" }),
    ]);
    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { fetchImpl }),
    );
    expect(result.rows).toEqual([]);
    expect(result.url).toBeNull();
  });

  test("submit succeeds when userErrors is omitted", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      {
        bulkOperationRunQuery: {
          bulkOperation: {
            id: OP_ID,
            status: "CREATED",
            createdAt: "2026-01-01T00:00:00Z",
          },
        },
      },
      pollNode({ status: "COMPLETED", url: null }),
    ]);
    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.id).toBe(OP_ID);
  });

  test("INVALID userError with no message still throws INVALID", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      { bulkOperationRunQuery: { bulkOperation: null, userErrors: [{}] } },
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("INVALID");
    expect(err.message).toMatch(/rejected/i);
  });

  test("lowercase COMPLETED is accepted", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "completed", url: null }),
    ]);
    const result = await runBulkQuery(client, INNER, runOpts(clock));
    expect(result.polls).toBe(1);
  });

  test("streams JSONL from body delivered in 3 chunks that split a line mid-way", async () => {
    const clock = fakeClock();
    const fetchImpl = streamFetch([
      '{"id":"a"}\n{"id":"b',
      '","n":',
      '1}\n{"id":"c"}\n',
    ]);
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: RESULT_URL, objectCount: 3 }),
    ]);
    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { fetchImpl }),
    );
    expect(result.rows).toEqual([{ id: "a" }, { id: "b", n: 1 }, { id: "c" }]);
    expect(result.objectCount).toBe(3);
  });

  test("body null falls back to text()", async () => {
    const clock = fakeClock();
    const text = jest.fn(async () => '{"id":"from-text"}');
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      body: null,
      text,
    })) as unknown as typeof fetch;
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: RESULT_URL, objectCount: 1 }),
    ]);
    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { fetchImpl }),
    );
    expect(result.rows).toEqual([{ id: "from-text" }]);
    expect(text).toHaveBeenCalledTimes(1);
  });

  test("row-count mismatch after download throws INCONSISTENT", async () => {
    const clock = fakeClock();
    const fetchImpl = okFetch('{"id":"only-one"}');
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: RESULT_URL, objectCount: 2 }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock, { fetchImpl })),
    );
    expect(err.code).toBe("INCONSISTENT");
    expect(err.message).toBe("parsed 1 rows but Shopify reported 2 objects");
    expect(err.bulkOperationId).toBe(OP_ID);
  });

  test("url null with objectCount 0 yields rows []", async () => {
    const clock = fakeClock();
    const fetchImpl = jest.fn(async () => {
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;
    const { client } = fakeClient([
      submitOk(),
      pollNode({
        status: "COMPLETED",
        url: null,
        objectCount: 0,
      }),
    ]);
    const result = await runBulkQuery(
      client,
      INNER,
      runOpts(clock, { fetchImpl }),
    );
    expect(result.rows).toEqual([]);
    expect(result.url).toBeNull();
    expect(result.objectCount).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("empty url string with objectCount > 0 throws INCONSISTENT", async () => {
    const clock = fakeClock();
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: "", objectCount: 4 }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(client, INNER, runOpts(clock)),
    );
    expect(err.code).toBe("INCONSISTENT");
    expect(err.message).toMatch(/completed with 4 objects but no result URL/);
  });

  test("download retry failure with a non-Error still throws DOWNLOAD_FAILED", async () => {
    const clock = fakeClock();
    const fetchMock = jest
      .fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce("not-an-error");
    const { client } = fakeClient([
      submitOk(),
      pollNode({ status: "COMPLETED", url: RESULT_URL }),
    ]);
    const err = await expectBulkReject(
      runBulkQuery(
        client,
        INNER,
        runOpts(clock, { fetchImpl: fetchMock as unknown as typeof fetch }),
      ),
    );
    expect(err.code).toBe("DOWNLOAD_FAILED");
    expect(err.message).toMatch(/not-an-error/);
  });
});
