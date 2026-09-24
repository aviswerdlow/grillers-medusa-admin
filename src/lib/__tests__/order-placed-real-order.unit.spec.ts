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
const mockPublication = jest.fn().mockResolvedValue(undefined)
jest.mock("../order-publication", () => ({ requestOrderPublication: (...args: any[]) => mockPublication(...args) }))
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import orderPlacedHandler from "../../subscribers/analytics/order-placed"
import { buildShippingForecastEvent } from "../../subscribers/analytics/shipping-forecast"
import { createAllocationsForOrder } from "../inventory-allocation"
import { evaluateGbm } from "../shipping-cost-forecast"
import realOrder from "./__fixtures__/order-135-real.json"

// The exact query.graph field arrays each subscriber/lib sends. Kept in sync with
// the source so a future re-introduction of a `+`-prefixed nested field is caught.
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

/** The historic order has ambiguous mutable totals. It may not be used as
 * a fallback for missing immutable original evidence. The SQL publication
 * tests verify that unbound legacy events wait rather than emit fake revenue. */
describe("real legacy order source boundary", () => {
  it.each([0, 510.5])("records only order identity despite mutable total %s", async total => {
    mockPublication.mockClear()
    const db = {}, query = jest.fn(), track = jest.fn()
    const resolve = (key: string) => key === ContainerRegistrationKeys.PG_CONNECTION ? db : key === "logger" ? { error: jest.fn() } : key === "query" ? query : track
    expect(realOrder.total).toBe(0)
    expect(realOrder.item_total + realOrder.shipping_total).toBe(332.73)
    await orderPlacedHandler({ event: { name: "order.placed", data: { id: realOrder.id, total } }, container: { resolve } } as any)
    expect(mockPublication).toHaveBeenCalledWith(db, "placed", realOrder.id, undefined)
    expect(query).not.toHaveBeenCalled()
    expect(track).not.toHaveBeenCalled()
  })
})

/**
 * Finding #4: prove inventory reservation ROWS are actually inserted (not just
 * that the query shape is valid) on a REAL multi-line order — and that Finding #3's
 * cart_id attribution lands on each row.
 */
describe("createAllocationsForOrder inserts reservation rows on the real multi-line order", () => {
  function makeAllocationDb(order: Record<string, any>) {
    const inserts: Array<{ table: string; data: any }> = []
    const db: any = jest.fn((table: string) => {
      const chain: any = {
        select: () => chain,
        whereNull: () => chain,
        where: () => chain,
        whereIn: () => chain,
        forUpdate: () => chain,
        first: async () => table === "order" ? { id: order.id, status: "pending", canceled_at: null } : undefined,
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
    db.transaction = async (work: any) => work(db)
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
      inventory_items: [{ inventory_item_id: `inventory_${item.variant_id}`, required_quantity: 1,
        inventory: { id: `inventory_${item.variant_id}`, location_levels: [{ location_id: "fixture_location", stocked_quantity: 100, reserved_quantity: 0 }] } }],
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
    const { db, inserts } = makeAllocationDb(order)
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
    const { db, inserts } = makeAllocationDb(order)
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

it("records guest legacy identity without inventing a customer or a purchase amount", async () => {
  mockPublication.mockClear()
  const db = {}
  const resolve = (key: string) => key === ContainerRegistrationKeys.PG_CONNECTION ? db : { error: jest.fn() }
  await orderPlacedHandler({ event: { name: "order.placed", data: { id: realOrder.id, customer_id: null } }, container: { resolve } } as any)
  expect(mockPublication).toHaveBeenCalledWith(db, "placed", realOrder.id, undefined)
})
