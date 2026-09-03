# Deploy (WGS production VM)

How the WGS production VM runs this Shopify MCP server, and the steps
after a merge. `dist/` is gitignored: a pull alone changes nothing until
the build runs.

## How it runs

Each Claude MCP session launches four processes (one per storefront) as:

```
node /home/itdept/shopify-mcp/dist/index.js --clientId ... --domain <store>
```

New MCP sessions pick up `dist/` automatically. Already-running sessions
keep the `dist/` they started with until they exit.

## After a merge

On the VM, confirm you are on a clean `main`, then pull, install, and build:

```
cd /home/itdept/shopify-mcp && git status --short && git branch --show-current
```

That tree must be `main` and clean. Then:

```
git pull --ff-only origin main && npm ci && npm run build
```

## Rollback

```
git checkout <previous sha> && npm ci && npm run build
```
