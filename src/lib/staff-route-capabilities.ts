import type { StaffCapability } from "./staff-access-policy"

/** Unknown routes are denied to gateway users, including owners. */
export function adminRouteCapability(path: string, method: string, body: any = {}): StaffCapability | null {
  const p = path.replace(/\/+$/, "").toLowerCase()
  const read = method === "GET" || method === "HEAD"
  if (p === "/admin/grillers/local-milestones/orders" || /^\/admin\/grillers\/local-milestones\/orders\/[^/]+$/.test(p)) return read ? "milestones.drive" : null
  if (p === "/admin/grillers/local-milestones/exceptions") return read ? "milestones.office" : null
  if (/^\/admin\/grillers\/local-milestones\/orders\/[^/]+\/events$/.test(p)) return method === "POST" ? "milestones.drive" : null
  if (/^\/admin\/grillers\/local-milestones\/orders\/[^/]+\/corrections$/.test(p)) return method === "POST" ? "milestones.correct" : null
  if (/^\/admin\/grillers\/local-milestones\/orders\/[^/]+\/assign$/.test(p)) return method === "POST" ? "milestones.office" : null
  if (p === "/admin/grillers/staff-access") return read ? "customers.read" : null
  if (p === "/admin/grillers/staff-carts") return method === "POST" ? "customers.write" : null
  if (/^\/admin\/grillers\/staff-access\/customers\/[^/]+$/.test(p)) return method === "POST" ? "team.manage" : null
  if (/^\/admin\/customers(?:\/[^/]+)?(?:\/addresses(?:\/[^/]+)?)?$/.test(p)) return read ? "customers.read" : method === "POST" || (method === "DELETE" && p.includes("/addresses/")) ? "customers.write" : null
  if (p === "/admin/grillers/customers" || /^\/admin\/grillers\/customers\/[^/]+\/offline-payment$/.test(p)) return "customers.write"
  if (/^\/admin\/grillers\/communications(?:\/|$)/.test(p)) return "communications"
  if (/^\/admin\/grillers\/quickbooks-sync(?:\/|$)/.test(p) || /^\/admin\/grillers\/orders\/[^/]+\/accounting-action$/.test(p)) return "accounting"
  if (/^\/admin\/grillers\/inventory\/(availability|allocations)$/.test(p)) return "inventory.read"
  if (p === "/admin/grillers/inventory/incoming") return read ? "inventory.read" : method === "POST" ? "inventory.manage" : null
  if (p === "/admin/grillers/finalization/queue") return read ? "pick" : null
  const finalization = p.match(/^\/admin\/grillers\/orders\/[^/]+\/finalization(?:\/(.*))?$/)
  if (finalization) {
    const action = finalization[1] || ""
    if (read) return action === "" ? "orders.read" : null
    if (["charge-and-release", "retry-charge"].includes(action)) return "charge"
    if (action === "refund-final-charge") return "orders.support"
    if (action === "start") return body?.phase === "pack" ? "pack" : "pick"
    if (action === "packages") return "pack"
    if (["preview", "approve", "return-to-packing", "return-to-picking"].includes(action)) return "finalize"
    if (["ready-for-packing", "unclaim-pick", "lines"].includes(action) || /^lines\/[^/]+$/.test(action)) return "pick"
    return null
  }
  if (method === "POST" && (/^\/admin\/payments\/[^/]+\/capture$/.test(p) || /^\/admin\/grillers\/payments\/[^/]+\/refund$/.test(p))) return "orders.support"
  if (/^\/admin\/orders\/[^/]+\/fulfillments(?:\/[^/]+\/shipments)?$/.test(p) || p === "/admin/fulfillments") return read ? "orders.read" : "fulfill"
  // Generic order metadata writes could counterfeit final-charge/release state.
  // Staff actions use their dedicated guarded endpoints instead.
  if (/^\/admin\/orders(?:\/[^/]+)?$/.test(p)) return read ? "orders.read" : null
  if (/^\/admin\/orders\/[^/]+\/cancel$/.test(p) || /^\/admin\/order-edits(?:\/|$)/.test(p)) return "orders.support"
  if (/^\/admin\/(legacy-orders|legacy-order-history|legacy-reorder-requests|legacy-item-mapping-candidates)(?:\/|$)/.test(p)) return "orders.support"
  if (read && /^\/admin\/(products|product-variants|product-categories|product-collections|product-tags|regions|sales-channels|shipping-options|shipping-profiles)(?:\/|$)/.test(p)) return "catalog.read"
  if (read && /^\/admin\/(inventory-items|stock-locations|reservations)(?:\/|$)/.test(p)) return "inventory.read"
  return null
}

/** Actual GET-only discovery used by the QBD reader and catalog/baseline tools. */
export function isReadOnlyServiceRoute(path: string, method: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false
  const p = path.replace(/\/+$/, "").toLowerCase()
  return /^\/admin\/(products|product-variants|inventory-items|stock-locations|reservations|orders|customers)(?:\/[^/]+)?$/.test(p)
    || /^\/admin\/inventory-items\/[^/]+\/location-levels$/.test(p)
    || p === "/admin/grillers/inventory/allocations"
}

/** Separate IDs own catalog sync and the cron's three receipt markers. Neither is an operator. */
export function isServiceRoute(role: string | undefined, path: string, method: string, body: any = {}): boolean {
  if (role === "read_only" || !role) return isReadOnlyServiceRoute(path, method)
  const p = path.replace(/\/+$/, "").toLowerCase()
  if (role === "qbd_catalog") {
    if (isReadOnlyServiceRoute(p, method) || ((method === "GET" || method === "HEAD") && p === "/admin/sales-channels")) return true
    if (method !== "POST") return false
    return /^\/admin\/products(?:\/[^/]+)?$/.test(p)
      || /^\/admin\/products\/[^/]+\/variants\/[^/]+\/inventory-items$/.test(p)
      || /^\/admin\/inventory-items(?:\/[^/]+)?(?:\/location-levels(?:\/[^/]+)?)?$/.test(p)
  }
  if (role !== "communications") return false
  if (isReadOnlyServiceRoute(p, method)) return true
  if (method !== "POST" || !/^\/admin\/(customers|orders)\/[^/]+$/.test(p)) return false
  if (!body || Object.keys(body).length !== 1 || !body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) return false
  const keys = Object.keys(body.metadata)
  return keys.length > 0 && keys.every(key => ["review_ask_sent_google_at", "review_ask_sent_yelp_at", "review_request_sent_at"].includes(key)
    && typeof body.metadata[key] === "string" && /^\d{4}-\d{2}-\d{2}T/.test(body.metadata[key]) && Number.isFinite(Date.parse(body.metadata[key])))
}
