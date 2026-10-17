#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import dotenv from "dotenv";
import { GraphQLClient } from "graphql-request";
import minimist from "minimist";

import {
  attachActivityToTransport,
  startLifecycleWatchdog,
} from "./lib/lifecycleWatchdog.js";
import { createShopifyMcpServer } from "./lib/registerTools.js";
import { ShopifyAuth } from "./lib/shopifyAuth.js";
import {
  loadServerConfig,
  type ServerConfig,
  type SingleStoreConfig,
} from "./lib/storeConfig.js";
import { StoreRegistry } from "./lib/storeRegistry.js";
import type { StoreContext } from "./lib/toolUtils.js";

// Parse command line arguments
const argv = minimist(process.argv.slice(2));

// Load environment variables from .env file (if it exists)
dotenv.config();

let config: ServerConfig;
try {
  config = loadServerConfig(process.env, {
    accessToken: argv.accessToken,
    clientId: argv.clientId,
    clientSecret: argv.clientSecret,
    domain: argv.domain,
    apiVersion: argv.apiVersion,
    stores: argv.stores,
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const server =
  config.mode === "single"
    ? createShopifyMcpServer({
        mode: "single",
        context: await buildSingleStoreContext(config),
      })
    : createShopifyMcpServer({
        mode: "multi",
        registry: new StoreRegistry(config.stores, config.apiVersion),
      });

// Arm the lifecycle watchdog before connecting the transport so the idle
// clock starts at server-ready and so the message-level activity hook is in
// place before Protocol.connect() captures it.
startLifecycleWatchdog();

// Start the server
const transport = new StdioServerTransport();
attachActivityToTransport(transport);
server
  .connect(transport)
  .then(() => {})
  .catch((error: unknown) => {
    console.error("Failed to start Shopify MCP Server:", error);
  });

async function buildSingleStoreContext(single: SingleStoreConfig): Promise<StoreContext> {
  // Store in process.env for backwards compatibility with single-store deploys.
  process.env.MYSHOPIFY_DOMAIN = single.domain;

  let accessToken: string;
  let auth: ShopifyAuth | null = null;

  if (single.auth.kind === "client_credentials") {
    auth = new ShopifyAuth({
      clientId: single.auth.clientId,
      clientSecret: single.auth.clientSecret,
      shopDomain: single.domain,
    });
    accessToken = await auth.initialize();
  } else {
    accessToken = single.auth.accessToken;
  }

  process.env.SHOPIFY_ACCESS_TOKEN = accessToken;

  const shopifyClient = new GraphQLClient(
    `https://${single.domain}/admin/api/${single.apiVersion}/graphql.json`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    },
  );

  // Let the auth manager hot-swap the token header on refresh
  if (auth) {
    auth.setGraphQLClient(shopifyClient);
  }

  const staticToken = accessToken;
  return {
    client: shopifyClient,
    domain: single.domain,
    storeKey: single.domain,
    getAccessToken: () => (auth ? auth.getAccessToken() : staticToken),
    apiVersion: single.apiVersion,
  };
}
