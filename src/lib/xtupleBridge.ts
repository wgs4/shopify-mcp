/**
 * Shopify ⇄ xTuple bridge — information layer.
 *
 * When a Shopify order (or completed draft) is imported into the WGS xTuple
 * ERP, it lands under a per-store customer with a PO number derived from the
 * Shopify order/draft name via a fixed per-store prefix. This module encodes
 * that convention so the MCP can surface the matching xTuple PO number (and
 * customer) directly on order/draft reads — no manual cross-referencing.
 *
 * The map is DATA-DERIVED from `cohead_custponumber` patterns observed in the
 * WGS xTuple `cohead` table (July 2026). It is a best-effort derivation of the
 * *base* PO number; manual edits in xTuple (e.g. "-REPLACEMENT" suffixes,
 * legacy long-form numbers) are not modeled.
 *
 * Observed pattern per store:
 *   regular order  "#28932" → "<prefix>28932"   (e.g. Fortin → "F-28932")
 *   draft order    "#D359"  → "<prefix>D-359"    (e.g. Fortin → "F-D-359")
 */

export interface XtupleStoreInfo {
  /** PO-number prefix, including its trailing separator (e.g. "F-"). */
  prefix: string;
  /** xTuple cust_number the store's orders import under. */
  customer: string;
  /** Human-readable brand/store label. */
  brand: string;
}

/**
 * myshopify domain → xTuple bridge info.
 * Derived from WGS xTuple cohead_custponumber prefixes (2026-07):
 *   INTERNET-WGS → WGS-, FORTIN → F-, INTERNET-AP → AP-, INTERNET-AMP → AMP-
 */
export const XTUPLE_STORE_MAP: Record<string, XtupleStoreInfo> = {
  "wgsusa.myshopify.com": {
    prefix: "WGS-",
    customer: "INTERNET-WGS",
    brand: "Warehouse Guitar Speakers",
  },
  "fortinamps.myshopify.com": {
    prefix: "F-",
    customer: "FORTIN",
    brand: "Fortin Amplification",
  },
  "allpedal.myshopify.com": {
    prefix: "AP-",
    customer: "INTERNET-AP",
    brand: "All-Pedal",
  },
  "amperian.myshopify.com": {
    prefix: "AMP-",
    customer: "INTERNET-AMP",
    brand: "Amperian",
  },
};

/** Resolve the bridge info for a store domain (defaults to this server's store). */
export function getStoreInfo(
  domain: string | undefined = process.env.MYSHOPIFY_DOMAIN,
): XtupleStoreInfo | null {
  if (!domain) return null;
  return XTUPLE_STORE_MAP[domain.trim().toLowerCase()] ?? null;
}

/**
 * Derive the xTuple `cohead_custponumber` for a Shopify order/draft name.
 * Returns null if the store domain is unknown or the name is empty.
 *
 *   deriveXtuplePoNumber("#D359", "fortinamps.myshopify.com") -> "F-D-359"
 *   deriveXtuplePoNumber("#28932", "fortinamps.myshopify.com") -> "F-28932"
 */
export function deriveXtuplePoNumber(
  shopifyName: string,
  domain: string | undefined = process.env.MYSHOPIFY_DOMAIN,
): string | null {
  const info = getStoreInfo(domain);
  if (!info || !shopifyName) return null;

  const name = shopifyName.trim().replace(/^#/, "");
  // Draft names look like "D359" (optionally "D-359"); xTuple stores "D-359".
  const draft = name.match(/^D[-\s]?(\d+)$/i);
  if (draft) return `${info.prefix}D-${draft[1]}`;
  return `${info.prefix}${name}`;
}

/**
 * Build the full xTuple bridge block for an order/draft, or null if the store
 * isn't in the map. Shape is shared by getDraftOrder and the order formatters.
 */
export function xtupleBridge(
  shopifyName: string,
  domain: string | undefined = process.env.MYSHOPIFY_DOMAIN,
): { customer: string; brand: string; poNumber: string | null } | null {
  const info = getStoreInfo(domain);
  if (!info) return null;
  return {
    customer: info.customer,
    brand: info.brand,
    poNumber: deriveXtuplePoNumber(shopifyName, domain),
  };
}
