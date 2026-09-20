import { Modules } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../../../lib/ops-alert"
import cartShippingRevalidateHandler from "../../../subscribers/cart-shipping-revalidate"

jest.mock("../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}

function makeContainer({
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
    container: {
      resolve: (key: string) => {
        if (key === "logger") return logger
        if (key === "query") return query
        if (key === Modules.LOCKING)
          return { execute: async (_key: string, job: any) => job() }
        if (key === Modules.CART) return cartModule
        throw new Error(`unexpected resolve(${key})`)
      },
    },
    query,
    cartModule,
  }
}

async function run(container: any, id = "cart_1") {
  await cartShippingRevalidateHandler({
    event: { data: { id } },
    container,
  } as any)
}

describe("cart-shipping-revalidate subscriber", () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    process.env.STRAPI_URL = "https://strapi.example.test"
    process.env.STRAPI_TOKEN = "strapi-token"
  })

  it("removes an ATLANTA_DELIVERY method when the ship-to ZIP is out of area", async () => {
    // Strapi returns no active zone for the ZIP => not serviceable.
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as any)

    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { container, cartModule } = makeContainer({
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

    await run(container)

    expect(cartModule.deleteShippingMethods).toHaveBeenCalledTimes(1)
    expect(cartModule.deleteShippingMethods).toHaveBeenCalledWith(["sm_atl"])
  })

  it("keeps a valid ATLANTA_DELIVERY method when the ZIP is in area", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 1, ZipCode: "30340", IsActive: true }],
      }),
    } as any)

    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { container, cartModule } = makeContainer({
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

    await run(container)

    expect(cartModule.deleteShippingMethods).not.toHaveBeenCalled()
  })

  it("never touches a non-restricted method (GROUND) and never calls Strapi", async () => {
    global.fetch = jest.fn()
    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { container, cartModule } = makeContainer({
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

    await run(container)

    expect(cartModule.deleteShippingMethods).not.toHaveBeenCalled()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("no-ops on the follow-up cart.updated after a removal (loop terminates)", async () => {
    // After the bad method is deleted, the cart has only a valid GROUND method.
    global.fetch = jest.fn()
    const deleteShippingMethods = jest.fn().mockResolvedValue(undefined)
    const { container, cartModule } = makeContainer({
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

    await run(container)

    expect(cartModule.deleteShippingMethods).not.toHaveBeenCalled()
  })

  it("does not throw when the cart module delete fails (cart stays usable)", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as any)
    const deleteShippingMethods = jest
      .fn()
      .mockRejectedValue(new Error("db down"))
    const { container } = makeContainer({
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

    await expect(run(container)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "cart_shipping_revalidate_failed",
        severity: "warn",
        path: "src/subscribers/cart-shipping-revalidate.ts",
        meta: expect.objectContaining({
          cart_id: "cart_1",
          error_message: "db down",
        }),
      })
    )
  })

  it("alerts when the cart lookup fails while still failing open", async () => {
    const query = {
      graph: jest.fn().mockRejectedValue(new Error("query unavailable")),
    }
    const container = {
      resolve: (key: string) => {
        if (key === "logger") return logger
        if (key === "query") return query
        if (key === Modules.LOCKING)
          return { execute: async (_key: string, job: any) => job() }
        if (key === Modules.CART) {
          return { deleteShippingMethods: jest.fn() }
        }
        throw new Error(`unexpected resolve(${key})`)
      },
    }

    await expect(run(container, "cart_2")).resolves.toBeUndefined()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "cart_shipping_revalidate_failed",
        meta: expect.objectContaining({
          cart_id: "cart_2",
          error_message: "query unavailable",
        }),
      })
    )
  })
})
