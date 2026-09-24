import {
  acceptShippingPrice,
  composeShippingPrice,
  sealAcceptedShippingPrice,
  SHIPPING_PRICE_ACCEPTED_KEY,
} from "../shipping-price-contract"
import {
  createShippingPackingPlan,
  SHIPPING_PACKING_PLAN_KEY,
} from "../shipping-packing-plan"
import {
  packingConfig,
  packingContext,
  shippingLine,
  pricePolicy,
} from "./__fixtures__/shipping-inputs"
import { emitOpsAlert } from "../ops-alert"
import {
  bookWwexFinalizationShipment,
  quoteWwexFinalizationShipping,
} from "../wwex-finalization-shipment"
import { createWwexSpeedshipClientFromEnv } from "../../modules/fulfillment/wwex-speedship"

jest.mock("../ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

jest.mock("../../modules/fulfillment/wwex-speedship", () => {
  const actual = jest.requireActual("../../modules/fulfillment/wwex-speedship")
  return {
    ...actual,
    createWwexSpeedshipClientFromEnv: jest.fn(),
  }
})

const mockCreateWwexClient =
  createWwexSpeedshipClientFromEnv as jest.MockedFunction<
    typeof createWwexSpeedshipClientFromEnv
  >

const baseOrder = {
  id: "order_123",
  cart_id: "cart_test",
  currency_code: "usd",
  shipping_total: 32,
  display_id: 1001,
  shipping_address: { city: "Atlanta" },
  shipping_methods: [
    {
      data: { service_code: "GROUND" },
    },
  ],
  metadata: {},
}

const basePreview = {
  package_capture_required: true,
  finalization: {
    estimated_order_total: 100,
  },
  lines: [],
  packages: [{ id: "pkg_123", packed_weight_lb: 5 }],
  totals: {
    final_item_total: 80,
    final_shipping_total: 32,
    final_tax_total: 5,
    final_discount_total: 0,
  },
}

const baseOffer = {
  offerId: "offer_123",
  productTransactionId: "ptx_123",
  upsServiceCode: "GROUND",
  price: { value: 12.34, currency: "USD" },
}

describe("WWEX finalization shipment ops alerts", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      GP_SHIPPING_PRICE_ACTIVE_KEY_ID: "fixture",
      GP_SHIPPING_PRICE_KEYS_JSON: JSON.stringify({
        fixture: "synthetic-shipping-price-test-secret-32-characters",
      }),
    }
    const plan = createShippingPackingPlan(
      [shippingLine()],
      packingContext(),
      packingConfig()
    )
    const quote = composeShippingPrice({
      source: "wwex",
      rate: 20,
      currency: "usd",
      plan,
      policy: pricePolicy(),
    })
    const accepted = acceptShippingPrice(
      {
        id: "cart_test",
        shipping_total: 32,
        shipping_discount_total: 0,
        shipping_tax_total: 0,
        item_subtotal: 80,
        tax_total: 5,
        total: 117,
        promotions: [],
      },
      { amount: 32 },
      quote
    )
    baseOrder.metadata = {
      [SHIPPING_PACKING_PLAN_KEY]: plan,
      [SHIPPING_PRICE_ACCEPTED_KEY]: sealAcceptedShippingPrice(accepted),
    }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("alerts when the final packed-box quote fails", async () => {
    const logger = { warn: jest.fn(), error: jest.fn() }
    mockCreateWwexClient.mockReturnValue({
      quoteSmallpack: jest
        .fn()
        .mockRejectedValue(new Error("rating rejected ops@example.com")),
    } as any)

    const result = await quoteWwexFinalizationShipping({
      order: baseOrder,
      preview: basePreview,
      logger,
    })

    expect(result?.status).toBe("blocked")
    expect(result?.totals).toEqual({})
    expect(result?.metadata.wwex_quote_status).toBe("failed")
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "wwex_finalization_quote_failed",
        severity: "warn",
        title: "WWEX finalization quote failed for order order_123",
        path: "src/lib/wwex-finalization-shipment.ts",
        source: "medusa-server",
        logger,
        meta: expect.objectContaining({
          order_id: "order_123",
          display_id: 1001,
          service_code: "GROUND",
          package_count: 1,
          error: "rating rejected [redacted-email]",
        }),
      })
    )
  })

  it("keeps accepted customer shipping when measured carrier freight increases", async () => {
    mockCreateWwexClient.mockReturnValue({
      quoteSmallpack: jest.fn(async () => ({
        offer: { ...baseOffer, price: { value: 90, currency: "USD" } },
      })),
    } as any)
    const result = await quoteWwexFinalizationShipping({
      order: baseOrder,
      preview: basePreview,
    })
    expect(result?.status).toBe("quoted")
    expect(result?.totals).toEqual(basePreview.totals)
    expect(result?.metadata.shipping_final_cost_v1).toMatchObject({
      carrier_freight: 90,
      customer_shipping: 32,
      actual_box_cost: null,
    })
  })
  it("blocks missing accepted prices and an unconfigured carrier rather than fabricating a normal total", async () => {
    mockCreateWwexClient.mockReturnValue(null)
    for (const order of [baseOrder, { ...baseOrder, metadata: {} }]) {
      const result = await quoteWwexFinalizationShipping({
        order,
        preview: basePreview,
      })
      expect(result?.status).toBe("blocked")
      expect(result?.totals).toEqual({})
    }
  })

  it("alerts when shipment booking fails", async () => {
    process.env.WWEX_BOOK_SHIPMENTS_ON_RELEASE = "true"
    const logger = { warn: jest.fn(), error: jest.fn() }
    mockCreateWwexClient.mockReturnValue({
      bookSmallpack: jest
        .fn()
        .mockRejectedValue(new Error("booking rejected ops@example.com")),
    } as any)

    const result = await bookWwexFinalizationShipment({
      order: baseOrder,
      quote: {
        status: "quoted",
        quote: { offer: baseOffer } as any,
        offer: baseOffer as any,
        totals: {},
        metadata: {},
      },
      logger,
    })

    expect(result.status).toBe("failed")
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "wwex_finalization_booking_failed",
        title: "WWEX shipment booking failed for order order_123",
        meta: expect.objectContaining({
          order_id: "order_123",
          offer_id: "offer_123",
          product_transaction_id: "ptx_123",
          error: "booking rejected [redacted-email]",
        }),
      })
    )
  })

  it("alerts when label download fails after booking", async () => {
    process.env.WWEX_BOOK_SHIPMENTS_ON_RELEASE = "true"
    process.env.WWEX_FETCH_LABEL_ON_RELEASE = "true"
    const logger = { warn: jest.fn(), error: jest.fn() }
    mockCreateWwexClient.mockReturnValue({
      bookSmallpack: jest.fn().mockResolvedValue({
        productTransactionId: "ptx_booked",
        trackingNumber: "1Z999",
      }),
      downloadSmallpackLabel: jest
        .fn()
        .mockRejectedValue(new Error("label rejected ops@example.com")),
    } as any)

    const result = await bookWwexFinalizationShipment({
      order: baseOrder,
      quote: {
        status: "quoted",
        quote: { offer: baseOffer } as any,
        offer: baseOffer as any,
        totals: {},
        metadata: {},
      },
      logger,
    })

    expect(result.status).toBe("booked")
    if (result.status !== "booked") {
      throw new Error("Expected WWEX booking to succeed")
    }
    expect(result.label_status).toBe("failed")
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "wwex_finalization_label_failed",
        title: "WWEX label download failed for order order_123",
        meta: expect.objectContaining({
          order_id: "order_123",
          offer_id: "offer_123",
          product_transaction_id: "ptx_booked",
          tracking_number: "1Z999",
          error: "label rejected [redacted-email]",
        }),
      })
    )
  })
})
