/**
 * Shopify OAuth Client Credentials flow.
 *
 * As of January 1 2026 Shopify no longer exposes static Admin API access
 * tokens in the UI.  New apps created in the Dev Dashboard receive a
 * client_id + client_secret pair which must be exchanged for a short-lived
 * access token (expires_in ≈ 86 400 s / 24 h).
 *
 * This module handles the token exchange and transparent refresh so the
 * rest of the codebase can keep using a plain access-token string.
 */

import type { GraphQLClient } from "graphql-request";

export interface ClientCredentialsConfig {
  clientId: string;
  clientSecret: string;
  shopDomain: string; // e.g. "my-store.myshopify.com"
}

export interface ShopifyAuthOptions {
  /**
   * Mirror the current token into process.env.SHOPIFY_ACCESS_TOKEN.
   * Single-store mode keeps this on so a refresh still updates that env var.
   * Multi-store mode turns it off: one process must not publish one store's token.
   */
  syncAccessTokenEnv?: boolean;
  /** Test hook. Production uses global fetch. */
  fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  scope: string;
}

// Refresh 5 minutes before actual expiry to avoid race conditions.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class ShopifyAuth {
  private config: ClientCredentialsConfig;
  private accessToken: string | null = null;
  private expiresAt = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private graphqlClient: GraphQLClient | null = null;
  private inflight: Promise<string> | null = null;
  private syncAccessTokenEnv: boolean;
  private fetchImpl: typeof fetch;

  constructor(config: ClientCredentialsConfig, options: ShopifyAuthOptions = {}) {
    this.config = config;
    this.syncAccessTokenEnv = options.syncAccessTokenEnv !== false;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Attach the GraphQL client so the token can be hot-swapped on refresh. */
  setGraphQLClient(client: GraphQLClient): void {
    this.graphqlClient = client;
  }

  /** Fetch an initial token. Must be called before the server starts. */
  async initialize(): Promise<string> {
    return this.ensureAccessToken();
  }

  /**
   * Return a valid token, fetching it on first use. Concurrent callers share
   * one in-flight exchange. A failure rejects this call only; the next call
   * tries again.
   */
  async ensureAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return this.accessToken;
    }
    if (!this.inflight) {
      this.inflight = (async () => {
        await this.fetchToken();
        this.scheduleRefresh();
        return this.accessToken!;
      })().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** Return the current (valid) access token. */
  getAccessToken(): string {
    if (!this.accessToken) {
      throw new Error("ShopifyAuth not initialized — call initialize() first");
    }
    return this.accessToken;
  }

  /** Stop the background refresh timer (for clean shutdown). */
  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async fetchToken(): Promise<void> {
    const url = `https://${this.config.shopDomain}/admin/oauth/access_token`;

    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Shopify token exchange failed (${res.status})${tokenErrorDetail(text, this.config)}`,
      );
    }

    const data = (await res.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;

    // Hot-swap the header on the existing GraphQL client so every tool
    // automatically picks up the new token.
    if (this.graphqlClient) {
      this.graphqlClient.setHeader(
        "X-Shopify-Access-Token",
        this.accessToken
      );
    }

    // Single-store mode still mirrors the token into the env var on refresh.
    // Multi-store mode leaves the env alone so stores cannot overwrite each other.
    if (this.syncAccessTokenEnv) {
      process.env.SHOPIFY_ACCESS_TOKEN = this.accessToken;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    const msUntilRefresh = this.expiresAt - Date.now() - REFRESH_MARGIN_MS;
    const delay = Math.max(msUntilRefresh, 0);

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.ensureAccessToken().then(() => {
        // A fetch re-arms the timer itself. If the clock stepped back, the
        // cached token still looks fresh and nothing re-armed it; do it here,
        // or refresh stops for good and single-store calls go stale.
        if (!this.refreshTimer) {
          this.scheduleRefresh();
        }
      }).catch((err) => {
        console.error("Failed to refresh Shopify access token:", err);
        // Retry in 60 s rather than dying.
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = null;
          this.scheduleRefresh();
        }, 60_000);
        unrefTimer(this.refreshTimer);
      });
    }, delay);

    unrefTimer(this.refreshTimer);
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}

function redactSecrets(text: string, config: ClientCredentialsConfig): string {
  return text
    .split(config.clientSecret).join("[redacted]")
    .split(config.clientId).join("[redacted]")
    .replace(/shpat_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/shpss_[A-Za-z0-9]+/g, "[redacted]");
}

/** Pull Shopify's error fields only. Never echo the raw body or a token. */
function tokenErrorDetail(text: string, config: ClientCredentialsConfig): string {
  let detail = "";
  try {
    const parsed = JSON.parse(text) as {
      error?: unknown;
      error_description?: unknown;
    };
    const parts = [parsed.error, parsed.error_description].filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    );
    detail = parts.join(": ");
  } catch {
    detail = "";
  }
  detail = redactSecrets(detail, config).slice(0, 200);
  return detail ? `: ${detail}` : "";
}
