/**
 * Shopify bulk-operation runner.
 *
 * Why this exists: tools that need more than a page of orders (or that
 * must walk LineItems as nested connections) cannot do it with ordinary
 * GraphQL pagination -- cost limits and the 60-day `read_orders` wall
 * make that a trap. Shopify's bulk Operation API is the supported
 * path: submit a query, wait out CREATED/RUNNING, download JSONL.
 *
 * Each tool must not reimplement that state machine. This module is the
 * single runner: it submits, waits through the "already in progress" /
 * "limit reached" slot, polls, downloads, and parses. It NEVER calls
 * `bulkOperationCancel` -- cancel races with completion and can strand
 * the shop's single-operation slot, which is worse than waiting.
 *
 * The process-level idle watchdog would otherwise treat a multi-minute
 * poll loop as a dead session. We call `bumpActivity()` on every poll
 * tick so a long-running bulk pull is not killed mid-flight.
 *
 * Pipeline:
 *
 *   innerQuery
 *        |
 *        v
 *   [1 submit]  mutation bulkOperationRunQuery(query: $q)
 *        |
 *        +-- userErrors INVALID / other ------ throw INVALID
 *        +-- LIMIT_REACHED / OPERATION_IN_PROGRESS
 *        |         |  sleep busyRetryIntervalMs
 *        |         +-- until accepted, or busyDeadline -> throw
 *        v
 *   [2 poll]  query bulkOperation(id)
 *        |    bumpActivity + onTick every tick
 *        |    objectCount / fileSize may arrive as strings
 *        |
 *        +-- CREATED / RUNNING -- sleep pollInterval (x1.5, cap max)
 *        +-- objectCount > maxObjects -- throw TOO_MANY_OBJECTS
 *        +-- FAILED ACCESS_DENIED -- throw ACCESS_DENIED (scope missing)
 *        +-- FAILED TIMEOUT ------ throw TIMEOUT (narrower range)
 *        +-- FAILED INTERNAL_SERVER_ERROR -- resubmit step 1 ONCE, then FAIL
 *        +-- FAILED other -------- throw FAILED
 *        +-- CANCELED / CANCELING  throw CANCELED
 *        +-- EXPIRED ------------- throw EXPIRED
 *        +-- past deadlineMs ----- throw DEADLINE (keeps running, not cancelled)
 *        +-- COMPLETED
 *              |
 *              v
 *   [3 download]
 *        +-- objectCount > 0 and url null/empty -> throw INCONSISTENT
 *            (never treat a non-empty operation as rows [])
 *        +-- objectCount 0, url null -> rows []
 *        +-- url -> fetchImpl (network / non-2xx retry once after 1s)
 *                   stream JSONL from response.body (TextDecoder stream:true);
 *                   body null/absent -> response.text() then parseJsonl
 *                   parsed row count !== objectCount -> throw INCONSISTENT
 *
 * JSONL grouping: root objects have no `__parentId`; nested-connection
 * children carry `__parentId` equal to the parent id. List fields
 * (fulfillments, refunds) are inlined on the parent line and are not
 * separate JSONL rows. `groupByParent` / `attachChildren` reassemble
 * connection children without assuming parent-first order.
 */

import type { GraphQLClient } from "graphql-request";
import { gql } from "graphql-request";

import { bumpActivity } from "./lifecycleWatchdog.js";
import { withTransientRetry } from "./toolUtils.js";

// ── Public types ────────────────────────────────────────────────────────

export interface BulkRunOptions {
  /** First poll sleep; backs off x1.5 per in-progress tick. Default 2000. */
  pollIntervalMs?: number;
  /** Cap for the poll backoff. Default 10000. */
  maxPollIntervalMs?: number;
  /** Overall wall from the first submit. Default 10 minutes. */
  deadlineMs?: number;
  /** Sleep between busy (in-progress / limit) resubmits. Default 10000. */
  busyRetryIntervalMs?: number;
  /** Give up waiting for a free bulk slot. Default 5 minutes. */
  busyDeadlineMs?: number;
  /** Abort if Shopify reports more objects than this. Default 250000. */
  maxObjects?: number;
  /** Injected fetch for the JSONL download. Default globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Injected sleeper; tests pass a fake that records delays. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected clock; tests pass a fake so deadlines are deterministic. */
  now?: () => number;
  /** Called with the normalized status node after every poll. */
  onTick?: (op: BulkOperationStatusNode) => void;
}

export interface BulkOperationStatusNode {
  id: string;
  status: string;
  errorCode: string | null;
  objectCount: number;
  rootObjectCount: number;
  fileSize: number | null;
  url: string | null;
  partialDataUrl: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface BulkRunResult {
  id: string;
  objectCount: number;
  rootObjectCount: number;
  rows: Record<string, unknown>[];
  url: string | null;
  elapsedMs: number;
  polls: number;
}

export type BulkOperationErrorCode =
  | "INVALID"
  | "LIMIT_REACHED"
  | "OPERATION_IN_PROGRESS"
  | "FAILED"
  | "CANCELED"
  | "EXPIRED"
  | "TIMEOUT"
  | "ACCESS_DENIED"
  | "TOO_MANY_OBJECTS"
  | "DOWNLOAD_FAILED"
  | "DEADLINE"
  | "INCONSISTENT";

export class BulkOperationError extends Error {
  name = "BulkOperationError";
  code: BulkOperationErrorCode;
  bulkOperationId: string | null;

  constructor(
    code: BulkOperationErrorCode,
    message: string,
    bulkOperationId: string | null = null,
  ) {
    super(message);
    this.name = "BulkOperationError";
    this.code = code;
    this.bulkOperationId = bulkOperationId;
  }
}

export interface GroupedRows {
  roots: Record<string, unknown>[];
  childrenByParent: Map<string, Record<string, unknown>[]>;
}

// ── GraphQL documents ───────────────────────────────────────────────────

const RUN_BULK_QUERY = gql`
  #graphql
  mutation RunBulkQuery($q: String!) {
    bulkOperationRunQuery(query: $q) {
      bulkOperation {
        id
        status
        createdAt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const BULK_OPERATION_STATUS = gql`
  #graphql
  query BulkOperationStatus($id: ID!) {
    bulkOperation(id: $id) {
      id
      status
      errorCode
      objectCount
      rootObjectCount
      fileSize
      url
      partialDataUrl
      createdAt
      completedAt
    }
  }
`;

// ── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_POLL_INTERVAL_MS = 10_000;
const DEFAULT_DEADLINE_MS = 10 * 60 * 1_000;
const DEFAULT_BUSY_RETRY_INTERVAL_MS = 10_000;
const DEFAULT_BUSY_DEADLINE_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_OBJECTS = 250_000;
const DOWNLOAD_RETRY_DELAY_MS = 1_000;

function urlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown-host";
  }
}

interface ResolvedBulkRunOptions {
  pollIntervalMs: number;
  maxPollIntervalMs: number;
  deadlineMs: number;
  busyRetryIntervalMs: number;
  busyDeadlineMs: number;
  maxObjects: number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onTick?: (op: BulkOperationStatusNode) => void;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveOptions(opts: BulkRunOptions = {}): ResolvedBulkRunOptions {
  return {
    pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxPollIntervalMs: opts.maxPollIntervalMs ?? DEFAULT_MAX_POLL_INTERVAL_MS,
    deadlineMs: opts.deadlineMs ?? DEFAULT_DEADLINE_MS,
    busyRetryIntervalMs: opts.busyRetryIntervalMs ?? DEFAULT_BUSY_RETRY_INTERVAL_MS,
    busyDeadlineMs: opts.busyDeadlineMs ?? DEFAULT_BUSY_DEADLINE_MS,
    maxObjects: opts.maxObjects ?? DEFAULT_MAX_OBJECTS,
    fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis),
    sleep: opts.sleep ?? defaultSleep,
    now: opts.now ?? Date.now,
    onTick: opts.onTick,
  };
}

// ── Number / string coercion ────────────────────────────────────────────
// Shopify serializes objectCount and fileSize as strings on bulk status.

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toFileSize(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNullableString(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

// ── Submit helpers ──────────────────────────────────────────────────────

interface UserErrorNode {
  field?: string[] | null;
  message?: string | null;
  code?: string | null;
}

interface SubmittedOperation {
  id: string;
  status: string;
  createdAt: string;
}

type BusyCode = "LIMIT_REACHED" | "OPERATION_IN_PROGRESS";

type SubmitOutcome =
  | { kind: "ok"; op: SubmittedOperation }
  | { kind: "busy"; code: BusyCode; message: string; id: string | null }
  | { kind: "invalid"; message: string; id: string | null };

function busyCodeFromUserError(err: UserErrorNode): BusyCode | null {
  const code = (err.code ?? "").toUpperCase();
  if (code === "OPERATION_IN_PROGRESS") return "OPERATION_IN_PROGRESS";
  if (code === "LIMIT_REACHED") return "LIMIT_REACHED";
  const msg = (err.message ?? "").toLowerCase();
  if (msg.includes("already in progress")) return "OPERATION_IN_PROGRESS";
  if (msg.includes("limit reached")) return "LIMIT_REACHED";
  return null;
}

function interpretSubmit(data: unknown): SubmitOutcome {
  const payload = (data as {
    bulkOperationRunQuery?: {
      bulkOperation?: {
        id?: unknown;
        status?: unknown;
        createdAt?: unknown;
      } | null;
      userErrors?: UserErrorNode[] | null;
    } | null;
  })?.bulkOperationRunQuery;

  const opRaw = payload?.bulkOperation ?? null;
  const id = opRaw?.id == null ? null : String(opRaw.id);
  const errors = payload?.userErrors ?? [];

  for (const err of errors) {
    const busy = busyCodeFromUserError(err);
    if (busy) {
      return {
        kind: "busy",
        code: busy,
        message: err.message ?? `Bulk operation submit busy (${busy})`,
        id,
      };
    }
  }

  if (errors.length > 0) {
    const first = errors[0];
    return {
      kind: "invalid",
      message: first.message ?? "Bulk query was rejected",
      id,
    };
  }

  if (id) {
    return {
      kind: "ok",
      op: {
        id,
        status: String(opRaw?.status ?? ""),
        createdAt: String(opRaw?.createdAt ?? ""),
      },
    };
  }

  return {
    kind: "invalid",
    message: "bulkOperationRunQuery returned no operation",
    id: null,
  };
}

async function submitWithBusyRetry(
  client: GraphQLClient,
  innerQuery: string,
  options: ResolvedBulkRunOptions,
): Promise<SubmittedOperation> {
  const busyStartedAt = options.now();

  while (true) {
    const data = await client.request(RUN_BULK_QUERY, { q: innerQuery });
    const outcome = interpretSubmit(data);

    if (outcome.kind === "ok") {
      return outcome.op;
    }

    if (outcome.kind === "invalid") {
      throw new BulkOperationError("INVALID", outcome.message, outcome.id);
    }

    if (options.now() - busyStartedAt >= options.busyDeadlineMs) {
      throw new BulkOperationError(
        outcome.code,
        `Bulk operation submit still busy (${outcome.code}) after ${options.busyDeadlineMs}ms: ${outcome.message}`,
        outcome.id,
      );
    }

    await options.sleep(options.busyRetryIntervalMs);
  }
}

// ── Poll helpers ────────────────────────────────────────────────────────

interface RawStatusNode {
  id?: unknown;
  status?: unknown;
  errorCode?: unknown;
  objectCount?: unknown;
  rootObjectCount?: unknown;
  fileSize?: unknown;
  url?: unknown;
  partialDataUrl?: unknown;
  createdAt?: unknown;
  completedAt?: unknown;
}

function normalizeStatusNode(
  raw: RawStatusNode | null | undefined,
  fallbackId: string,
): BulkOperationStatusNode {
  if (!raw || raw.id == null) {
    throw new BulkOperationError(
      "FAILED",
      `bulkOperation status returned no node for ${fallbackId}`,
      fallbackId,
    );
  }
  return {
    id: String(raw.id),
    status: String(raw.status ?? ""),
    errorCode: raw.errorCode == null ? null : String(raw.errorCode),
    objectCount: toCount(raw.objectCount),
    rootObjectCount: toCount(raw.rootObjectCount),
    fileSize: toFileSize(raw.fileSize),
    url: toNullableString(raw.url),
    partialDataUrl: toNullableString(raw.partialDataUrl),
    createdAt: String(raw.createdAt ?? ""),
    completedAt: raw.completedAt == null ? null : String(raw.completedAt),
  };
}

function throwFailedStatus(node: BulkOperationStatusNode): never {
  const errorCode = node.errorCode;
  if (errorCode === "ACCESS_DENIED") {
    throw new BulkOperationError(
      "ACCESS_DENIED",
      `Bulk operation ${node.id} failed with errorCode=ACCESS_DENIED; a required access scope is missing`,
      node.id,
    );
  }
  if (errorCode === "TIMEOUT") {
    throw new BulkOperationError(
      "TIMEOUT",
      `Bulk operation ${node.id} failed with errorCode=TIMEOUT; use a narrower date range`,
      node.id,
    );
  }
  throw new BulkOperationError(
    "FAILED",
    `Bulk operation ${node.id} failed with errorCode=${errorCode ?? "unknown"}`,
    node.id,
  );
}

type PollEnd =
  | { kind: "completed"; node: BulkOperationStatusNode; polls: number }
  | { kind: "ise"; node: BulkOperationStatusNode; polls: number };

async function pollUntilDone(
  client: GraphQLClient,
  operationId: string,
  options: ResolvedBulkRunOptions,
  startedAt: number,
): Promise<PollEnd> {
  let interval = options.pollIntervalMs;
  let polls = 0;

  while (true) {
    if (options.now() - startedAt >= options.deadlineMs) {
      throw new BulkOperationError(
        "DEADLINE",
        `Bulk operation ${operationId} did not finish within ${options.deadlineMs / 1000} s; it keeps running on Shopify (not cancelled). Narrow the date range or retry later.`,
        operationId,
      );
    }

    bumpActivity();
    const data = await withTransientRetry(
      () => client.request(BULK_OPERATION_STATUS, { id: operationId }),
      { attempts: 3, delaysMs: [1000, 2000, 4000], sleep: options.sleep },
    );
    polls += 1;
    const raw = (data as { bulkOperation?: RawStatusNode | null })?.bulkOperation;
    const node = normalizeStatusNode(raw, operationId);
    if (options.onTick) {
      options.onTick(node);
    }

    if (node.objectCount > options.maxObjects) {
      throw new BulkOperationError(
        "TOO_MANY_OBJECTS",
        `Bulk operation ${node.id} reported objectCount=${node.objectCount} which exceeds maxObjects=${options.maxObjects}; use a narrower date range`,
        node.id,
      );
    }

    const status = node.status.toUpperCase();

    if (status === "COMPLETED") {
      return { kind: "completed", node, polls };
    }

    if (status === "FAILED") {
      if (node.errorCode === "INTERNAL_SERVER_ERROR") {
        return { kind: "ise", node, polls };
      }
      throwFailedStatus(node);
    }

    if (status === "CANCELED" || status === "CANCELING") {
      throw new BulkOperationError(
        "CANCELED",
        `Bulk operation ${node.id} was canceled`,
        node.id,
      );
    }

    if (status === "EXPIRED") {
      throw new BulkOperationError(
        "EXPIRED",
        `Bulk operation ${node.id} expired`,
        node.id,
      );
    }

    if (status !== "CREATED" && status !== "RUNNING") {
      throw new BulkOperationError(
        "FAILED",
        `Bulk operation ${node.id} entered unexpected status ${node.status}`,
        node.id,
      );
    }

    await options.sleep(interval);
    interval = Math.min(interval * 1.5, options.maxPollIntervalMs);
  }
}

// ── Download ────────────────────────────────────────────────────────────

async function downloadJsonlResponse(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  bulkOperationId: string,
): Promise<Response> {
  const once = async (): Promise<Response> => {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading bulk results`);
    }
    return response;
  };

  try {
    return await once();
  } catch {
    await sleep(DOWNLOAD_RETRY_DELAY_MS);
    try {
      return await once();
    } catch (secondErr) {
      const detail =
        secondErr instanceof Error ? secondErr.message : String(secondErr);
      throw new BulkOperationError(
        "DOWNLOAD_FAILED",
        `Failed to download results for bulk operation ${bulkOperationId} from ${urlHost(url)}: ${detail}`,
        bulkOperationId,
      );
    }
  }
}

async function rowsFromResponse(
  response: Response,
): Promise<Record<string, unknown>[]> {
  const body = response.body;
  if (body == null) {
    return parseJsonl(await response.text());
  }
  return parseJsonlStream(body);
}

// ── Public runner ───────────────────────────────────────────────────────

/**
 * Submit `innerQuery` as a bulk operation, poll until COMPLETED, download
 * and parse the JSONL. Never cancels a running operation.
 */
export async function runBulkQuery(
  client: GraphQLClient,
  innerQuery: string,
  opts: BulkRunOptions = {},
): Promise<BulkRunResult> {
  const options = resolveOptions(opts);
  const startedAt = options.now();
  let polls = 0;
  let iseRetried = false;

  while (true) {
    const submitted = await submitWithBusyRetry(client, innerQuery, options);

    const end = await pollUntilDone(client, submitted.id, options, startedAt);
    polls += end.polls;

    if (end.kind === "ise") {
      if (iseRetried) {
        throwFailedStatus(end.node);
      }
      iseRetried = true;
      continue;
    }

    const node = end.node;
    if (!node.url) {
      if (node.objectCount > 0) {
        throw new BulkOperationError(
          "INCONSISTENT",
          `Bulk operation ${node.id} completed with ${node.objectCount} objects but no result URL; refusing to treat it as empty`,
          node.id,
        );
      }
      return {
        id: node.id,
        objectCount: node.objectCount,
        rootObjectCount: node.rootObjectCount,
        rows: [],
        url: node.url,
        elapsedMs: options.now() - startedAt,
        polls,
      };
    }

    const response = await downloadJsonlResponse(
      node.url,
      options.fetchImpl,
      options.sleep,
      node.id,
    );
    const rows = await rowsFromResponse(response);
    if (rows.length !== node.objectCount) {
      throw new BulkOperationError(
        "INCONSISTENT",
        `parsed ${rows.length} rows but Shopify reported ${node.objectCount} objects`,
        node.id,
      );
    }

    return {
      id: node.id,
      objectCount: node.objectCount,
      rootObjectCount: node.rootObjectCount,
      rows,
      url: node.url,
      elapsedMs: options.now() - startedAt,
      polls,
    };
  }
}

// ── JSONL helpers ───────────────────────────────────────────────────────

function parseJsonlLine(
  line: string,
  lineNumber: number,
): Record<string, unknown> | null {
  if (line.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Malformed JSONL at line ${lineNumber}: ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      `Malformed JSONL at line ${lineNumber}: expected a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse a JSONL body: one JSON object per line. Blank lines are skipped.
 * A malformed line throws with a 1-based line number (physical, including
 * blanks) so callers can point at the exact row in the download.
 */
export function parseJsonl(text: string): Record<string, unknown>[] {
  if (text === "") return [];
  const rows: Record<string, unknown>[] = [];
  let start = 0;
  let lineNumber = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    let line = text.slice(start, end);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lineNumber += 1;
    const row = parseJsonlLine(line, lineNumber);
    if (row) rows.push(row);
    if (nl === -1) break;
    start = nl + 1;
  }
  return rows;
}

/**
 * Stream-parse JSONL from a Web ReadableStream. Decodes with
 * `{stream:true}`, splits on "\n" (strips a trailing CR), and parses each
 * complete line immediately into the rows array. The only leftover is the
 * incomplete trailing line across chunk boundaries; there is no full-text
 * buffer and no lines array.
 */
async function parseJsonlStream(
  body: ReadableStream<Uint8Array>,
): Promise<Record<string, unknown>[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const rows: Record<string, unknown>[] = [];
  let leftover = "";
  let lineNumber = 0;

  const consumeChunk = (chunk: string, final: boolean): void => {
    leftover += chunk;
    let nl = leftover.indexOf("\n");
    while (nl >= 0) {
      let line = leftover.slice(0, nl);
      leftover = leftover.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lineNumber += 1;
      const row = parseJsonlLine(line, lineNumber);
      if (row) rows.push(row);
      nl = leftover.indexOf("\n");
    }
    if (final && leftover.length > 0) {
      let line = leftover;
      leftover = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      lineNumber += 1;
      const row = parseJsonlLine(line, lineNumber);
      if (row) rows.push(row);
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        consumeChunk(decoder.decode(), true);
        break;
      }
      consumeChunk(decoder.decode(value, { stream: true }), false);
    }
  } finally {
    reader.releaseLock();
  }
  return rows;
}

function parentIdOf(row: Record<string, unknown>): string | null {
  const raw = row.__parentId;
  if (raw == null) return null;
  const s = String(raw);
  return s.length > 0 ? s : null;
}

/**
 * Split JSONL rows into roots (no `__parentId`) and children grouped by
 * parent id. Does not assume parent-first or adjacent ordering. A child
 * whose parent never appears is still kept under its `__parentId` key.
 */
export function groupByParent(rows: Record<string, unknown>[]): GroupedRows {
  const roots: Record<string, unknown>[] = [];
  const childrenByParent = new Map<string, Record<string, unknown>[]>();

  for (const row of rows) {
    const parentId = parentIdOf(row);
    if (parentId === null) {
      roots.push(row);
      continue;
    }
    const bucket = childrenByParent.get(parentId);
    if (bucket) {
      bucket.push(row);
    } else {
      childrenByParent.set(parentId, [row]);
    }
  }

  return { roots, childrenByParent };
}

/**
 * Return roots with `childKey` set to the children whose id starts with
 * `gid://shopify/${kindPrefix}/` (e.g. kindPrefix "LineItem").
 */
export function attachChildren<T extends Record<string, unknown>>(
  rows: Record<string, unknown>[],
  childKey: string,
  kindPrefix: string,
): T[] {
  const { roots, childrenByParent } = groupByParent(rows);
  const prefix = `gid://shopify/${kindPrefix}/`;
  return roots.map((root) => {
    const parentId = root.id == null ? "" : String(root.id);
    const children = (childrenByParent.get(parentId) ?? []).filter((child) => {
      return typeof child.id === "string" && child.id.startsWith(prefix);
    });
    return { ...root, [childKey]: children } as T;
  });
}
