import {
  checkInventoryAvailability,
  createAllocationsForOrder,
  releaseAllocationsForOrder,
} from "../inventory-allocation"

const originalNativeFlag = process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED
beforeEach(() => { process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED = "true" })
afterAll(() => {
  if (originalNativeFlag === undefined) delete process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED
  else process.env.GP_NATIVE_INVENTORY_CHECKOUT_ENABLED = originalNativeFlag
})

function chainForRows(rows: any[], onUpdate?: jest.Mock) {
  const chain: any = {
    select: jest.fn(() => chain),
    whereNull: jest.fn(() => chain),
    where: jest.fn(() => chain),
    whereIn: jest.fn(() => chain),
    forUpdate: jest.fn(() => chain),
    first: jest.fn(async () => rows[0]),
    limit: jest.fn(() => chain),
    orderBy: jest.fn(() => chain),
    offset: jest.fn(() => chain),
    update: jest.fn(async (payload) => {
      onUpdate?.(payload)
      return 1
    }),
    then: (resolve: any) => resolve(rows),
  }
  return chain
}

function makeDb({
  allocationRows = [],
  activeLineRows = [],
}: {
  allocationRows?: any[]
  activeLineRows?: any[]
} = {}) {
  const inserts: Array<{ table: string; data: any }> = []
  const updates: Array<{ table: string; data: any }> = []

  const db: any = jest.fn((table: string) => {
    if (table === "order") return chainForRows([{ id: "order_1", status: "pending" }])
    if (table === "gp_inventory_allocation") {
      const rows = activeLineRows.length ? activeLineRows : allocationRows
      const chain = chainForRows(rows, jest.fn((data) => updates.push({ table, data })))
      chain.insert = jest.fn(async (data: any) => {
        inserts.push({ table, data })
        return data
      })
      return chain
    }

    const chain = chainForRows([])
    chain.insert = jest.fn(async (data: any) => {
      inserts.push({ table, data })
      return data
    })
    chain.update = jest.fn(async (data: any) => {
      updates.push({ table, data })
      return 1
    })
    return chain
  })

  db.transaction = async (work: any) => work(db)
  return { db, inserts, updates }
}

function stock(available: number) {
  return { allow_backorder: false, inventory_items: [{ inventory_item_id: "item_1", required_quantity: 1,
    inventory: { id: "item_1", location_levels: [{ location_id: "location_1", stocked_quantity: available, reserved_quantity: 0 }] } }] }
}

function makeQuery(variants: any[], order?: any) {
  return {
    graph: jest.fn(async ({ entity, filters }: any) => {
      if (entity === "product_variant") return { data: variants }
      if (entity === "product_variant_inventory_items") return { data: variants.flatMap(variant =>
        (variant.inventory_items || []).filter((item: any) => filters.inventory_item_id.includes(item.inventory_item_id))
          .map((item: any) => ({ variant_id: variant.id, inventory_item_id: item.inventory_item_id }))) }
      if (entity === "order") return { data: order ? [order] : [] }
      return { data: [] }
    }),
  }
}

describe("inventory allocation availability", () => {
  it("blocks seasonal inactive items before considering stock", async () => {
    const { db } = makeDb()
    const query = makeQuery([
      {
        id: "variant_1",
        ...stock(10),
        manage_inventory: true,
        metadata: { availability_lifecycle: "seasonal_inactive" },
      },
    ])

    const [result] = await checkInventoryAvailability({
      db,
      query,
      lines: [{ variant_id: "variant_1", quantity: 1 }],
      requested_fulfillment_date: "2026-05-26",
    })

    expect(result).toMatchObject({
      decision: "inactive",
      reason: "lifecycle_seasonal_inactive",
      available_to_promise_quantity: 10,
    })
  })

  it("preserves the existing future-dated ordering window", async () => {
    const { db } = makeDb()
    const query = makeQuery([
      {
        id: "variant_1",
        ...stock(0),
        manage_inventory: true,
        metadata: { future_order_eligible: true, replenishment_lead_days: 14 },
      },
    ])

    const [result] = await checkInventoryAvailability({
      db,
      query,
      lines: [{ variant_id: "variant_1", quantity: 99 }],
      requested_fulfillment_date: "2026-06-15",
      now: new Date("2026-05-25T12:00:00Z"),
    })

    expect(result).toMatchObject({
      decision: "future_allowed",
      reason: "future_window",
      current_stock_quantity: 0,
    })
  })

  it("blocks unmatched advisory commitments pending native reconciliation", async () => {
    const { db } = makeDb({
      allocationRows: [
        {
          id: "ialloc_1",
          variant_id: "variant_1",
          quantity: 3,
          status: "reserved",
        },
      ],
    })
    const query = makeQuery([
      {
        id: "variant_1",
        ...stock(5),
        manage_inventory: true,
        metadata: { safety_stock_quantity: 1 },
      },
    ])

    const [result] = await checkInventoryAvailability({
      db,
      query,
      lines: [{ variant_id: "variant_1", quantity: 2 }],
      requested_fulfillment_date: "2026-05-26",
      now: new Date("2026-05-25T12:00:00Z"),
    })

    expect(result).toMatchObject({
      decision: "blocked",
      reason: "inventory_reconciliation_required",
      allocated_quantity: 3,
      safety_stock_quantity: 1,
      available_to_promise_quantity: 1,
    })
  })

  it("creates order allocations with QBD ListID snapshots", async () => {
    const { db, inserts } = makeDb()
    const query = makeQuery(
      [
        {
          id: "variant_1",
          sku: "1-00-12-1",
          ...stock(5),
          manage_inventory: true,
          metadata: { qbd_list_id: "8000-ABC" },
          product: { id: "prod_1", title: "Ground Beef", metadata: {} },
        },
      ],
      {
        id: "order_1",
        email: "test@example.com",
        customer_id: "cus_1",
        metadata: { scheduledDate: "2026-05-26" },
        items: [
          {
            id: "line_1",
            title: "QB long title",
            quantity: 1,
            metadata: { strapi_title: "Ground Beef" },
            variant: {
              id: "variant_1",
              sku: "1-00-12-1",
              metadata: { qbd_list_id: "8000-ABC" },
              product: { id: "prod_1", title: "Ground Beef", metadata: {} },
            },
          },
        ],
      }
    )

    const result = await createAllocationsForOrder({
      db,
      query,
      orderId: "order_1",
      now: new Date("2026-05-25T12:00:00Z"),
    })

    expect(result).toMatchObject({ created: 1, skipped: 0, blocked: 0 })
    const allocationInsert = inserts.find(
      (insert) => insert.table === "gp_inventory_allocation"
    )?.data
    expect(allocationInsert).toMatchObject({
      order_id: "order_1",
      line_item_id: "line_1",
      variant_id: "variant_1",
      product_id: "prod_1",
      qbd_list_id: "8000-ABC",
      customer_title: "Ground Beef",
      status: "reserved",
    })
  })

  it("releases active allocations on cancellation", async () => {
    const { db, updates } = makeDb({
      allocationRows: [
        {
          id: "ialloc_1",
          order_id: "order_1",
          quantity: 1,
          status: "reserved",
        },
      ],
    })

    const released = await releaseAllocationsForOrder({
      db,
      orderId: "order_1",
      reason: "released_cancellation",
    })

    expect(released).toBe(1)
    expect(updates[0]).toMatchObject({
      table: "gp_inventory_allocation",
      data: {
        status: "released",
        allocation_reason: "released_cancellation",
      },
    })
  })
})
