# Changelog

All notable changes to this project are documented here.
The format follows Keep a Changelog; versions follow package.json.

## [1.4.0] - 2026-10-31

### Added
- `order-edit`: add variants, swap items, or set quantities on placed orders through Shopify's order-edit workflow. Defaults to a fresh, uncommitted dry run and customer notification off; `commit: true` applies changes. Returns before/after lines, current money totals, and explicit outstanding payment/refund warnings without collecting payment or refunding.
- Exact order-name and SKU resolution with ambiguity errors, pagination of order and calculated line items, cancelled/fulfilled-line guards, and a fail-fast `write_order_edits` scope check.
- Commit-aware errors: failed reads after a successful commit retain `committed: true` and mark incomplete output; an uncertain commit response requires re-reading the order before retrying.
- Mocked Jest coverage for staging, commit order, SKU resolution, refusals, mutation errors, defaults, pagination, and outstanding balances.

### Changed
- Package minor version is now 1.4.0; registry and README list 51 tools.
- Scope request runbook now includes `write_order_edits` and re-authorization steps. No scope grant or deployment is implied.

## [1.3.0] - 2026-09-03

### Added
- `get-product-order-history`: one call returns units ordered, shipped, cancelled, refunded (with amounts), returned, and unfulfilled for a list of SKUs or one product over a shop-local date window. Each metric is dated by its own event (order created, fulfillment, cancel, refund, return), boundaries resolve in the shop timezone, and month or channel buckets, a reconciliation block, and optional per-order evidence rows come back with the totals. Ranges over 90 days use a Shopify bulk operation; shorter ranges use cursor pagination. Results carry `horizon`, `completeness`, `source`, and `warnings` so an agent can see exactly what was and was not visible.
- 60-day order wall guard: `get-orders` now raises `ScopeHorizonError` (naming the horizon, the missing `read_all_orders` scope, and the earliest accepted `created_at` bound) instead of silently returning an empty list when a query reaches past the token's 60-day window, and `get-order-by-id` says why a pre-horizon order is not found. Every `get-orders`, `get-customer-orders`, and `get-order-by-id` response includes a `horizon` block.
- `docs/shopify-scope-request.md`: the scope request and four-store re-authorization runbook (`read_all_orders`, `read_returns`, fulfillment-order scopes).
- `docs/DEPLOY.md`: how the WGS production VM runs the four storefront servers, the pull-and-build step after a merge, and rollback.
- Shared libraries: shop-timezone helpers, access-scope cache, bulk-operation runner, pure per-SKU counting engine, throttle-aware fetch layer, with 255 unit tests (the full suite now runs 335).

### Changed
- Tool descriptions are now delivered to the MCP host (previously every tool's description was dropped at registration).
- `get-fulfillment-orders` names the missing fulfillment-order scopes instead of a bare access-denied error.
- `get-orders` rejects a `query` longer than 4,096 characters.
- Typed errors (`ScopeHorizonError`, `MissingScopeError`, `BulkOperationError`) pass through unwrapped so their self-contained messages reach the agent.
- README documents the wall rule, the new tool, and the updated tool count (50).
