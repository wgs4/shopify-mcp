// Lifecycle watchdog: self-terminate when orphaned or idle.
//
// Why this exists: on prod this server is spawned per Claude session as an
// ssh-tunneled stdio child (parent = `sshd: itdept@notty`). When a Claude
// session ends abruptly (Conductor workspace closed, laptop sleep, crash),
// the local ssh socket can linger, sshd stays blocked on the child, and the
// Node child never receives stdin EOF or SIGHUP -> it runs forever. Stranded
// fleets of these (~75 MB each, x4 storefronts x N sessions) have repeatedly
// triggered OOM on the shared 8 GB MCP VM and taken down the live xTuple DB
// MCP mid-query. sshd's ClientAlive* settings do NOT catch this trigger, so
// the child must self-terminate independently.
//
// Two mechanisms, both best-effort and fail-safe (a broken watchdog must
// never crash or degrade the server):
//   1. Daemon poll interval (~20s): exits if reparented to init (ppid==1,
//      portable parent-death backstop) or if idle beyond the timeout
//      (catches the lingering-socket case where sshd is still alive but
//      nobody's home).
//   2. last-activity monotonic timestamp bumped by attachActivityToTransport
//      on every inbound MCP message (initialize, ping, tools/list, call_tool,
//      etc.) -- equivalent to fastmcp's on_message middleware.
//
// Limitations (documented, not bugs):
//
//   - No PR_SET_PDEATHSIG. The Python reference uses prctl on Linux for
//     instant kernel-level cleanup. Node has no built-in prctl binding;
//     adding a native addon for one syscall is more cost than benefit
//     (build complexity, supply chain). Per issue #5: "if that's not
//     desirable, skip this mechanism and rely on (2)." We skip. Worst
//     case: ~20s delay vs instant kill -- still solves the OOM accumulation
//     problem this is filed against.
//   - If the event loop is hard-blocked (CPU-bound work in a sync call),
//     setInterval will not fire and the watchdog cannot tick. PDEATHSIG
//     would still work in that scenario. For this small graphql-fronting
//     MCP this is acceptable.
//   - A single tool call that takes longer than the idle timeout will
//     trigger self-exit mid-flight. Same edge case exists in the Python
//     reference. With a 30-minute default, Shopify GraphQL calls should
//     never come close.
//
// Why monotonic time: time.monotonic() in Python; performance.now() in
// Node. Wall-clock jumps (NTP, suspend/resume, manual time change) must
// not register as "idle" or "active" spuriously.
//
// process.exit(0) is used directly (not server.close() then exit) to match
// the Python os._exit(0) intent: a hung async stack must not block teardown
// and the goal here is resource reclamation, not graceful shutdown.

import { performance } from "node:perf_hooks";

import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

const POLL_INTERVAL_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800; // 30 minutes

let lastActivityMs = performance.now();
let pollHandle: NodeJS.Timeout | null = null;

/**
 * Mark the session as active now. Called by the transport interceptor on
 * every inbound MCP message; safe to call from anywhere.
 */
export function bumpActivity(): void {
  lastActivityMs = performance.now();
}

export function _getLastActivityMs(): number {
  return lastActivityMs;
}

export function _resetForTest(): void {
  lastActivityMs = performance.now();
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
}

/**
 * Pure: should the watchdog terminate the process right now?
 *
 * Exits when reparented to init (ppid == 1, i.e. parent sshd died) OR when
 * the process has been idle longer than `idleTimeoutMs`. Kept side-effect-
 * free so unit tests can exercise it without forking or exiting.
 *
 * Strict-greater-than on idle to match the Python reference: at exactly the
 * timeout we stay alive; one tick over and we exit.
 */
export function shouldWatchdogExit(args: {
  ppid: number;
  lastActivityMs: number;
  nowMs: number;
  idleTimeoutMs: number;
}): { exit: boolean; reason?: string } {
  if (args.ppid === 1) {
    return { exit: true, reason: "parent died (reparented to init, ppid=1)" };
  }
  const idleMs = args.nowMs - args.lastActivityMs;
  if (idleMs > args.idleTimeoutMs) {
    const idleS = Math.floor(idleMs / 1000);
    const timeoutS = Math.floor(args.idleTimeoutMs / 1000);
    return {
      exit: true,
      reason: `idle ${idleS}s exceeded timeout ${timeoutS}s`,
    };
  }
  return { exit: false };
}

/**
 * Resolve MCP_IDLE_TIMEOUT_SECONDS defensively.
 *
 * Any non-positive-integer value falls back to the default and emits a
 * warning. A bad env var must never crash the process.
 */
export function resolveIdleTimeoutSeconds(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.MCP_IDLE_TIMEOUT_SECONDS;
  if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_SECONDS;
  const trimmed = String(raw).trim();
  if (!/^-?\d+$/.test(trimmed)) {
    console.error(
      `watchdog: MCP_IDLE_TIMEOUT_SECONDS=${JSON.stringify(raw)} is not a valid ` +
        `positive integer; falling back to default ${DEFAULT_IDLE_TIMEOUT_SECONDS}s`
    );
    return DEFAULT_IDLE_TIMEOUT_SECONDS;
  }
  const val = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(val) || val <= 0) {
    console.error(
      `watchdog: MCP_IDLE_TIMEOUT_SECONDS=${JSON.stringify(raw)} is not a valid ` +
        `positive integer; falling back to default ${DEFAULT_IDLE_TIMEOUT_SECONDS}s`
    );
    return DEFAULT_IDLE_TIMEOUT_SECONDS;
  }
  return val;
}

/**
 * Minimal duck-typed shape of an MCP transport for the activity hook.
 *
 * We only care about the `onmessage` callback property -- not the full
 * Transport interface -- so this stays decoupled from the SDK's private
 * types. Compatible with StdioServerTransport, SSEServerTransport, and any
 * other implementer of `Transport`.
 */
export interface ActivityHookableTransport {
  onmessage?:
    | ((message: JSONRPCMessage, extra?: MessageExtraInfo) => void)
    | undefined;
}

/**
 * Install a transport-level activity hook. Call BEFORE server.connect().
 *
 * The SDK's Protocol.connect() captures whatever onmessage we set here and
 * chains it: our bump runs first, then the SDK's dispatch. This catches
 * EVERY inbound MCP message (initialize, ping, tools/list, call_tool,
 * notifications), matching fastmcp's on_message middleware semantics on
 * the Python side. Any other handler chains correctly too.
 *
 * Best-effort: the bump itself is wrapped to never throw into the SDK's
 * dispatch path.
 */
export function attachActivityToTransport(
  transport: ActivityHookableTransport
): void {
  const prior = transport.onmessage;
  transport.onmessage = (
    message: JSONRPCMessage,
    extra?: MessageExtraInfo
  ): void => {
    try {
      bumpActivity();
    } catch {
      // Activity tracking must never break message dispatch.
    }
    if (prior) {
      try {
        prior(message, extra);
      } catch (err) {
        // A throwing prior handler must not block the SDK's own dispatch
        // (which runs after this wrapper). Today the only call site does
        // not install a prior handler, but this keeps the chain safe if a
        // future caller adds one.
        console.error("watchdog: prior transport.onmessage threw", err);
      }
    }
  };
}

function watchdogTick(): void {
  try {
    const ppid = process.ppid;
    const nowMs = performance.now();
    const idleTimeoutMs = resolveIdleTimeoutSeconds() * 1000;
    const decision = shouldWatchdogExit({
      ppid,
      lastActivityMs,
      nowMs,
      idleTimeoutMs,
    });
    if (decision.exit) {
      console.error(
        `watchdog: self-terminating -- ${decision.reason}. Exiting now to ` +
          `free memory and avoid OOM on the shared VM.`
      );
      // Match Python os._exit(0): immediate exit, do not wait for the event
      // loop to drain. A hung async stack must not block teardown.
      process.exit(0);
    }
  } catch (err) {
    // Watchdog must never die quietly OR crash the server.
    console.error("watchdog: poll iteration raised; continuing", err);
  }
}

/**
 * Start the lifecycle watchdog. Call BEFORE the MCP server connects to its
 * transport, but AFTER any synchronous config/auth setup that might take a
 * while (so the idle clock starts after we are actually ready to serve).
 *
 * Honors MCP_DISABLE_WATCHDOG=1 to fully disable (debugging escape hatch).
 * Idempotent: a second call is a no-op.
 */
export function startLifecycleWatchdog(): void {
  if (process.env.MCP_DISABLE_WATCHDOG === "1") {
    console.error(
      "watchdog: disabled via MCP_DISABLE_WATCHDOG=1 (no orphan protection this run)"
    );
    return;
  }
  if (pollHandle) {
    return;
  }
  lastActivityMs = performance.now();
  const idleTimeoutS = resolveIdleTimeoutSeconds();
  console.error(
    `watchdog: armed (poll=${POLL_INTERVAL_MS / 1000}s, ` +
      `idle_timeout=${idleTimeoutS}s, ppid=${process.ppid})`
  );
  pollHandle = setInterval(watchdogTick, POLL_INTERVAL_MS);
  // Do not hold the event loop open just for the watchdog; if everything
  // else exits cleanly, the process can go.
  if (typeof pollHandle.unref === "function") {
    pollHandle.unref();
  }
}
