import { acceptCheckoutReview } from "../../../../../../lib/order-review-checkout"
import { OrderPromiseError } from "../../../../../../lib/order-promise"
import {
  completeCartWorkflow,
  createPaymentSessionsWorkflow,
} from "@medusajs/core-flows"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../../../../../../lib/ops-alert"
import { checkInventoryAvailability } from "../../../../../../lib/inventory-allocation"
import { getPaymentContextCustomer } from "../../../../payment-methods/utils"
import { ShippingInputError } from "../../../../../../lib/shipping-weights"
import {
  ORDER_SMS_CONSENT_DISCLOSURE,
  ORDER_SMS_CONSENT_METHOD,
  ORDER_SMS_CONSENT_PROVIDER,
  ORDER_SMS_CONSENT_PURPOSE,
  ORDER_SMS_CONSENT_SOURCE,
  ORDER_SMS_CONSENT_VERSION,
  ORDER_SMS_PROGRAM,
} from "../../../../../../lib/communications/transactional-sms"

jest.mock("@medusajs/core-flows", () => ({
  completeCartWorkflow: jest.fn(() => ({ run: jest.fn() })),
  createPaymentCollectionForCartWorkflow: jest.fn(() => ({ run: jest.fn() })),
  createPaymentSessionsWorkflow: jest.fn(() => ({ run: jest.fn() })),
}))

jest.mock("../../../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

jest.mock("../../../../../../lib/inventory-allocation", () => ({
  checkInventoryAvailability: jest.fn(),
  qbdListIdFromMetadata: jest.fn(() => "80000001-123"),
  requestedFulfillmentDateFromMetadata: jest.fn((metadata) => {
    if (!metadata || typeof metadata !== "object") return undefined
    return (metadata as Record<string, unknown>).scheduledDate as
      | string
      | undefined
  }),
}))

// Mock only getPaymentContextCustomer so we can drive the outer catch; keep
// jsonError real so the 400 input guards still behave normally.
jest.mock("../../../../payment-methods/utils", () => {
  const actual = jest.requireActual("../../../../payment-methods/utils")
  return {
    ...actual,
    getPaymentContextCustomer: jest.fn(),
    assertPaymentMethodBelongsToCustomer: jest.fn(async () => true),
    getStripeAccountHolder: jest.fn(() => ({ id: "acct_holder_123" })),
    getStripeCustomerId: jest.fn(() => "cus_123"),
  }
})

// The review adapter has its own authority/hash tests; these cases retain
// their original ATP and alerting focus after the required review handoff.
jest.mock("../../../../../../lib/order-review-checkout", () => ({
  ...jest.requireActual("../../../../../../lib/order-review-checkout"),
  assertReviewOwner: jest.fn(async () => ({
    staff: false,
    customerId: "cus_medusa_123",
  })),
  readReviewAcceptance: jest.fn(() => ({
    reviewId: "gpor_fixture",
    requestId: "d98224fb-c599-4a63-92ba-22189c505126",
    analyticsConsent: null,
  })),
  reviewCart: jest.fn(async () => ({
    id: "cart_test_123",
    customer_id: "cus_medusa_123",
  })),
  acceptCheckoutReview: jest.fn(async () => ({
    completed: false,
    snapshot: {
      promise: {
        terms: {
          payment_consent_version: "v1",
          payment_consent_text: "I consent",
        },
      },
    },
  })),
}))

// Import POST AFTER mocks are registered.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { POST, sanitizeCheckoutOrderSmsConsent } = require("../route")

function makeReqRes() {
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
  const cartModule = {
    retrieveCart: jest.fn(async () => ({
      id: "cart_test_123",
      email: "avi@example.com",
      customer_id: "cus_medusa_123",
      metadata: {},
    })),
    updateCarts: jest.fn(),
  }
  const orderModule = { updateOrders: jest.fn() }
  const query = {
    graph: jest.fn(async () => ({
      data: [
        {
          id: "cart_test_123",
          customer_id: "cus_medusa_123",
          metadata: {
            scheduledDate: "2026-07-02",
            fulfillmentType: "ups_ground",
          },
          items: [
            {
              id: "cali_123",
              title: "Ground Beef 85/15 - 1 lb Pack",
              product_id: "prod_123",
              variant_id: "variant_123",
              variant_sku: "1-00-12-1",
              quantity: 3,
              metadata: { customer_title: "Ground Beef 85/15 - 1 lb Pack" },
            },
          ],
        },
      ],
    })),
  }
  const req = {
    body: {
      cart_id: "cart_test_123",
      payment_method_id: "pm_test_123",
      consent_version: "v1",
      consent_text: "I consent",
    },
    scope: {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.LOGGER) return logger
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return {}
        if (key === ContainerRegistrationKeys.QUERY) return query
        if (key === Modules.CART) return cartModule
        if (key === Modules.ORDER) return orderModule
        throw new Error(`Unexpected resolve(${key})`)
      },
    },
  } as any
  const res = {
    status: jest.fn(function status() {
      return this
    }),
    json: jest.fn(),
  } as any
  return { req, res, logger, cartModule, orderModule, query }
}

describe("place-order route ops alerting", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(checkInventoryAvailability as jest.Mock).mockResolvedValue([
      {
        variant_id: "variant_123",
        product_id: "prod_123",
        title: "Ground Beef 85/15 - 1 lb Pack",
        sku: "1-00-12-1",
        requested_quantity: 3,
        available_to_promise_quantity: 3,
        decision: "available",
        reason: "in_stock",
        alternatives: [],
      },
    ])
  })

  it("strips otherwise-valid order SMS consent from staff proxy checkout", () => {
    const metadata = {
      keep_me: true,
      order_sms_consent: {
        granted: true,
        phone: "+14045550100",
        timestamp: new Date().toISOString(),
        version: ORDER_SMS_CONSENT_VERSION,
        disclosure: ORDER_SMS_CONSENT_DISCLOSURE,
        source: ORDER_SMS_CONSENT_SOURCE,
        provider: ORDER_SMS_CONSENT_PROVIDER,
        program: ORDER_SMS_PROGRAM,
        purpose: ORDER_SMS_CONSENT_PURPOSE,
        method: ORDER_SMS_CONSENT_METHOD,
      },
    }

    expect(
      sanitizeCheckoutOrderSmsConsent(metadata, "cus_staff_target")
    ).toEqual({ keep_me: true })
    expect(
      sanitizeCheckoutOrderSmsConsent(metadata, null).order_sms_consent
    ).toEqual(expect.objectContaining({ granted: true }))
  })

  it("emits a severity:page place_order_error alert and returns 500 when the handler throws", async () => {
    ;(getPaymentContextCustomer as jest.Mock).mockRejectedValueOnce(
      new Error("boom: stripe unavailable for pm_test_123 and avi@example.com")
    )

    const { req, res } = makeReqRes()
    await POST(req, res)

    // HTTP response unchanged: still a generic 500.
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      message: "Could not place the order. Please try again.",
    })

    // Alert fired with the right shape.
    expect(emitOpsAlert).toHaveBeenCalledTimes(1)
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "place_order_error",
        severity: "page",
        path: "store/grillers/checkout/place-order",
        title: "place-order 500: Error",
        meta: expect.objectContaining({
          cart_id: "cart_test_123",
          error_name: "Error",
          error_message:
            "boom: stripe unavailable for [redacted-id] and [redacted-email]",
        }),
      })
    )

    // No PII / card data leaks into the alert meta.
    const meta = (emitOpsAlert as jest.Mock).mock.calls[0][0].meta
    expect(meta).not.toHaveProperty("payment_method_id")
    expect(meta).not.toHaveProperty("setup_intent_id")
    expect(JSON.stringify(meta)).not.toContain("pm_test_123")
    expect(JSON.stringify(meta)).not.toContain("avi@example.com")
  })

  it("surfaces shipping review as a recoverable conflict without a payment session", async () => {
    ;(getPaymentContextCustomer as jest.Mock).mockRejectedValueOnce(
      new ShippingInputError("unreviewed_shipping_weight")
    )
    const { req, res } = makeReqRes()
    await POST(req, res)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ type: "shipping_review_required" })
    )
    expect(createPaymentSessionsWorkflow).not.toHaveBeenCalled()
    expect(emitOpsAlert).not.toHaveBeenCalled()
  })

  it("blocks checkout before payment session creation when server-side ATP is unresolved", async () => {
    ;(getPaymentContextCustomer as jest.Mock).mockResolvedValueOnce({
      customer: {
        id: "cus_medusa_123",
        email: "avi@example.com",
        metadata: {},
      },
      staffTargetCustomerId: null,
    })
    ;(checkInventoryAvailability as jest.Mock).mockResolvedValueOnce([
      {
        variant_id: "variant_123",
        product_id: "prod_123",
        title: "Ground Beef 85/15 - 1 lb Pack",
        sku: "1-00-12-1",
        requested_quantity: 3,
        available_to_promise_quantity: 1,
        decision: "partial",
        reason: "partial_atp",
        alternatives: [],
      },
    ])

    const { req, res, cartModule } = makeReqRes()
    await POST(req, res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      type: "inventory",
      error: expect.objectContaining({
        code: "inventory_unavailable",
        lines: [
          expect.objectContaining({
            variant_id: "variant_123",
            requested_quantity: 3,
            available_to_promise_quantity: 1,
            decision: "partial",
          }),
        ],
      }),
    })
    expect(cartModule.updateCarts).not.toHaveBeenCalled()
    expect(createPaymentSessionsWorkflow).not.toHaveBeenCalled()
    expect(completeCartWorkflow).not.toHaveBeenCalled()
  })
})

it("rejects a stale review before payment or native order effects", async () => {
  ;(getPaymentContextCustomer as jest.Mock).mockResolvedValueOnce({
    customer: { id: "cus_medusa_123", metadata: {} },
    staffTargetCustomerId: null,
  })
  ;(acceptCheckoutReview as jest.Mock).mockRejectedValueOnce(
    new OrderPromiseError("order_review_changed_refresh_required")
  )
  const { req, res } = makeReqRes()
  await POST(req, res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(createPaymentSessionsWorkflow).not.toHaveBeenCalled()
  expect(completeCartWorkflow).not.toHaveBeenCalled()
})
