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
// Three mechanisms, all best-effort and fail-safe (a broken watchdog must
// never crash or degrade the server):
//   1. Daemon poll interval (~20s): exits if reparented to init (ppid==1,
//      portable parent-death backstop) or if idle beyond the timeout
//      (catches the lingering-socket case where sshd is still alive but
//      nobody's home).
//   2. last-activity monotonic timestamp bumped by attachActivityToTransport
//      on every inbound MCP message (initialize, ping, tools/list, call_tool,
//      etc.) -- equivalent to fastmcp's on_message middleware.
//   3. Transport-liveness gate (on the idle kill ONLY): the idle timer cannot
//      tell "open Claude session, user just hasn't touched a tool for 30 min"
//      from "lingering socket, session gone" -- and killing the former is a
//      live-session regression. The Mac-side ssh client is spawned with
//      `ServerAliveInterval=30`, so as long as that ssh process lives it emits
//      an SSH keepalive every ~30s; the server's TCP socket then shows its
//      byte counters advancing every ~30s even when zero MCP messages flow. A
//      lingering orphan's counters FREEZE. So each poll we read this
//      connection's `bytes_received` via `ss -tin` (peer identified from
//      SSH_CONNECTION) and SUPPRESS the idle kill only while the counter has
//      PROVABLY advanced within the last _TRANSPORT_FRESH_WINDOW_MS. This never
//      weakens orphan/OOM protection: (a) the ppid==1 backstop is untouched and
//      still immediate; (b) ANY inability to measure -- MCP_TRANSPORT_LIVENESS=0,
//      SSH_CONNECTION unset (local dev/tests/macOS), `ss` missing/erroring, the
//      peer 4-tuple not found, a parse failure, frozen counters, or a non-ESTAB
//      state -- yields "not alive", i.e. today's exact idle behavior (idle timer
//      applies unmodified); we NEVER "assume alive". Because the gate only holds
//      an ALREADY-idle session, when its transport later dies the kill fires
//      within one fresh-window + one poll (~3-4 min) of transport death.
//
// This TS server has THREE mechanisms where the Python reference has four: it
// omits the Python's mechanism 1 (PR_SET_PDEATHSIG). So the transport-liveness
// gate that is the Python reference's "mechanism 4" is this file's mechanism 3.
//
// Env hatch: MCP_TRANSPORT_LIVENESS=0 disables mechanism 3's gate entirely,
// reverting to the pre-gate behavior (idle kill unmodified). It fails toward
// MORE protection.
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

import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";

import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";

const POLL_INTERVAL_MS = 20_000;
const DEFAULT_IDLE_TIMEOUT_SECONDS = 1800; // 30 minutes

// --- Transport-liveness gate (mechanism 3) constants ---
//
// The idle kill is SUPPRESSED only while the ancestor ssh connection's byte
// counters have advanced within this window. 180s = 6 SSH keepalive periods
// (ServerAliveInterval=30) -- generous enough to never trip on a live-but-quiet
// session, tight enough that a dead peer flips to "not alive" within 3 minutes.
export const _TRANSPORT_FRESH_WINDOW_MS = 180_000;
// Rate-limit the "idle but holding" log so a long-held session doesn't spam a
// line every 20s.
const TRANSPORT_SUPPRESS_LOG_INTERVAL_MS = 600_000;
// Absolute path -- do NOT trust PATH for a security-relevant probe.
const SS_BINARY = "/usr/bin/ss";
// TCP states `ss` can print in the State column; used only to recognize a
// connection-header line (vs the column header or an indented info line).
const TCP_STATES = new Set<string>([
  "ESTAB",
  "SYN-SENT",
  "SYN-RECV",
  "FIN-WAIT-1",
  "FIN-WAIT-2",
  "TIME-WAIT",
  "CLOSE-WAIT",
  "LAST-ACK",
  "LISTEN",
  "CLOSING",
  "UNCONN",
  "CLOSE",
]);
const SS_BYTES_RECEIVED_RE = /\bbytes_received:(\d+)\b/;

let lastActivityMs = performance.now();
let pollHandle: NodeJS.Timeout | null = null;

// --- Transport-liveness gate (mechanism 3) mutable state ---
//
// Resolved ONCE at startLifecycleWatchdog() time; null (gate inactive) unless
// the gate is enabled AND SSH_CONNECTION parses -- both fail-safe toward the
// pre-gate idle behavior.
let transportPeer: SshPeer | null = null;
let transportGateActive = false;
// last proven-advance tracking. lastAdvanceMs is the monotonic time we last
// OBSERVED bytes_received increase; it is only ever set on a proven advance
// (never seeded from a single reading), so "alive" means the counters
// demonstrably moved -- not merely that one probe succeeded.
let transportLastBytes: number | null = null;
let transportLastAdvanceMs: number | null = null;
let transportLastSuppressLogMs = 0;

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
  transportPeer = null;
  transportGateActive = false;
  transportLastBytes = null;
  transportLastAdvanceMs = null;
  transportLastSuppressLogMs = 0;
}

/**
 * Pure: should the watchdog terminate the process right now?
 *
 * Exits when reparented to init (ppid == 1, i.e. parent sshd died) OR when
 * the process has been idle longer than `idleTimeoutMs` AND the ssh transport
 * is not provably alive. `transportAlive` (mechanism 3) gates ONLY the idle
 * path: ppid==1 always kills regardless (orphan protection is never weakened).
 * Defaults to false so callers that cannot measure transport liveness -- and
 * every pre-mechanism-3 caller -- get today's exact behavior. Kept side-effect-
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
  transportAlive?: boolean;
}): { exit: boolean; reason?: string } {
  if (args.ppid === 1) {
    return { exit: true, reason: "parent died (reparented to init, ppid=1)" };
  }
  const idleMs = args.nowMs - args.lastActivityMs;
  if (idleMs > args.idleTimeoutMs && !args.transportAlive) {
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

// ---------------------------------------------------------------------------
// Transport-liveness gate (mechanism 3)
// ---------------------------------------------------------------------------

/** Parsed SSH_CONNECTION peer: the client 3-tuple that identifies our socket. */
export interface SshPeer {
  clientIp: string;
  clientPort: string;
  serverPort: string;
}

/**
 * Runs `ss` and returns its stdout. Injectable so tests can drive the parser
 * and fail-safe paths without a real `ss` binary (mirrors monkeypatching
 * subprocess.run in the Python reference).
 */
export type SsRunner = (binary: string, args: string[]) => string;

const defaultSsRunner: SsRunner = (binary, args) =>
  execFileSync(binary, args, {
    encoding: "utf8",
    timeout: 3000,
    // Ignore stdin/stderr; we only parse stdout. A nonzero exit throws (caught
    // by the caller and treated as "cannot measure" -> not alive).
    stdio: ["ignore", "pipe", "ignore"],
  });

/**
 * True unless the operator set MCP_TRANSPORT_LIVENESS=0.
 *
 * The gate defaults ON, but is only ever ACTIVE when SSH_CONNECTION is also
 * present (see `sshConnectionPeer`). Disabling it reverts to the exact pre-gate
 * idle-kill behavior.
 */
export function transportLivenessEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env.MCP_TRANSPORT_LIVENESS !== "0";
}

/**
 * Parse SSH_CONNECTION into `{clientIp, clientPort, serverPort}`.
 *
 * SSH_CONNECTION is `"<client_ip> <client_port> <server_ip> <server_port>"` in
 * the spawned process env. Returns null (gate permanently inactive this
 * process) when the var is absent, has the wrong shape, or carries non-integer
 * ports -- the fail-safe path.
 */
export function sshConnectionPeer(
  env: NodeJS.ProcessEnv = process.env
): SshPeer | null {
  const raw = env.SSH_CONNECTION;
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 4) return null;
  const [clientIp, clientPort, , serverPort] = parts;
  if (!clientIp) return null;
  if (!/^\d+$/.test(clientPort) || !/^\d+$/.test(serverPort)) return null;
  return { clientIp, clientPort, serverPort };
}

/**
 * Normalize an `ss` address token for comparison.
 *
 * Strips IPv6 brackets and the `::ffff:` v4-mapped-v6 prefix so a peer that
 * `ss` renders as `[::ffff:192.168.1.230]` matches SSH_CONNECTION's plain
 * `192.168.1.230`.
 */
export function normalizeSsIp(addr: string): string {
  let a = addr.trim();
  if (a.startsWith("[") && a.endsWith("]")) {
    a = a.slice(1, -1);
  }
  if (a.startsWith("::ffff:")) {
    a = a.slice("::ffff:".length);
  }
  return a;
}

/**
 * Pure parser: extract `bytes_received` for one ESTAB connection.
 *
 * Scans `ss -tin` text for the ESTAB connection whose local port ==
 * `serverPort` and whose peer == `clientIp:clientPort` (bracket / v4-mapped
 * tolerant), then reads `bytes_received:N` from its following indented info
 * line(s). Returns null on ANY failure to positively identify and parse that
 * one connection (empty/garbage input, tuple not found, state not ESTAB, no
 * counter present) -- the fail-safe contract. Side-effect-free and text-only so
 * it is unit-testable without `ss`.
 */
export function parseSsBytesReceived(
  ssOutput: string,
  clientIp: string,
  clientPort: string,
  serverPort: string
): number | null {
  if (!ssOutput) return null;
  if (!/^\d+$/.test(clientPort) || !/^\d+$/.test(serverPort)) return null;
  const wantCport = Number.parseInt(clientPort, 10);
  const wantSport = Number.parseInt(serverPort, 10);
  const wantIp = normalizeSsIp(clientIp);

  const lines = ssOutput.split("\n");
  const n = lines.length;
  for (let i = 0; i < n; i++) {
    const line = lines[i];
    // A connection-header line is non-indented and starts with a TCP state.
    if (line.length === 0 || /^\s/.test(line)) continue;
    const tokens = line.trim().split(/\s+/);
    if (tokens.length < 5 || !TCP_STATES.has(tokens[0])) continue;
    if (tokens[0] !== "ESTAB") continue;
    const local = tokens[3];
    const peer = tokens[4];
    // Split on the LAST ':' so IPv6 addresses (which contain ':') split right.
    const li = local.lastIndexOf(":");
    const pi = peer.lastIndexOf(":");
    if (li < 0 || pi < 0) continue;
    const laddr = local.slice(0, li);
    const lport = local.slice(li + 1);
    const paddr = peer.slice(0, pi);
    const pport = peer.slice(pi + 1);
    if (!/^\d+$/.test(lport) || !/^\d+$/.test(pport)) continue;
    if (
      Number.parseInt(lport, 10) !== wantSport ||
      Number.parseInt(pport, 10) !== wantCport
    ) {
      continue;
    }
    if (normalizeSsIp(paddr) !== wantIp) continue;
    // Matched header -> read bytes_received from the following info block.
    let j = i + 1;
    while (j < n && (lines[j].length === 0 || /^\s/.test(lines[j]))) {
      const m = SS_BYTES_RECEIVED_RE.exec(lines[j]);
      if (m) return Number.parseInt(m[1], 10);
      j++;
    }
    return null; // header matched but no counter -> fail-safe
  }
  return null;
}

/**
 * Probe the ssh connection's `bytes_received` via `ss -tin`.
 *
 * Returns the current counter, or null on ANY failure (peer null, `ss`
 * missing/timeout/nonzero exit, tuple not found, parse failure) -- callers
 * treat null as "cannot measure -> not alive". The impure counterpart to the
 * pure `parseSsBytesReceived`; the `runSs` seam mirrors the Python reference's
 * monkeypatchable `subprocess.run`.
 */
export function readSshBytesReceived(
  peer: SshPeer | null,
  runSs: SsRunner = defaultSsRunner
): number | null {
  if (peer === null) return null;
  let stdout: string;
  try {
    stdout = runSs(SS_BINARY, ["-tin", `sport = :${peer.serverPort}`]);
  } catch {
    // `ss` missing, nonzero exit, or timeout -> cannot measure -> not alive.
    return null;
  }
  return parseSsBytesReceived(
    stdout,
    peer.clientIp,
    peer.clientPort,
    peer.serverPort
  );
}

/**
 * Stateful tick-level probe: is the ssh transport provably alive right now?
 *
 * Reads the current `bytes_received`, updates the proven-advance tracking
 * (module state, reset by `_resetForTest`), and returns true only while a
 * counter increase has been OBSERVED within `_TRANSPORT_FRESH_WINDOW_MS`.
 * Returns false whenever the gate is inactive or the probe cannot measure --
 * NEVER assumes alive. `runSs` is injectable for tests.
 */
export function isTransportAlive(
  nowMs: number,
  runSs: SsRunner = defaultSsRunner
): boolean {
  if (!transportGateActive) return false;
  const cur = readSshBytesReceived(transportPeer, runSs);
  if (cur === null) {
    // Cannot measure -> transport not alive (today's idle behavior applies).
    return false;
  }
  if (transportLastBytes !== null && cur > transportLastBytes) {
    transportLastAdvanceMs = nowMs;
  }
  transportLastBytes = cur;
  return (
    transportLastAdvanceMs !== null &&
    nowMs - transportLastAdvanceMs <= _TRANSPORT_FRESH_WINDOW_MS
  );
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

    // Mechanism 3: compute transport-liveness this tick. Inactive gate or any
    // inability to measure yields false (fail-safe: idle timer unmodified).
    const transportAlive = transportGateActive ? isTransportAlive(nowMs) : false;

    const decision = shouldWatchdogExit({
      ppid,
      lastActivityMs,
      nowMs,
      idleTimeoutMs,
      transportAlive,
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

    // Idle kill was SUPPRESSED by the transport gate -- log at most once per
    // TRANSPORT_SUPPRESS_LOG_INTERVAL_MS (no 20s spam).
    if (
      transportGateActive &&
      transportAlive &&
      nowMs - lastActivityMs > idleTimeoutMs
    ) {
      if (nowMs - transportLastSuppressLogMs >= TRANSPORT_SUPPRESS_LOG_INTERVAL_MS) {
        const idleS = Math.floor((nowMs - lastActivityMs) / 1000);
        const timeoutS = Math.floor(idleTimeoutMs / 1000);
        console.error(
          `watchdog: idle ${idleS}s > ${timeoutS}s but ssh transport alive ` +
            `(client keepalives flowing); holding.`
        );
        transportLastSuppressLogMs = nowMs;
      }
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

  // Mechanism 3: resolve the transport-liveness gate's peer ONCE at startup.
  // Inactive unless the gate is enabled AND SSH_CONNECTION parses -- both
  // fail-safe toward the pre-gate unmodified idle behavior.
  transportPeer = null;
  transportGateActive = false;
  transportLastBytes = null;
  transportLastAdvanceMs = null;
  transportLastSuppressLogMs = 0;
  if (transportLivenessEnabled()) {
    transportPeer = sshConnectionPeer();
    if (transportPeer !== null) {
      transportGateActive = true;
      console.error(
        `watchdog: transport-liveness gate ACTIVE (ssh peer ` +
          `${transportPeer.clientIp}:${transportPeer.clientPort} -> ` +
          `:${transportPeer.serverPort}); the idle kill will be held only ` +
          `while the client keepalives advance this connection's byte counters`
      );
    } else {
      console.error(
        "watchdog: transport-liveness gate inactive (SSH_CONNECTION " +
          "unset/unparseable); idle timer applies unmodified"
      );
    }
  } else {
    console.error(
      "watchdog: transport-liveness gate disabled via " +
        "MCP_TRANSPORT_LIVENESS=0; idle timer applies unmodified"
    );
  }

  console.error(
    `watchdog: armed (poll=${POLL_INTERVAL_MS / 1000}s, ` +
      `idle_timeout=${idleTimeoutS}s, ppid=${process.ppid}, ` +
      `transport_gate=${transportGateActive ? "active" : "inactive"})`
  );
  pollHandle = setInterval(watchdogTick, POLL_INTERVAL_MS);
  // Do not hold the event loop open just for the watchdog; if everything
  // else exits cleanly, the process can go.
  if (typeof pollHandle.unref === "function") {
    pollHandle.unref();
  }
}
