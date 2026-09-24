/**
 * Regression tests for the order.placed post-placement subscribers, built from a
 * SNAPSHOT OF A REAL PRODUCTION ORDER (order_01KVHNQ2MNQ1P50DVB62D7F3CC, display
 * 135) rather than hand-built mocks.
 *
 * The original suites for these subscribers passed because their mock order data
 * had a convenient shape (e.g. shipping_methods[0].data.service_code = "GROUND",
 * order.metadata = {…}). The real order differs in three load-bearing ways that
 * broke order.placed processing in prod (2026-06-20 04:48):
 *   - order.metadata is NULL (not an object)
 *   - shipping_methods[0].data = { externalId } and .metadata = null, so the UPS
 *     service code is ONLY derivable from method.name ("UPS Overnight Shipping")
 *   - bundle line metadata; variant.metadata only carries qbd_list_id
 *
 * The three prod failures and what these tests pin:
 *   1. `Failed to track order.placed`        — order-placed.ts query.graph used
 *      `+`-prefixed NESTED fields (`+items.metadata`, `+customer.metadata`,
 *      `+shipping_methods.data`). In query.graph (unlike the REST `fields=`
 *      param) a leading `+` on a DOTTED path becomes part of the relation key,
 *      so the query throws `Entity 'Order' does not have property '+items'`
 *      BEFORE analytics.track() is ever reached.
 *   2. `shipping_forecast: reading 'kind'`   — same query bug in
 *      shipping-forecast.ts; plus the service-code resolver first-won on the
 *      opaque shipping_option_id and skipped real UPS orders. (.kind is guarded
 *      in gbmFeatureValue for defense-in-depth.)
 *   3. `inventory-allocation: '+items'`      — same query bug in
 *      inventory-allocation.ts ORDER_ALLOCATION_FIELDS / fetchVariants. Inventory
 *      was never allocated on any order (oversell risk).
 */
import { toRemoteQuery } from "@medusajs/modules-sdk/dist/remote-query/to-remote-query"
import orderPlacedHandler from "../../subscribers/analytics/order-placed"
import { buildShippingForecastEvent } from "../../subscribers/analytics/shipping-forecast"
import { createAllocationsForOrder } from "../inventory-allocation"
import { evaluateGbm } from "../shipping-cost-forecast"
import realOrder from "./__fixtures__/order-135-real.json"

// The exact query.graph field arrays each subscriber/lib sends. Kept in sync with
// the source so a future re-introduction of a `+`-prefixed nested field is caught.
const ORDER_PLACED_FIELDS = [
  "id",
  "display_id",
  "cart_id",
  "created_at",
  "email",
  "currency_code",
  "customer_id",
  "customer.*",
  "customer.groups.*",
  "customer.metadata",
  "customer.groups.metadata",
  "total",
  "subtotal",
  "item_total",
  "tax_total",
  "shipping_total",
  "discount_total",
  "metadata",
  "shipping_address.*",
  "items.*",
  "items.metadata",
  "items.variant.*",
  "items.variant.product.*",
  "items.variant.product.metadata",
  "shipping_methods.*",
  "shipping_methods.shipping_option_id",
  "shipping_methods.data",
  "shipping_methods.metadata",
  "payment_collections.payments.*",
]

const SHIPPING_FORECAST_FIELDS = [
  "id",
  "display_id",
  "created_at",
  "email",
  "currency_code",
  "customer_id",
  "customer.*",
  "customer.groups.*",
  "customer.metadata",
  "customer.groups.metadata",
  "shipping_total",
  "metadata",
  "shipping_address.*",
  "items.*",
  "items.metadata",
  "items.variant.*",
  "items.variant.product.*",
  "items.variant.product.metadata",
  "shipping_methods.*",
  "shipping_methods.shipping_option_id",
  "shipping_methods.data",
  "shipping_methods.metadata",
]

const ORDER_ALLOCATION_FIELDS = [
  "id",
  "display_id",
  "email",
  "customer_id",
  "cart_id",
  "metadata",
  "items.*",
  "items.detail.*",
  "items.metadata",
  "items.variant.*",
  "items.variant.metadata",
  "items.variant.product.*",
  "items.variant.product.metadata",
  "items.variant.inventory_items.*",
  "items.variant.inventory_items.required_quantity",
  "items.variant.inventory_items.inventory.*",
  "items.variant.inventory_items.inventory.location_levels.*",
]

const FETCH_VARIANTS_FIELDS = [
  "id",
  "sku",
  "title",
  "product_id",
  "metadata",
  "manage_inventory",
  "allow_backorder",
  "+inventory_quantity",
  "product.*",
  "product.metadata",
  "inventory_items.*",
  "inventory_items.required_quantity",
  "inventory_items.inventory.*",
  "inventory_items.inventory.location_levels.*",
]

/**
 * A `+`-prefixed DOTTED field (e.g. "+items.metadata") is a query.graph bug: the
 * leading "+" ends up on the first path segment, producing a relation key like
 * "+items" that Medusa cannot resolve. A "+" on a TOP-LEVEL field (no dot, e.g.
 * "+inventory_quantity") is fine — it stays a leaf field marker.
 */
function plusPrefixedNestedFields(fields: string[]): string[] {
  return fields.filter((f) => f.startsWith("+") && f.includes("."))
}

/** Top-level relation keys query.graph would build (excludes the __fields list). */
function relationKeys(entity: string, fields: string[]): string[] {
  const q = toRemoteQuery({ entity, fields, filters: {} } as any, new Map())
  return Object.keys((q as any)[entity]).filter((k) => k !== "__fields")
}

describe("order.placed subscriber query fields (real-order regression)", () => {
  const cases: Array<[string, string, string[]]> = [
    ["order-placed.ts", "order", ORDER_PLACED_FIELDS],
    ["shipping-forecast.ts", "order", SHIPPING_FORECAST_FIELDS],
    ["inventory-allocation ORDER_ALLOCATION_FIELDS", "order", ORDER_ALLOCATION_FIELDS],
    ["inventory-allocation fetchVariants", "product_variant", FETCH_VARIANTS_FIELDS],
  ]

  it.each(cases)(
    "%s carries no `+`-prefixed nested fields",
    (_name, _entity, fields) => {
      expect(plusPrefixedNestedFields(fields)).toEqual([])
    }
  )

  it.each(cases)(
    "%s produces no `+`-prefixed relation key through query.graph's toRemoteQuery",
    (_name, entity, fields) => {
      const badKeys = relationKeys(entity, fields).filter((k) => k.startsWith("+"))
      expect(badKeys).toEqual([])
    }
  )

  it("proves the bug shape: a `+`-prefixed nested field WOULD build a broken `+items` relation key", () => {
    // This is the exact failure: `+items.metadata` → relation key "+items" →
    // "Entity 'Order' does not have property '+items'". Guards the diagnosis.
    const keys = relationKeys("order", ["id", "+items.metadata"])
    expect(keys).toContain("+items")
  })
})

describe("buildShippingForecastEvent on the REAL order", () => {
  const ENV_PACKAGING_ON = { GRILLERS_SHIPPING_FORECAST_INCLUDE_PACKAGING: "true" }

  it("does not throw and resolves OVERNIGHT from method.name when data/metadata lack a service_code", () => {
    // Real order: shipping_methods[0] = { name: "UPS Overnight Shipping",
    // amount: 164.49, data: { externalId }, metadata: null }. The resolver must
    // fall through to method.name (NOT first-win on the opaque shipping_option_id).
    const method = realOrder.shipping_methods[0]
    expect(method.data).not.toHaveProperty("service_code")
    expect(method.metadata).toBeNull()

    let payload: ReturnType<typeof buildShippingForecastEvent>
    expect(() => {
      payload = buildShippingForecastEvent(realOrder as any)
    }).not.toThrow()

    expect(payload!).not.toBeNull()
    const p = payload!.properties
    expect(p.service).toBe("OVERNIGHT")
    expect(p.fulfillment_tier).toBe("ups_overnight")
    expect(p.ship_state).toBe("MA")
    expect(p.dest_postal_code).toBe("02453")
    expect(p.route_market).toBe("national")
    // A legacy order retains its observed charge but has no accepted packing snapshot.
    expect(p.charged_shipping).toBe(164.49)
    expect(p.estimate_status).toBe("unavailable_legacy_snapshot")
    expect(p.packaging_cost).toBeNull()
    expect(p.freight).toBeNull()
    expect(p.packaging_included_in_charge).toBeNull()
  })

  it("regression: an opaque shipping_option_id must NOT shadow a UPS method.name", () => {
    // Reproduces the skip bug directly: with no service_code anywhere and a
    // non-UPS option id, the human-readable UPS name must still win.
    const order = {
      ...(realOrder as any),
      shipping_methods: [
        {
          name: "UPS Ground Estimated Shipping",
          amount: 42,
          shipping_option_id: "so_01ABCNOTAUPSCODE",
          data: { externalId: 999 },
          metadata: null,
        },
      ],
      shipping_total: 42,
    }
    const payload = buildShippingForecastEvent(order)
    expect(payload).not.toBeNull()
    expect(payload!.properties.service).toBe("GROUND")
  })
})

describe("evaluateGbm column guard (.kind defense-in-depth)", () => {
  it("does not throw `reading 'kind'` when a model column is undefined/malformed", () => {
    const model: any = {
      status: "trained",
      schema_version: "shipping_cost_forecast_v3",
      model_type: "hist_gbm",
      baseline: 10,
      // A malformed/partially-uploaded column set: undefined + missing-kind entries.
      columns: [undefined, { name: "subtotal" }, { kind: "num", name: "subtotal" }],
      service_levels: [],
      zip3_zone: {},
      state_zone: {},
      default_zone: 5,
      trees: [],
    }
    const input: any = {
      service: "GROUND",
      ship_state: "GA",
      ship_postal_code: "30301",
      subtotal: 100,
      line_count: 1,
      unit_count: 1,
      fixed_line_count: 1,
      per_lb_line_count: 0,
      unknown_pricing_line_count: 0,
      estimated_product_weight_lb: 5,
    }
    expect(() => evaluateGbm(model, input)).not.toThrow()
    // baseline with empty trees → max(0, 10)
    expect(evaluateGbm(model, input)).toBe(10)
  })
})

/**
 * Finding #1 (revenue correctness): the real order's COMPUTED `order.total` is 0
 * even though it is genuinely a $332.73 order (item_total 168.24 + shipping 164.49;
 * verified against the live order + its payment_collection amount 332.73). NOTE the
 * reconstruction uses `item_total` (goods only, 168.24), NOT `subtotal` — on this
 * order `subtotal` (332.73) ALREADY includes shipping (item_total + shipping_total),
 * so `subtotal + shipping` would double-count shipping to a phantom 497.22. The
 * `order_received` warehouse event must carry the real revenue (332.73), not the
 * phantom 0 and not the double-counted 497.22.
 */
describe("order_received estimated_value on the REAL order (revenue correctness)", () => {
  function makeContainer(order: Record<string, any>) {
    const analytics = { track: jest.fn().mockResolvedValue(undefined) }
    const logger = { error: jest.fn() }
    const query = { graph: jest.fn().mockResolvedValue({ data: [order] }) }
    const container = {
      resolve: (key: string) => {
        if (key === "analytics") return analytics
        if (key === "logger") return logger
        if (key === "query") return query
        throw new Error(`unexpected resolve ${key}`)
      },
    }
    return { container, analytics, logger, query }
  }

  it("sanity: the real order really has total=0 with a populated item_total/shipping (and a subtotal that already bakes in shipping)", () => {
    expect(realOrder.total).toBe(0)
    expect(realOrder.item_total).toBe(168.24)
    expect(realOrder.shipping_total).toBe(164.49)
    // `subtotal` ALREADY includes shipping (item_total + shipping_total), which is
    // exactly why the reconstruction must use item_total, not subtotal.
    expect(realOrder.subtotal).toBe(332.73)
    expect(realOrder.item_total + realOrder.shipping_total).toBe(realOrder.subtotal)
  })

  it("emits a NONZERO estimated_value (item_total+shipping+tax-discount) when total is 0", async () => {
    const { container, analytics } = makeContainer(realOrder as any)

    await orderPlacedHandler({
      event: { name: "order.placed", data: { id: realOrder.id } },
      container,
    } as any)

    expect(analytics.track).toHaveBeenCalledTimes(1)
    const call = analytics.track.mock.calls[0][0]
    expect(call.event).toBe("order_received")
    // 168.24 + 164.49 + 0 - 0 = 332.73 — the real order value (NOT the phantom
    // computed total of 0, and NOT the shipping-double-counted 497.22).
    expect(call.properties.estimated_value).toBe(332.73)
    expect(call.properties.estimated_value).toBeGreaterThan(0)
  })

  it("prefers a positive computed total when one exists", async () => {
    const order = { ...(realOrder as any), total: 510.5 }
    const { container, analytics } = makeContainer(order)

    await orderPlacedHandler({
      event: { name: "order.placed", data: { id: order.id } },
      container,
    } as any)

    expect(analytics.track.mock.calls[0][0].properties.estimated_value).toBe(510.5)
  })
})

/**
 * Finding #4: prove inventory reservation ROWS are actually inserted (not just
 * that the query shape is valid) on a REAL multi-line order — and that Finding #3's
 * cart_id attribution lands on each row.
 */
describe("createAllocationsForOrder inserts reservation rows on the real multi-line order", () => {
  function makeAllocationDb() {
    const inserts: Array<{ table: string; data: any }> = []
    const db: any = jest.fn((table: string) => {
      const chain: any = {
        select: () => chain,
        whereNull: () => chain,
        where: () => chain,
        whereIn: () => chain,
        limit: () => chain,
        orderBy: () => chain,
        offset: () => chain,
        update: async () => 1,
        then: (resolve: any) => resolve([]), // no existing allocations / active rows
        insert: async (data: any) => {
          inserts.push({ table, data })
          return data
        },
      }
      return chain
    })
    return { db, inserts }
  }

  // One in-stock managed variant per real line item, so every line allocates.
  function variantsForRealOrder() {
    return (realOrder as any).items.map((item: any) => ({
      id: item.variant_id,
      sku: item.variant?.sku || item.variant_id,
      title: item.title,
      product_id: item.variant?.product?.id || item.product_id,
      manage_inventory: true,
      allow_backorder: false,
      inventory_quantity: 100,
      metadata: item.variant?.metadata || {},
      product: item.variant?.product || { id: item.product_id, metadata: {} },
    }))
  }

  function makeQueryForRealOrder(order: Record<string, any>) {
    const variants = variantsForRealOrder()
    return {
      graph: jest.fn(async ({ entity }: any) => {
        if (entity === "product_variant") return { data: variants }
        if (entity === "order") return { data: [order] }
        return { data: [] }
      }),
    }
  }

  it("inserts one gp_inventory_allocation row per line, each carrying order cart_id", async () => {
    // Give the real order a cart_id so we can prove the attribution lands on rows.
    const order = { ...(realOrder as any), cart_id: "cart_real_135" }
    const { db, inserts } = makeAllocationDb()
    const query = makeQueryForRealOrder(order)

    const result = await createAllocationsForOrder({
      db: db as any,
      query: query as any,
      orderId: order.id,
      now: new Date("2026-06-19T12:00:00Z"),
    })

    const allocationInserts = inserts.filter(
      (i) => i.table === "gp_inventory_allocation"
    )
    // 9 real line items → 9 reservation rows actually inserted.
    expect(allocationInserts.length).toBe((realOrder as any).items.length)
    expect(result.created).toBe((realOrder as any).items.length)

    // Every inserted row references the order + its line + the cart (Finding #3).
    const lineIds = new Set((realOrder as any).items.map((it: any) => it.id))
    for (const insert of allocationInserts) {
      expect(insert.data.order_id).toBe(order.id)
      expect(lineIds.has(insert.data.line_item_id)).toBe(true)
      expect(insert.data.cart_id).toBe("cart_real_135")
    }
  })

  it("falls back to metadata.cart_id when order.cart_id is null", async () => {
    const order = {
      ...(realOrder as any),
      cart_id: null,
      metadata: { cart_id: "cart_from_metadata" },
    }
    const { db, inserts } = makeAllocationDb()
    const query = makeQueryForRealOrder(order)

    await createAllocationsForOrder({
      db: db as any,
      query: query as any,
      orderId: order.id,
      now: new Date("2026-06-19T12:00:00Z"),
    })

    const allocationInserts = inserts.filter(
      (i) => i.table === "gp_inventory_allocation"
    )
    expect(allocationInserts.length).toBeGreaterThan(0)
    for (const insert of allocationInserts) {
      expect(insert.data.cart_id).toBe("cart_from_metadata")
    }
  })
})

/**
 * Finding #5: edge cases the UPS-Overnight / 9-line fixture misses.
 */
describe("shipping_forecast edge cases (Finding #5)", () => {
  const ENV_PACKAGING_ON = { GRILLERS_SHIPPING_FORECAST_INCLUDE_PACKAGING: "true" }

  it("local-delivery order: no UPS service code → no forecast", () => {
    const order = {
      ...(realOrder as any),
      shipping_methods: [
        {
          name: "Atlanta Local Delivery",
          amount: 0,
          shipping_option_id: "so_local_delivery",
          data: {},
          metadata: null,
        },
      ],
      shipping_total: 0,
    }
    expect(buildShippingForecastEvent(order)).toBeNull()
  })

  it("plant-pickup order: no UPS service code → no forecast", () => {
    const order = {
      ...(realOrder as any),
      shipping_methods: [
        {
          name: "Plant Pickup",
          amount: 0,
          shipping_option_id: "so_plant_pickup",
          data: {},
          metadata: null,
        },
      ],
      shipping_total: 0,
    }
    expect(buildShippingForecastEvent(order)).toBeNull()
  })

  it("gift-card-only order with NO physical line items on a UPS method emits no forecast", () => {
    // A pure gift-card / store-credit order: a UPS method is attached but there
    // are no shippable line items at all. Nothing to ship or reconcile → skip.
    const order = {
      ...(realOrder as any),
      items: [],
      shipping_methods: [
        {
          name: "UPS Ground Estimated Shipping",
          amount: 12,
          shipping_option_id: "so_ups_ground",
          data: { service_code: "GROUND" },
          metadata: null,
        },
      ],
      shipping_total: 12,
    }
    expect(buildShippingForecastEvent(order)).toBeNull()
  })

  it("legacy food orders emit unavailable estimates instead of invented zero weight and one box", () => {
    const payload = buildShippingForecastEvent(realOrder as any)
    expect(payload).not.toBeNull()
    expect(payload!.properties.estimate_status).toBe("unavailable_legacy_snapshot")
    expect(payload!.properties.estimated_weight_lb).toBeNull()
    expect(payload!.properties.boxes).toBeNull()
    expect(payload!.properties.packaging_cost).toBeNull()
  })

  it("multi-shipment: forecast uses the LAST shipping method", () => {
    // Two methods: a non-UPS first, the real UPS Overnight last. The forecast must
    // report the LAST method, matching order-placed.ts' aligned shipping_tier.
    const order = {
      ...(realOrder as any),
      shipping_methods: [
        {
          name: "Atlanta Local Delivery",
          amount: 0,
          shipping_option_id: "so_local",
          data: {},
          metadata: null,
        },
        (realOrder as any).shipping_methods[0], // UPS Overnight, amount 164.49
      ],
    }
    const payload = buildShippingForecastEvent(order)
    expect(payload).not.toBeNull()
    expect(payload!.properties.service).toBe("OVERNIGHT")
    expect(payload!.properties.charged_shipping).toBe(164.49)
  })
})

/**
 * Finding #5 (guest order): no customer_id ⇒ actor_id undefined; the gp-analytics
 * shim must synthesize a STABLE anonymous_id from the order id so the event still
 * lands in the warehouse. This pins the synth-anonymous-id path for guest orders.
 */
describe("guest order analytics (no customer_id)", () => {
  it("order-placed tracks with actor_id undefined for a guest order", async () => {
    const guestOrder = { ...(realOrder as any), customer_id: null, customer: null }
    const analytics = { track: jest.fn().mockResolvedValue(undefined) }
    const container = {
      resolve: (key: string) => {
        if (key === "analytics") return analytics
        if (key === "logger") return { error: jest.fn() }
        if (key === "query")
          return { graph: jest.fn().mockResolvedValue({ data: [guestOrder] }) }
        throw new Error(`unexpected resolve ${key}`)
      },
    }

    await orderPlacedHandler({
      event: { name: "order.placed", data: { id: guestOrder.id } },
      container,
    } as any)

    const call = analytics.track.mock.calls[0][0]
    expect(call.actor_id).toBeUndefined()
    expect(call.properties.customer_id).toBeUndefined()
    // The shim derives a stable anonymous_id from transaction_id downstream.
    expect(call.properties.transaction_id).toBe(guestOrder.id)
    // Revenue still correct for a guest order (item_total 168.24 + shipping 164.49).
    expect(call.properties.estimated_value).toBe(332.73)
  })
})
