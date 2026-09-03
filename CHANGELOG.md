# Changelog

All notable changes to this project are documented here.
The format follows Keep a Changelog; versions follow package.json.

## [1.3.0] - 2026-09-03

### Added
- `get-product-order-history`: one call returns units ordered, shipped, cancelled, refunded (with amounts), returned, and unfulfilled for a list of SKUs or one product over a shop-local date window. Each metric is dated by its own event (order created, fulfillment, cancel, refund, return), boundaries resolve in the shop timezone, and month or channel buckets, a reconciliation block, and optional per-order evidence rows come back with the totals. Ranges over 90 days use a Shopify bulk operation; shorter ranges use cursor pagination. Results carry `horizon`, `completeness`, `source`, and `warnings` so an agent can see exactly what was and was not visible.
- 60-day order wall guard: `get-orders`, `get-customer-orders`, and `get-order-by-id` now raise `ScopeHorizonError` (naming the horizon, the missing `read_all_orders` scope, and the earliest accepted `created_at` bound) instead of silently returning an empty list when a query reaches past the token's 60-day window. Every order response includes a `horizon` block.
- `docs/shopify-scope-request.md`: the scope request and four-store token rotation runbook (`read_all_orders`, `read_returns`, fulfillment-order scopes).
- Shared libraries: shop-timezone helpers, access-scope cache, bulk-operation runner, pure per-SKU counting engine, throttle-aware fetch layer, with 320 unit tests.

### Changed
- Tool descriptions are now delivered to the MCP host (previously every tool's description was dropped at registration).
- `get-fulfillment-orders` names the missing fulfillment-order scopes instead of a bare access-denied error.
- Typed errors (`ScopeHorizonError`, `MissingScopeError`, `BulkOperationError`) pass through unwrapped so their self-contained messages reach the agent.
- README documents the wall rule, the new tool, and the full tool list (50 tools).
