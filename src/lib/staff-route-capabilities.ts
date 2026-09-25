import type { StaffCapability } from "./staff-access-policy"
import { isCanonicalStaffPath } from "./staff-request-path"

/** Unknown routes are denied to gateway users, including owners. */
export function adminRouteCapability(path: string, method: string, body: any = {}): StaffCapability | null {
  if (!isCanonicalStaffPath(path)) return null
  const p = path
  const read = method === "GET" || method === "HEAD"
  if (/^\/admin\/grillers\/staff-access$/i.test(p)) return read ? "customers.read" : null
  if (/^\/admin\/grillers\/staff-carts$/i.test(p)) return method === "POST" ? "customers.write" : null
  if (/^\/admin\/grillers\/staff-access\/customers\/[^/]+$/i.test(p)) return method === "POST" ? "team.manage" : null
  if (/^\/admin\/customers(?:\/[^/]+)?(?:\/addresses(?:\/[^/]+)?)?$/i.test(p)) return read ? "customers.read" : method === "POST" || (method === "DELETE" && /\/addresses\//i.test(p)) ? "customers.write" : null
  if (/^\/admin\/grillers\/customers$/i.test(p) || /^\/admin\/grillers\/customers\/[^/]+\/offline-payment$/i.test(p)) return "customers.write"
  if (/^\/admin\/grillers\/customers\/[^/]+\/institutional-terms$/i.test(p)) return read ? "customers.read" : null
  if (/^\/admin\/grillers\/orders\/[^/]+\/institutional-collection$/i.test(p)) return read ? "orders.read" : null
  if (/^\/admin\/grillers\/communications(?:\/|$)/i.test(p)) return "communications"
  if (/^\/admin\/grillers\/quickbooks-sync(?:\/|$)/i.test(p) || /^\/admin\/grillers\/orders\/[^/]+\/accounting-action$/i.test(p)) return "accounting"
  if (/^\/admin\/grillers\/inventory\/(availability|allocations)$/i.test(p)) return "inventory.read"
  if (/^\/admin\/grillers\/inventory\/incoming$/i.test(p)) return read ? "inventory.read" : method === "POST" ? "inventory.manage" : null
  if (/^\/admin\/grillers\/finalization\/queue$/i.test(p)) return read ? "pick" : null
  const finalization = p.match(/^\/admin\/grillers\/orders\/[^/]+\/finalization(?:\/(.*))?$/i)
  if (finalization) {
    const action = finalization[1] || ""
    if (read) return action === "" ? "orders.read" : null
    if (/^(charge-and-release|retry-charge)$/i.test(action)) return "charge"
    if (/^refund-final-charge$/i.test(action)) return "orders.support"
    if (/^start$/i.test(action)) return body?.phase === "pack" ? "pack" : "pick"
    if (/^packages$/i.test(action)) return "pack"
    if (/^(preview|approve|return-to-packing|return-to-picking)$/i.test(action)) return "finalize"
    if (/^(ready-for-packing|unclaim-pick|lines)$/i.test(action) || /^lines\/[^/]+$/i.test(action)) return "pick"
    return null
  }
  if (method === "POST" && (/^\/admin\/payments\/[^/]+\/capture$/i.test(p) || /^\/admin\/grillers\/payments\/[^/]+\/refund$/i.test(p))) return "orders.support"
  if (/^\/admin\/orders\/[^/]+\/fulfillments(?:\/[^/]+\/shipments)?$/i.test(p) || /^\/admin\/fulfillments$/i.test(p)) return read ? "orders.read" : "fulfill"
  // Generic order metadata writes could counterfeit final-charge/release state.
  // Staff actions use their dedicated guarded endpoints instead.
  if (/^\/admin\/orders(?:\/[^/]+)?$/i.test(p)) return read ? "orders.read" : null
  if (/^\/admin\/orders\/[^/]+\/cancel$/i.test(p) || /^\/admin\/order-edits(?:\/|$)/i.test(p)) return "orders.support"
  if (/^\/admin\/(legacy-orders|legacy-order-history|legacy-reorder-requests|legacy-item-mapping-candidates)(?:\/|$)/i.test(p)) return "orders.support"
  if (read && /^\/admin\/(products|product-variants|product-categories|product-collections|product-tags|regions|sales-channels|shipping-options|shipping-profiles)(?:\/|$)/i.test(p)) return "catalog.read"
  if (read && /^\/admin\/(inventory-items|stock-locations|reservations)(?:\/|$)/i.test(p)) return "inventory.read"
  return null
}

/** Actual GET-only discovery used by the QBD reader and catalog/baseline tools. */
export function isReadOnlyServiceRoute(path: string, method: string): boolean {
  if (method !== "GET" || !isCanonicalStaffPath(path)) return false
  const p = path
  return /^\/admin\/(products|product-variants|inventory-items|stock-locations|reservations|orders|customers)(?:\/[^/]+)?$/i.test(p)
    || /^\/admin\/inventory-items\/[^/]+\/location-levels$/i.test(p)
    || /^\/admin\/grillers\/inventory\/allocations$/i.test(p)
}

/** Separate IDs own catalog sync and the cron's three receipt markers. Neither is an operator. */
export function isServiceRoute(role: string | undefined, path: string, method: string, body: any = {}): boolean {
  if (!isCanonicalStaffPath(path)) return false
  if (role === "read_only" || !role) return isReadOnlyServiceRoute(path, method)
  const p = path
  if (role === "qbd_catalog") {
    if (isReadOnlyServiceRoute(p, method) || ((method === "GET" || method === "HEAD") && /^\/admin\/sales-channels$/i.test(p))) return true
    if (method !== "POST") return false
    return /^\/admin\/products(?:\/[^/]+)?$/i.test(p)
      || /^\/admin\/products\/[^/]+\/variants\/[^/]+\/inventory-items$/i.test(p)
      || /^\/admin\/inventory-items(?:\/[^/]+)?(?:\/location-levels(?:\/[^/]+)?)?$/i.test(p)
  }
  if (role !== "communications") return false
  if (isReadOnlyServiceRoute(p, method)) return true
  if (method !== "POST" || !/^\/admin\/(customers|orders)\/[^/]+$/i.test(p)) return false
  if (!body || Object.keys(body).length !== 1 || !body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) return false
  const keys = Object.keys(body.metadata)
  return keys.length > 0 && keys.every(key => ["review_ask_sent_google_at", "review_ask_sent_yelp_at", "review_request_sent_at"].includes(key)
    && typeof body.metadata[key] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.metadata[key]) && Number.isFinite(Date.parse(body.metadata[key])))
}
