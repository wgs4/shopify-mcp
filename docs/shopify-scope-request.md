# Shopify scope request: read_all_orders and friends (app `shop-wgs-mcp-8-6-26`)

Status: WAITING ON DAVID (human gate). Written 2026-09-03 for PRD "The 60-Day Order Wall".

## Why this exists

The custom app `shop-wgs-mcp-8-6-26` authenticates all four store MCP servers
(WGS, All-Pedal, Amperian, Fortin). It holds `read_orders`, and Shopify caps
that scope at the last 60 days of orders. Every order query, cursor or bulk,
silently returns nothing older. The MCP now raises `ScopeHorizonError` instead
of returning an empty list, but the data itself stays hidden until the scopes
below are granted.

Live probe, 2026-09-03 (all four stores, `currentAppInstallation { accessScopes }`):
present = read_customers, read/write_draft_orders, read/write_inventory,
read_locations, read_orders, read_products, read_reports, read_shopify_payments_*.
Missing = everything in the table below.

## Scopes to request

| Scope | Unlocks | Required by |
|---|---|---|
| `read_all_orders` | Orders older than 60 days (cursor and bulk) | PRD R1; `get-product-order-history` history before the wall; `get-orders` date filters |
| `read_returns` | `Order.returns` (physical returns, distinct from refunds) | PRD R7 `units_returned` |
| `read_merchant_managed_fulfillment_orders` | `Order.fulfillmentOrders` for merchant-fulfilled orders | PRD R4 unfulfilled cross-check; `get-fulfillment-orders` (broken today) |
| `read_assigned_fulfillment_orders` | Fulfillment orders assigned to fulfillment services | same |
| `read_third_party_fulfillment_orders` | Fulfillment orders handled by third parties | same |

`read_all_orders` is approval-gated. Per shopify.dev (Access scopes > Orders
permissions): "By default, you have access to the last 60 days' worth of orders
for a store. To access all the orders, you need to request access to the
`read_all_orders` scope." The request is made from the Partner Dashboard:
Apps > (the app) > API access > "Read all orders scope" card > Request access.
The other four scopes are ordinary scopes and can be added directly.

## Justification text (paste into the request form)

> WGS USA operates the WGS, All-Pedal, Amperian and Fortin Amplification stores
> and reconciles every Shopify order against its xTuple ERP for accounting and
> royalty reporting. Royalty statements to third-party pedal designers and
> quarterly commission reports require unit counts of orders shipped, cancelled,
> refunded and returned per SKU across full calendar years, and accounting
> reconciliation regularly needs orders older than 60 days. The app is an
> internal, read-mostly integration (MCP server) used only by WGS staff tooling.
> No marketing use, no customer data export, no third-party sharing.

## Rollout runbook (one maintenance window, all four stores)

1. In the Partner/Dev Dashboard, add the five scopes to the app configuration
   and submit the `read_all_orders` access request. Wait for approval.
2. Re-install / re-authorize the app on each of the four stores so the new
   scopes take effect. Do all four in the same window; the app is shared.
3. No MCP config change is needed. The servers use client credentials and
   exchange them for a fresh token at every start-up, so new MCP sessions pick
   up the new scopes automatically. Long-running sessions refresh their token
   within 24 h; restart them to pick up scopes sooner.
4. Verify per store (read-only):
   `get-orders` with `query: "created_at:>=2025-01-01"` returns rows instead of
   `ScopeHorizonError`; the response `horizon.scope_missing` is `null`.
5. Run the acceptance check from the PRD on All-Pedal:
   `get-product-order-history` with `skus: ["7711-P", "7655-P"]`,
   `since: "2025-01-01"`, `until: "2025-12-31"`. Expected: shipped minus
   returned reconciles to the 64 net items ShopifyQL reports for 2025, and the
   refund line items account for the $227.50 (Feb) and $276.25 (May) returns.

## Rollback

Removing a scope only hides data again; the MCP degrades to explicit
`ScopeHorizonError` / scope-naming errors, never to silent empty results.
