import { afterEach, describe, expect, jest, test } from "@jest/globals";

import { ShopifyAuth } from "./shopifyAuth.js";

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("ShopifyAuth refresh timer", () => {
  test("re-arms when the timer fires but the clock says the token is still fresh", async () => {
    jest.useFakeTimers({ now: 0 });
    let fetches = 0;
    const fetchImpl = (async () => {
      fetches++;
      return new Response(
        JSON.stringify({ access_token: `tok-${fetches}`, expires_in: 86_400, scope: "x" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const auth = new ShopifyAuth(
      { clientId: "id", clientSecret: "secret", shopDomain: "t.myshopify.com" },
      { syncAccessTokenEnv: false, fetchImpl },
    );
    await auth.initialize();
    expect(fetches).toBe(1);

    // The timer fires while the wall clock reads one second earlier than
    // expected (a backward step), so the token still looks fresh.
    const refreshAt = 86_400_000 - 5 * 60 * 1000;
    // Fake timers move the clock with them: step it back 1 s first, so it
    // reads refreshAt - 1000 when the timer fires.
    jest.setSystemTime(-1000);
    await jest.advanceTimersByTimeAsync(refreshAt);
    expect(fetches).toBe(1);
    expect(jest.getTimerCount()).toBe(1);

    // When the re-armed timer fires after the real refresh point, it fetches.
    jest.setSystemTime(refreshAt + 1);
    await jest.advanceTimersByTimeAsync(2000);
    expect(fetches).toBe(2);
    expect(auth.getAccessToken()).toBe("tok-2");
    auth.destroy();
  });
});
