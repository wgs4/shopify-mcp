# Deploy (WGS production VM)

How the WGS production VM runs this Shopify MCP server, and the steps
after a merge. `dist/` is gitignored: a pull alone changes nothing until
the build runs.


## Where the server lives on the VM (verified 2026-09-03)

The production VM (`itdept@192.168.1.193`, ssh port 23500) holds two separate checkouts:

| Path | Repository | Used by |
|---|---|---|
| `/home/itdept/code` | the xTuple/ERP code base | the ERP MCP and accounting tooling (not this project) |
| `/home/itdept/shopify-mcp` | this repository (`wgs4/shopify-mcp`), branch `main` | the four Shopify MCP servers |

Evidence: `~/.claude.json` launches every Shopify MCP server as
`ssh -p 23500 itdept@192.168.1.193 node /home/itdept/shopify-mcp/dist/index.js --clientId ... --domain <store>`,
and on 2026-09-03 `/home/itdept/shopify-mcp` was on `main`, clean, at the same commit as `origin/main`, with `dist/index.js` present (Node v22). Always confirm with `git branch --show-current` and `git status --short` before touching it.

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

1. On the VM, build the previous release while staying inside the checkout:
   ```bash
   cd /home/itdept/shopify-mcp
   git checkout <previous-sha>        # temporary detached checkout
   npm ci && npm run build
   ```
   New MCP sessions now run the previous build. Existing sessions keep the old process until they end.
2. Land the forward fix on `main` through a normal PR, then restore a clean `main` checkout:
   ```bash
   cd /home/itdept/shopify-mcp
   git checkout main && git pull --ff-only origin main
   npm ci && npm run build
   git status --short && git branch --show-current   # must print nothing and "main"
   ```
Never leave the VM detached after the incident; never `reset --hard` or force-push on the VM.
