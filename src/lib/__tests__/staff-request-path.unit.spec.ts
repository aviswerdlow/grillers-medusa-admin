import { generateEntityId } from "@medusajs/framework/utils"
import { isCanonicalStaffPath, staffRequestPath } from "../staff-request-path"

describe("staff request path", () => {
  it("preserves real Medusa ID casing from the original request URL", () => {
    const orderId = generateEntityId(undefined, "order")
    expect(orderId).toMatch(/^order_[0-9A-Z]+$/)
    const path = `/ADMIN/ORDERS/${orderId}`
    expect(staffRequestPath({ originalUrl: `${path}?limit=1`, url: "/ORDERS/other", path: "/other" })).toBe(path)
    expect(isCanonicalStaffPath(path)).toBe(true)
  })

  it.each([
    "/admin/orders#x", "/admin/orders?limit=1#x", "/admin/orders;other",
    "/admin/./orders", "/admin/../orders", "/admin/orders/.", "/admin/orders/..",
    "/admin//orders", "/admin/%6frders", "/admin/orders/",
  ])("rejects ambiguous request target %s", originalUrl => {
    expect(isCanonicalStaffPath(staffRequestPath({ originalUrl }))).toBe(false)
  })
})
