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
  type ActivityHookableTransport,
} from "./lifecycleWatchdog.js";

afterEach(() => {
  _resetForTest();
  delete process.env.MCP_IDLE_TIMEOUT_SECONDS;
  delete process.env.MCP_DISABLE_WATCHDOG;
});

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
