const mockFetchOrderForEmail = jest.fn()
const mockSendTrackedEmail = jest.fn()
const mockPreconditionAlert = jest.fn()
const mockFailureAlert = jest.fn()

jest.mock("../emails/order-fetch", () => ({
  fetchOrderForEmail: (...args: any[]) => mockFetchOrderForEmail(...args),
}))
jest.mock("../communications/core", () => ({
  sendTrackedEmail: (...args: any[]) => mockSendTrackedEmail(...args),
}))
jest.mock("../emails/ops-alerts", () => ({
  emitTransactionalEmailPreconditionAlert: (...args: any[]) => mockPreconditionAlert(...args),
  emitTransactionalEmailHandlerFailureAlert: (...args: any[]) => mockFailureAlert(...args),
}))

import orderFinalChargeDeclinedEmailHandler from "../../subscribers/order-final-charge-declined-email"
import { isConfirmedStripeFinalChargeDecline } from "../final-charge-execution"

const event = {
  data: {
    id: "order_1",
    order_id: "order_1",
    finalization_id: "fin_1",
    charge_attempt_id: "attempt_1",
  },
}
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
const container = { resolve: jest.fn(() => logger) }

describe("final-charge decline notice", () => {
  const previousFlag = process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED
    mockSendTrackedEmail.mockResolvedValue({ ok: true, messageId: "pm_1" })
    mockFetchOrderForEmail.mockResolvedValue({
      id: "order_1",
      display_id: 12,
      customer_id: "customer_1",
      email: "original-receipt@example.invalid",
    })
  })
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED
    else process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED = previousFlag
  })

  it("is off by default", async () => {
    await orderFinalChargeDeclinedEmailHandler({ event, container } as any)
    expect(mockFetchOrderForEmail).not.toHaveBeenCalled()
    expect(mockSendTrackedEmail).not.toHaveBeenCalled()
  })

  it("uses the accepted receipt destination and the same durable key on redelivery", async () => {
    process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED = "true"
    await orderFinalChargeDeclinedEmailHandler({ event, container } as any)
    await orderFinalChargeDeclinedEmailHandler({ event, container } as any)
    expect(mockFetchOrderForEmail).toHaveBeenCalledWith(container, "order_1")
    expect(mockSendTrackedEmail).toHaveBeenCalledTimes(2)
    for (const [, message] of mockSendTrackedEmail.mock.calls) {
      expect(message).toMatchObject({
        to: "original-receipt@example.invalid",
        purpose: "transactional",
        template_key: "order-final-charge-declined",
        idempotency_key: "order-final-charge-declined:order_1:fin_1:attempt_1",
      })
      expect(message.text).toContain("order is on hold")
      expect(message.text).toContain("Please contact")
    }
  })

  it("requires a fully identified declined attempt", async () => {
    process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED = "true"
    await orderFinalChargeDeclinedEmailHandler({
      event: { data: { ...event.data, charge_attempt_id: "" } }, container,
    } as any)
    expect(mockSendTrackedEmail).not.toHaveBeenCalled()
  })

  it("alerts rather than substituting another recipient", async () => {
    process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED = "true"
    mockFetchOrderForEmail.mockRejectedValue(new Error("Order receipt snapshot ownership mismatch"))
    await orderFinalChargeDeclinedEmailHandler({ event, container } as any)
    expect(mockSendTrackedEmail).not.toHaveBeenCalled()
    expect(mockFailureAlert).toHaveBeenCalledTimes(1)
  })

  it("only identifies a Stripe-confirmed card decline", () => {
    const decline = {
      code: "card_declined",
      payment_intent: { id: "pi_1", status: "requires_payment_method" },
    }
    expect(isConfirmedStripeFinalChargeDecline(decline)).toBe(true)
    expect(isConfirmedStripeFinalChargeDecline({ ...decline, payment_intent: { id: "pi_1", status: "processing" } })).toBe(false)
    expect(isConfirmedStripeFinalChargeDecline({ ...decline, payment_intent: { id: "pi_1", status: "succeeded" } })).toBe(false)
    expect(isConfirmedStripeFinalChargeDecline({ code: "api_connection_error" })).toBe(false)
  })
})
