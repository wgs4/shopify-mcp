import { GraphQLClient } from "graphql-request";

import { ShopifyAuth } from "./shopifyAuth.js";
import type { StoreCredential } from "./storeConfig.js";
import type { StoreContext } from "./toolUtils.js";

export interface StoreRegistryOptions {
  /** Test hook shared by the token exchange and the GraphQL client. */
  fetchImpl?: typeof fetch;
}

interface StoreEntry {
  key: string;
  domain: string;
  apiVersion: string;
  auth: ShopifyAuth;
  client: GraphQLClient;
}

/**
 * One ShopifyAuth and one GraphQL client per store key.
 * Tokens are fetched on first use. A failed exchange rejects that call only.
 */
export class StoreRegistry {
  private readonly entries = new Map<string, StoreEntry>();
  private readonly orderedKeys: string[];

  constructor(
    stores: readonly StoreCredential[],
    apiVersion: string,
    options: StoreRegistryOptions = {},
  ) {
    this.orderedKeys = stores.map((store) => store.key);
    for (const store of stores) {
      const auth = new ShopifyAuth(
        {
          clientId: store.clientId,
          clientSecret: store.clientSecret,
          shopDomain: store.domain,
        },
        { syncAccessTokenEnv: false, fetchImpl: options.fetchImpl },
      );
      const clientOptions: { headers: Record<string, string>; fetch?: typeof fetch } = {
        headers: { "Content-Type": "application/json" },
      };
      if (options.fetchImpl) {
        clientOptions.fetch = options.fetchImpl;
      }
      const client = new GraphQLClient(
        `https://${store.domain}/admin/api/${apiVersion}/graphql.json`,
        clientOptions,
      );
      auth.setGraphQLClient(client);
      this.entries.set(store.key, {
        key: store.key,
        domain: store.domain,
        apiVersion,
        auth,
        client,
      });
    }
  }

  keys(): string[] {
    return [...this.orderedKeys];
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /**
   * Authenticate the named store if needed and return its context.
   * Throws an error that names the store when the token exchange fails.
   */
  async contextFor(key: string): Promise<StoreContext> {
    const entry = this.entries.get(key);
    if (!entry) {
      throw new Error(
        `Unknown store "${key}". Configured stores: ${this.orderedKeys.join(" | ")}.`,
      );
    }
    try {
      await entry.auth.ensureAccessToken();
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Store "${key}" authentication failed: ${detail}`);
    }
    return {
      client: entry.client,
      domain: entry.domain,
      storeKey: entry.key,
      getAccessToken: () => entry.auth.getAccessToken(),
      apiVersion: entry.apiVersion,
    };
  }

  destroy(): void {
    for (const entry of this.entries.values()) {
      entry.auth.destroy();
    }
  }
}
