import { Modules } from "@medusajs/framework/utils"
import {
  dropUnserviceableShippingMethods,
  extractAddressFromBody,
  resolveCartIdFromRequest,
} from "../middlewares"

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

function makeScope({
  cart,
  deleteShippingMethods,
}: {
  cart: any
  deleteShippingMethods: jest.Mock
}) {
  const query = {
    graph: jest.fn().mockResolvedValue({ data: cart ? [cart] : [] }),
  }
  const cartModule = { deleteShippingMethods }
  return {
    scope: {
      resolve: (key: string) => {
        if (key === "logger") return logger
        if (key === "query") return query
        if (key === Modules.LOCKING)
          return { execute: async (_key: string, run: any) => run() }
        if (key === Modules.CART) return cartModule
        throw new Error(`unexpected resolve(${key})`)
      },
    },
    query,
    cartModule,
  }
}

describe("resolveCartIdFromRequest", () => {
  it("prefers params.id", () => {
    expect(resolveCartIdFromRequest({ params: { id: "cart_1" } })).toBe(
      "cart_1"
    )
  })
  it("falls back to params.cart_id", () => {
    expect(resolveCartIdFromRequest({ params: { cart_id: "cart_2" } })).toBe(
      "cart_2"
    )
  })
  it("parses the cart id from the path when no param is present", () => {
    expect(
      resolveCartIdFromRequest({ path: "/store/carts/cart_3/line-items" })
    ).toBe("cart_3")
  })
  it("returns null when nothing resolves", () => {
    expect(resolveCartIdFromRequest({ path: "/store/other" })).toBeNull()
  })
})

describe("extractAddressFromBody", () => {
  it("reads a nested shipping_address with a postal_code", () => {
    expect(
      extractAddressFromBody({
        shipping_address: {
          postal_code: "38120",
          city: "Memphis",
          province: "TN",
        },
      })
    ).toEqual({ postal_code: "38120", city: "Memphis", province: "TN" })
  })
  it("reads a flat address-update body", () => {
    expect(
      extractAddressFromBody({
        postal_code: "38120",
        city: "Memphis",
        province: "TN",
      })
    ).toEqual({ postal_code: "38120", city: "Memphis", province: "TN" })
  })
  it("returns null when there is no postal_code (falls back to cart address)", () => {
    expect(extractAddressFromBody({ items: [] })).toBeNull()
    expect(extractAddressFromBody(null)).toBeNull()
    expect(
      extractAddressFromBody({ shipping_address: { city: "Memphis" } })
    ).toBeNull()
  })
})

describe("dropUnserviceableShippingMethods (synchronous front-line heal)", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    process.env.STRAPI_URL = "https://strapi.example.test"
    process.env.STRAPI_TOKEN = "strapi-token"
  })

  it("removes a stale ATLANTA_DELIVERY method using the NEW body address (change-address case)", async () => {
    // Strapi returns no active zone for the NEW out-of-area ZIP => not serviceable.
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as any)

    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { scope, cartModule } = makeScope({
      cart: {
        id: "cart_1",
        // CURRENT (in-area) address — would have passed; the body must override it.
        shipping_address: {
          postal_code: "30340",
          city: "Doraville",
          province: "GA",
        },
        shipping_methods: [
          {
            id: "sm_atl",
            name: "Metro Atlanta Delivery",
            data: { service_code: "ATLANTA_DELIVERY" },
          },
        ],
      },
      deleteShippingMethods,
    })

    const removed = await dropUnserviceableShippingMethods({
      scope,
      params: { id: "cart_1" },
      body: {
        shipping_address: {
          postal_code: "38120",
          city: "Memphis",
          province: "TN",
        },
      },
    })

    expect(removed).toEqual(["sm_atl"])
    expect(cartModule.deleteShippingMethods).toHaveBeenCalledWith(["sm_atl"])
  })

  it("removes a stale method using the CURRENT cart address when the body has none (add-line-item case)", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as any)

    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { scope, cartModule } = makeScope({
      cart: {
        id: "cart_1",
        shipping_address: {
          postal_code: "38120",
          city: "Memphis",
          province: "TN",
        },
        shipping_methods: [
          {
            id: "sm_atl",
            name: "Metro Atlanta Delivery",
            data: { service_code: "ATLANTA_DELIVERY" },
          },
        ],
      },
      deleteShippingMethods,
    })

    const removed = await dropUnserviceableShippingMethods({
      scope,
      params: { id: "cart_1" },
      body: { items: [{ variant_id: "v1", quantity: 1 }] },
    })

    expect(removed).toEqual(["sm_atl"])
    expect(cartModule.deleteShippingMethods).toHaveBeenCalledWith(["sm_atl"])
  })

  it("keeps an in-area ATLANTA_DELIVERY method and removes nothing", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 1, ZipCode: "30340", IsActive: true }],
      }),
    } as any)

    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { scope, cartModule } = makeScope({
      cart: {
        id: "cart_1",
        shipping_address: {
          postal_code: "30340",
          city: "Doraville",
          province: "GA",
        },
        shipping_methods: [
          {
            id: "sm_atl",
            name: "Metro Atlanta Delivery",
            data: { service_code: "ATLANTA_DELIVERY" },
          },
        ],
      },
      deleteShippingMethods,
    })

    const removed = await dropUnserviceableShippingMethods({
      scope,
      params: { id: "cart_1" },
      body: {},
    })

    expect(removed).toEqual([])
    expect(cartModule.deleteShippingMethods).not.toHaveBeenCalled()
  })

  it("never touches a non-restricted method (GROUND) and never calls Strapi", async () => {
    global.fetch = jest.fn()
    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { scope, cartModule } = makeScope({
      cart: {
        id: "cart_1",
        shipping_address: {
          postal_code: "38120",
          city: "Memphis",
          province: "TN",
        },
        shipping_methods: [
          {
            id: "sm_ground",
            name: "UPS Ground Estimated Shipping",
            data: { service_code: "GROUND" },
          },
        ],
      },
      deleteShippingMethods,
    })

    const removed = await dropUnserviceableShippingMethods({
      scope,
      params: { id: "cart_1" },
      body: {},
    })

    expect(removed).toEqual([])
    expect(cartModule.deleteShippingMethods).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("no-ops (returns []) when no cart id can be resolved", async () => {
    const deleteShippingMethods = jest.fn()
    const { scope } = makeScope({ cart: null, deleteShippingMethods })
    const removed = await dropUnserviceableShippingMethods({
      scope,
      params: {},
      path: "/store/other",
      body: {},
    })
    expect(removed).toEqual([])
    expect(deleteShippingMethods).not.toHaveBeenCalled()
  })

  it("fails open (returns []) and does not throw when the cart module delete errors", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as any)
    const deleteShippingMethods = jest
      .fn()
      .mockRejectedValue(new Error("db down"))
    const { scope } = makeScope({
      cart: {
        id: "cart_1",
        shipping_address: {
          postal_code: "38120",
          city: "Memphis",
          province: "TN",
        },
        shipping_methods: [
          {
            id: "sm_atl",
            name: "Metro Atlanta Delivery",
            data: { service_code: "ATLANTA_DELIVERY" },
          },
        ],
      },
      deleteShippingMethods,
    })

    await expect(
      dropUnserviceableShippingMethods({
        scope,
        params: { id: "cart_1" },
        body: {},
      })
    ).resolves.toEqual([])
    expect(logger.warn).toHaveBeenCalled()
  })

  it("fails open when query.graph throws (heal must never block the mutation)", async () => {
    const deleteShippingMethods = jest.fn()
    const scope = {
      resolve: (key: string) => {
        if (key === "logger") return logger
        if (key === "query") {
          return {
            graph: jest.fn().mockRejectedValue(new Error("query boom")),
          }
        }
        if (key === Modules.CART) return { deleteShippingMethods }
        throw new Error(`unexpected resolve(${key})`)
      },
    }

    await expect(
      dropUnserviceableShippingMethods({
        scope,
        params: { id: "cart_1" },
        body: {},
      })
    ).resolves.toEqual([])
    expect(deleteShippingMethods).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })
})
