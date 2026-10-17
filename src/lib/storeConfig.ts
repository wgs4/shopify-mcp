/**
 * Startup configuration for one Shopify store or many.
 *
 * Multi-store mode is on only when SHOPIFY_STORES / --stores is provided.
 * Otherwise the process stays on the original single-store flags.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface ServerArgv {
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  domain?: string;
  apiVersion?: string;
  stores?: string | boolean | string[];
}

export interface StaticAuth {
  kind: "static";
  accessToken: string;
}

export interface ClientCredentialsAuth {
  kind: "client_credentials";
  clientId: string;
  clientSecret: string;
}

export interface SingleStoreConfig {
  mode: "single";
  domain: string;
  apiVersion: string;
  auth: StaticAuth | ClientCredentialsAuth;
}

export interface StoreCredential {
  key: string;
  domain: string;
  clientId: string;
  clientSecret: string;
}

export interface MultiStoreConfig {
  mode: "multi";
  apiVersion: string;
  stores: StoreCredential[];
}

export type ServerConfig = SingleStoreConfig | MultiStoreConfig;

const KEY_RE = /^[a-z][a-z0-9-]{0,31}$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

const SINGLE_STORE_AUTH_ERROR = [
  "Error: Authentication credentials are required.",
  "",
  "Option 1 — Static access token (legacy apps):",
  "  --accessToken=shpat_xxxxx",
  "",
  "Option 2 — Client credentials (Dev Dashboard apps, Jan 2026+):",
  "  --clientId=your_client_id --clientSecret=your_client_secret",
].join("\n");

const SINGLE_STORE_DOMAIN_ERROR = [
  "Error: MYSHOPIFY_DOMAIN is required.",
  "Please provide it via command line argument or .env file.",
  "  Command line: --domain=your-store.myshopify.com",
].join("\n");

export function credentialOverrideName(
  prefix: "SHOPIFY_CLIENT_ID" | "SHOPIFY_CLIENT_SECRET",
  key: string,
): string {
  return `${prefix}__${key.toUpperCase().replace(/-/g, "_")}`;
}

/**
 * Parse `key=domain` pairs. Keys and domains are validated; nothing is fetched.
 */
export function parseStoreList(raw: string): Array<{ key: string; domain: string }> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ConfigError("SHOPIFY_STORES is empty.");
  }

  const seenKeys = new Set<string>();
  const seenDomains = new Set<string>();
  const entries: Array<{ key: string; domain: string }> = [];

  for (const part of trimmed.split(",")) {
    const item = part.trim();
    if (!item) {
      throw new ConfigError("SHOPIFY_STORES contains an empty entry.");
    }
    const eq = item.indexOf("=");
    if (eq <= 0 || item.indexOf("=", eq + 1) !== -1) {
      throw new ConfigError(
        `Malformed SHOPIFY_STORES entry "${item}". Expected key=domain.`,
      );
    }
    const key = item.slice(0, eq).trim();
    const domain = item.slice(eq + 1).trim().toLowerCase();
    if (!KEY_RE.test(key)) {
      throw new ConfigError(
        `Invalid store key "${key}". Keys must match ${KEY_RE}.`,
      );
    }
    if (!DOMAIN_RE.test(domain)) {
      throw new ConfigError(
        `Invalid Shopify domain "${domain}" for store "${key}". Domain must be a *.myshopify.com host.`,
      );
    }
    if (seenKeys.has(key)) {
      throw new ConfigError(`Duplicate store key "${key}".`);
    }
    if (seenDomains.has(domain)) {
      throw new ConfigError(`Duplicate Shopify domain "${domain}".`);
    }
    seenKeys.add(key);
    seenDomains.add(domain);
    entries.push({ key, domain });
  }

  return entries;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function loadServerConfig(
  env: NodeJS.ProcessEnv,
  argv: ServerArgv = {},
): ServerConfig {
  const apiVersion = nonEmpty(argv.apiVersion) || nonEmpty(env.SHOPIFY_API_VERSION) || "2026-01";
  const storesRaw = argv.stores !== undefined ? argv.stores : env.SHOPIFY_STORES;

  if (storesRaw !== undefined) {
    if (typeof storesRaw !== "string") {
      throw new ConfigError(
        "SHOPIFY_STORES / --stores must be a comma-separated key=domain list.",
      );
    }
    const parsed = parseStoreList(storesRaw);
    const sharedId = nonEmpty(argv.clientId) || nonEmpty(env.SHOPIFY_CLIENT_ID);
    const sharedSecret = nonEmpty(argv.clientSecret) || nonEmpty(env.SHOPIFY_CLIENT_SECRET);
    if (!sharedId || !sharedSecret) {
      throw new ConfigError(
        "Multi-store mode requires SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET. " +
          "Per-store overrides (SHOPIFY_CLIENT_ID__KEY / SHOPIFY_CLIENT_SECRET__KEY) are optional.",
      );
    }

    const stores: StoreCredential[] = parsed.map(({ key, domain }) => {
      const idName = credentialOverrideName("SHOPIFY_CLIENT_ID", key);
      const secretName = credentialOverrideName("SHOPIFY_CLIENT_SECRET", key);
      const idOverride = nonEmpty(env[idName]);
      const secretOverride = nonEmpty(env[secretName]);
      if (Boolean(idOverride) !== Boolean(secretOverride)) {
        throw new ConfigError(
          `Store "${key}" has a partial credential override. Set both ${idName} and ${secretName}, or neither.`,
        );
      }
      return {
        key,
        domain,
        clientId: idOverride ?? sharedId,
        clientSecret: secretOverride ?? sharedSecret,
      };
    });

    return { mode: "multi", apiVersion, stores };
  }

  const domain = nonEmpty(argv.domain) || nonEmpty(env.MYSHOPIFY_DOMAIN);
  const clientId = nonEmpty(argv.clientId) || nonEmpty(env.SHOPIFY_CLIENT_ID);
  const clientSecret = nonEmpty(argv.clientSecret) || nonEmpty(env.SHOPIFY_CLIENT_SECRET);
  const accessToken = nonEmpty(argv.accessToken) || nonEmpty(env.SHOPIFY_ACCESS_TOKEN);
  const useClientCredentials = Boolean(clientId && clientSecret);

  if (!accessToken && !useClientCredentials) {
    throw new ConfigError(SINGLE_STORE_AUTH_ERROR);
  }
  if (!domain) {
    throw new ConfigError(SINGLE_STORE_DOMAIN_ERROR);
  }

  if (useClientCredentials) {
    return {
      mode: "single",
      domain,
      apiVersion,
      auth: { kind: "client_credentials", clientId: clientId!, clientSecret: clientSecret! },
    };
  }
  return {
    mode: "single",
    domain,
    apiVersion,
    auth: { kind: "static", accessToken: accessToken! },
  };
}
