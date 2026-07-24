// Regression tests for the in-server lifecycle watchdog.
//
// Root cause being guarded: orphaned per-session MCP children that never get
// stdin EOF / SIGHUP run forever and OOM the shared prod VM. The watchdog
// must self-terminate when (a) reparented to init (parent sshd died) or (b)
// idle beyond the configured timeout.
//
// These tests exercise the pure decision/config helpers and the transport
// activity hook -- no fork, no real process.exit, no live MCP transport.
// They must FAIL if the watchdog code is absent and PASS once it is wired in.

import { afterEach, describe, expect, jest, test } from "@jest/globals";

import {
  shouldWatchdogExit,
  resolveIdleTimeoutSeconds,
  attachActivityToTransport,
  bumpActivity,
  _getLastActivityMs,
  _resetForTest,
  startLifecycleWatchdog,
  transportLivenessEnabled,
  sshConnectionPeer,
  normalizeSsIp,
  parseSsBytesReceived,
  readSshBytesReceived,
  _TRANSPORT_FRESH_WINDOW_MS,
  type ActivityHookableTransport,
  type SsRunner,
} from "./lifecycleWatchdog.js";

afterEach(() => {
  _resetForTest();
  delete process.env.MCP_IDLE_TIMEOUT_SECONDS;
  delete process.env.MCP_DISABLE_WATCHDOG;
  delete process.env.MCP_TRANSPORT_LIVENESS;
  delete process.env.SSH_CONNECTION;
});

// The real `ss -tin` sample captured on the prod VM (Ubuntu). Two ESTAB
// connections to :23500; the FIRST is our live session's peer
// (192.168.1.230:61813, from SSH_CONNECTION); the second is a different client
// port whose counters are frozen (lastrcv:25232ms).
const SS_SAMPLE =
  "State      Recv-Q   Send-Q      Local Address:Port" +
  "         Peer Address:Port    Process\n" +
  "ESTAB      0        0           192.168.1.193:23500" +
  "       192.168.1.230:61813\n" +
  "\t cubic wscale:6,7 rto:204 rtt:0.187/0.03 ato:40 mss:1448 pmtu:1500" +
  " rcvmss:1448 advmss:1448 cwnd:10 ssthresh:22 bytes_sent:3838" +
  " bytes_acked:3838 bytes_received:4353 segs_out:21 segs_in:26" +
  " data_segs_out:12 data_segs_in:12 send 619465241bps lastsnd:4" +
  " lastrcv:8 lastack:4 pacing_rate 1234803464bps delivery_rate" +
  " 87097744bps delivered:13 app_limited busy:4ms rcv_space:14600" +
  " rcv_ssthresh:64076 minrtt:0.133\n" +
  "ESTAB      0        0           192.168.1.193:23500" +
  "       192.168.1.230:62411\n" +
  "\t cubic wscale:6,7 rto:204 rtt:0.226/0.021 ato:40 mss:1448 pmtu:1500" +
  " rcvmss:1448 advmss:1448 cwnd:10 ssthresh:22 bytes_sent:55674" +
  " bytes_acked:55674 bytes_received:26813 segs_out:792 segs_in:785" +
  " data_segs_out:288 data_segs_in:509 send 512566372bps lastsnd:25232" +
  " lastrcv:25232 lastack:25232 pacing_rate 1022305568bps delivery_rate" +
  " 207227184bps delivered:289 busy:40ms rcv_space:14600" +
  " rcv_ssthresh:64076 minrtt:0.135\n";

describe("shouldWatchdogExit", () => {
  test("exits when reparented to init (ppid == 1)", () => {
    // Even with fresh activity and a huge idle window, ppid=1 wins.
    const r = shouldWatchdogExit({
      ppid: 1,
      lastActivityMs: 1_000_000,
      nowMs: 1_000_000,
      idleTimeoutMs: 1_800_000,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toMatch(/parent died/);
  });

  test("exits when idle exceeds timeout (parent still alive)", () => {
    const r = shouldWatchdogExit({
      ppid: 4242,
      lastActivityMs: 0,
      nowMs: 1_801_000,
      idleTimeoutMs: 1_800_000,
    });
    expect(r.exit).toBe(true);
    expect(r.reason).toMatch(/idle/);
  });

  test("stays alive when parent ok and activity recent", () => {
    const r = shouldWatchdogExit({
      ppid: 4242,
      lastActivityMs: 1_000_000,
      nowMs: 1_000_500,
      idleTimeoutMs: 1_800_000,
    });
    expect(r.exit).toBe(false);
  });

  test("idle boundary is strict greater-than", () => {
    expect(
      shouldWatchdogExit({
        ppid: 4242,
        lastActivityMs: 0,
        nowMs: 1_800_000,
        idleTimeoutMs: 1_800_000,
      }).exit
    ).toBe(false);
    expect(
      shouldWatchdogExit({
        ppid: 4242,
        lastActivityMs: 0,
        nowMs: 1_800_001,
        idleTimeoutMs: 1_800_000,
      }).exit
    ).toBe(true);
  });

  // --- mechanism 3: transportAlive gate on the idle path ---

  test("ppid==1 always kills even when transport is alive", () => {
    expect(
      shouldWatchdogExit({
        ppid: 1,
        lastActivityMs: 1_000_000,
        nowMs: 1_000_000,
        idleTimeoutMs: 1_800_000,
        transportAlive: true,
      }).exit
    ).toBe(true);
  });

  test("idle + transport alive holds (no kill)", () => {
    expect(
      shouldWatchdogExit({
        ppid: 4242,
        lastActivityMs: 0,
        nowMs: 3_600_000,
        idleTimeoutMs: 1_800_000,
        transportAlive: true,
      }).exit
    ).toBe(false);
  });

  test("idle + transport NOT alive kills", () => {
    expect(
      shouldWatchdogExit({
        ppid: 4242,
        lastActivityMs: 0,
        nowMs: 3_600_000,
        idleTimeoutMs: 1_800_000,
        transportAlive: false,
      }).exit
    ).toBe(true);
  });

  test("within idle window, transport state is irrelevant", () => {
    for (const alive of [true, false]) {
      expect(
        shouldWatchdogExit({
          ppid: 4242,
          lastActivityMs: 1_000_000,
          nowMs: 1_000_500,
          idleTimeoutMs: 1_800_000,
          transportAlive: alive,
        }).exit
      ).toBe(false);
    }
  });

  test("omitting transportAlive reproduces today's exact behavior (kills)", () => {
    // idle exceeded, no transport arg -> kills (as before mechanism 3).
    expect(
      shouldWatchdogExit({
        ppid: 4242,
        lastActivityMs: 0,
        nowMs: 1_801_000,
        idleTimeoutMs: 1_800_000,
      }).exit
    ).toBe(true);
  });
});

describe("transportLivenessEnabled", () => {
  test("defaults to true when env unset", () => {
    expect(transportLivenessEnabled({})).toBe(true);
  });

  test("disabled by exactly '0'", () => {
    expect(transportLivenessEnabled({ MCP_TRANSPORT_LIVENESS: "0" })).toBe(false);
  });

  test.each(["1", "true", "yes", "on", ""])(
    "only '0' disables (value %j stays enabled)",
    (val) => {
      expect(transportLivenessEnabled({ MCP_TRANSPORT_LIVENESS: val })).toBe(
        true
      );
    }
  );
});

describe("sshConnectionPeer", () => {
  test("parses a valid SSH_CONNECTION", () => {
    expect(
      sshConnectionPeer({
        SSH_CONNECTION: "192.168.1.230 61813 192.168.1.193 23500",
      })
    ).toEqual({
      clientIp: "192.168.1.230",
      clientPort: "61813",
      serverPort: "23500",
    });
  });

  test("absent -> null", () => {
    expect(sshConnectionPeer({})).toBeNull();
  });

  test.each([
    "",
    "   ",
    "192.168.1.230 61813 192.168.1.193", // too few fields
    "192.168.1.230 61813 192.168.1.193 23500 x", // too many fields
    "192.168.1.230 abc 192.168.1.193 23500", // non-int client port
    "192.168.1.230 61813 192.168.1.193 xyz", // non-int server port
    " 61813 192.168.1.193 23500", // empty client ip (3 tokens after trim)
  ])("garbage %j -> null", (raw) => {
    expect(sshConnectionPeer({ SSH_CONNECTION: raw })).toBeNull();
  });
});

describe("normalizeSsIp", () => {
  test("strips IPv6 brackets", () => {
    expect(normalizeSsIp("[::ffff:192.168.1.230]")).toBe("192.168.1.230");
  });
  test("strips ::ffff: prefix", () => {
    expect(normalizeSsIp("::ffff:192.168.1.230")).toBe("192.168.1.230");
  });
  test("leaves a plain v4 address untouched", () => {
    expect(normalizeSsIp("192.168.1.230")).toBe("192.168.1.230");
  });
});

describe("parseSsBytesReceived", () => {
  test("picks the correct peer's counter, not a sibling's", () => {
    expect(
      parseSsBytesReceived(SS_SAMPLE, "192.168.1.230", "61813", "23500")
    ).toBe(4353);
    expect(
      parseSsBytesReceived(SS_SAMPLE, "192.168.1.230", "62411", "23500")
    ).toBe(26813);
  });

  test("missing tuple -> null", () => {
    // client port not present
    expect(
      parseSsBytesReceived(SS_SAMPLE, "192.168.1.230", "99999", "23500")
    ).toBeNull();
    // right port, wrong peer ip
    expect(
      parseSsBytesReceived(SS_SAMPLE, "10.0.0.1", "61813", "23500")
    ).toBeNull();
    // right peer, wrong local (server) port
    expect(
      parseSsBytesReceived(SS_SAMPLE, "192.168.1.230", "61813", "22")
    ).toBeNull();
  });

  test("non-ESTAB state is ignored", () => {
    const nonEstab =
      "State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port\n" +
      "TIME-WAIT  0  0  192.168.1.193:23500  192.168.1.230:61813\n" +
      "\t cubic bytes_sent:10 bytes_received:4353 lastrcv:8\n";
    expect(
      parseSsBytesReceived(nonEstab, "192.168.1.230", "61813", "23500")
    ).toBeNull();
  });

  test("v4-mapped-v6 peer matches plain v4 SSH_CONNECTION", () => {
    const mapped =
      "State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port\n" +
      "ESTAB  0  0  [::ffff:192.168.1.193]:23500" +
      "  [::ffff:192.168.1.230]:61813\n" +
      "\t cubic bytes_sent:1 bytes_received:777 lastrcv:8\n";
    expect(
      parseSsBytesReceived(mapped, "192.168.1.230", "61813", "23500")
    ).toBe(777);
  });

  test("header matched but no counter -> null", () => {
    const noCounter =
      "State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port\n" +
      "ESTAB  0  0  192.168.1.193:23500  192.168.1.230:61813\n" +
      "\t cubic wscale:6,7 rto:204 (no bytes field here)\n";
    expect(
      parseSsBytesReceived(noCounter, "192.168.1.230", "61813", "23500")
    ).toBeNull();
  });

  test.each(["", "   ", "not ss output at all\n", "\n\n"])(
    "garbage input %j -> null",
    (garbage) => {
      expect(
        parseSsBytesReceived(garbage, "192.168.1.230", "61813", "23500")
      ).toBeNull();
    }
  );

  test("non-integer port args -> null", () => {
    expect(
      parseSsBytesReceived(SS_SAMPLE, "192.168.1.230", "abc", "23500")
    ).toBeNull();
    expect(
      parseSsBytesReceived(SS_SAMPLE, "192.168.1.230", "61813", "xyz")
    ).toBeNull();
  });
});

describe("readSshBytesReceived (injected ss runner)", () => {
  const PEER = {
    clientIp: "192.168.1.230",
    clientPort: "61813",
    serverPort: "23500",
  };

  test("null peer short-circuits (no probe)", () => {
    const runner: SsRunner = () => {
      throw new Error("should not be called");
    };
    expect(readSshBytesReceived(null, runner)).toBeNull();
  });

  test("ss throwing (missing binary / nonzero exit / timeout) -> null", () => {
    const missing: SsRunner = () => {
      const e = new Error("ENOENT: no ss") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    };
    expect(readSshBytesReceived(PEER, missing)).toBeNull();
    const nonzero: SsRunner = () => {
      throw new Error("Command failed: ss -tin (exit 1)");
    };
    expect(readSshBytesReceived(PEER, nonzero)).toBeNull();
  });

  test("passes -tin + sport filter and parses the counter", () => {
    const calls: Array<[string, string[]]> = [];
    const runner: SsRunner = (binary, args) => {
      calls.push([binary, args]);
      return SS_SAMPLE;
    };
    expect(readSshBytesReceived(PEER, runner)).toBe(4353);
    expect(calls).toEqual([["/usr/bin/ss", ["-tin", "sport = :23500"]]]);
  });

  test("peer not found in ss output -> null (fail-safe)", () => {
    const runner: SsRunner = () => SS_SAMPLE;
    expect(
      readSshBytesReceived({ ...PEER, clientPort: "99999" }, runner)
    ).toBeNull();
  });
});

// Freshness-window logic: replicate the loop's proven-advance test. Mirrors the
// Python reference's _fresh() helper -- last_advance is set ONLY on an observed
// increase, and "alive" means it advanced within the window.
function fresh(lastAdvanceMs: number | null, nowMs: number): boolean {
  if (lastAdvanceMs === null) return false;
  return nowMs - lastAdvanceMs <= _TRANSPORT_FRESH_WINDOW_MS;
}

describe("freshness window", () => {
  test("advancing counters are alive within the window", () => {
    let lastBytes: number | null = null;
    let lastAdvance: number | null = null;
    // t=0: baseline (no proven advance yet)
    let cur = 100;
    if (lastBytes !== null && cur > lastBytes) lastAdvance = 0;
    lastBytes = cur;
    expect(fresh(lastAdvance, 0)).toBe(false);
    // t=30s: counter advanced (keepalive) -> proven advance
    cur = 140;
    const now = 30_000;
    if (lastBytes !== null && cur > lastBytes) lastAdvance = now;
    lastBytes = cur;
    expect(fresh(lastAdvance, now)).toBe(true);
    // still alive just inside the window
    expect(fresh(lastAdvance, now + _TRANSPORT_FRESH_WINDOW_MS)).toBe(true);
  });

  test("frozen counters die just past the window", () => {
    const lastAdvance = 30_000;
    expect(fresh(lastAdvance, 30_000 + _TRANSPORT_FRESH_WINDOW_MS + 1)).toBe(
      false
    );
  });

  test("a null probe never sets last_advance -> not alive", () => {
    expect(fresh(null, 1_000_000)).toBe(false);
  });
});

describe("resolveIdleTimeoutSeconds", () => {
  test("defaults to 1800 when env unset", () => {
    expect(resolveIdleTimeoutSeconds({})).toBe(1800);
  });

  test("honors MCP_IDLE_TIMEOUT_SECONDS override", () => {
    expect(
      resolveIdleTimeoutSeconds({ MCP_IDLE_TIMEOUT_SECONDS: "60" })
    ).toBe(60);
  });

  test.each(["", "  ", "abc", "-5", "0", "12.5", "NaN"])(
    "falls back to default for bad value %j",
    (bad) => {
      expect(
        resolveIdleTimeoutSeconds({ MCP_IDLE_TIMEOUT_SECONDS: bad })
      ).toBe(1800);
    }
  );
});

describe("attachActivityToTransport", () => {
  test("bumps activity on every inbound message", async () => {
    _resetForTest();
    const transport: ActivityHookableTransport = {};
    attachActivityToTransport(transport);
    expect(transport.onmessage).toBeDefined();

    const before = _getLastActivityMs();
    // Give the monotonic clock a tick to advance measurably.
    await new Promise((r) => setTimeout(r, 5));
    transport.onmessage!({ jsonrpc: "2.0", method: "ping", id: 1 });
    expect(_getLastActivityMs()).toBeGreaterThan(before);
  });

  test("chains an existing onmessage handler", () => {
    const seen: unknown[] = [];
    const transport: ActivityHookableTransport = {
      onmessage: (m) => {
        seen.push(m);
      },
    };
    attachActivityToTransport(transport);
    transport.onmessage!({ jsonrpc: "2.0", method: "initialize", id: 0 });
    // The prior handler must still see the message after our wrap.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ jsonrpc: "2.0", method: "initialize", id: 0 });
  });

  test("forwards the extra argument when present", () => {
    const calls: Array<[unknown, unknown]> = [];
    const transport: ActivityHookableTransport = {
      onmessage: (m, extra) => {
        calls.push([m, extra]);
      },
    };
    attachActivityToTransport(transport);
    transport.onmessage!(
      { jsonrpc: "2.0", method: "x", id: 1 },
      { authInfo: { token: "tok" } }
    );
    expect(calls).toEqual([
      [
        { jsonrpc: "2.0", method: "x", id: 1 },
        { authInfo: { token: "tok" } },
      ],
    ]);
  });

  test("a throwing prior handler must not block the chain", () => {
    // Defensive guarantee: if some future caller installs a transport.onmessage
    // that throws, the SDK's own dispatch (registered AFTER us by
    // Protocol.connect()) must still run. The wrap swallows.
    const transport: ActivityHookableTransport = {
      onmessage: () => {
        throw new Error("prior handler is hostile");
      },
    };
    attachActivityToTransport(transport);
    const errSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      transport.onmessage!({ jsonrpc: "2.0", method: "ping", id: 7 })
    ).not.toThrow();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("bumpActivity", () => {
  test("moves the timestamp forward", async () => {
    _resetForTest();
    const before = _getLastActivityMs();
    await new Promise((r) => setTimeout(r, 5));
    bumpActivity();
    expect(_getLastActivityMs()).toBeGreaterThan(before);
  });
});

describe("startLifecycleWatchdog", () => {
  test("no-ops when MCP_DISABLE_WATCHDOG=1", () => {
    process.env.MCP_DISABLE_WATCHDOG = "1";
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    startLifecycleWatchdog();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  test("registers an interval when enabled and is idempotent", () => {
    _resetForTest();
    const setIntervalSpy = jest.spyOn(global, "setInterval");
    startLifecycleWatchdog();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    startLifecycleWatchdog();
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    setIntervalSpy.mockRestore();
  });
});
