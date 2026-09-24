import {
  approvedEssentialEmailDuringBlackout,
  observanceSendPolicyEnabled,
} from "../communications/observance-send-policy"
import type {
  CommunicationPurpose,
  SendTrackedEmailInput,
} from "../communications/core"

const orderNotice: SendTrackedEmailInput = {
  to: "customer@example.com",
  subject: "Order update",
  html: "<p>Order update</p>",
  stream: "transactional",
  purpose: "transactional",
  template_key: "order-placed",
  topic: "order_updates",
  order_id: "order_123",
}

describe("approved observance send policy", () => {
  const initialFlag = process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED
  afterEach(() => {
    if (initialFlag === undefined) {
      delete process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED
    } else {
      process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED = initialFlag
    }
  })

  it("is off unless explicitly enabled", () => {
    delete process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED
    expect(observanceSendPolicyEnabled()).toBe(false)
    process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED = "yes"
    expect(observanceSendPolicyEnabled()).toBe(false)
    process.env.GP_OBSERVANCE_SEND_POLICY_ENABLED = "true"
    expect(observanceSendPolicyEnabled()).toBe(true)
  })

  it.each([
    ["customer-password-reset", "account", null, "transactional"],
    ["receipt-email-verification", "account", null, "service"],
    ["order-placed", "order_updates", "order_123", "transactional"],
    ["order-final-charge", "order_updates", "order_123", "transactional"],
    ["refund-issued", "order_updates", "order_123", "transactional"],
    ["order-canceled", "order_updates", "order_123", "transactional"],
    ["order-shipped", "order_updates", "order_123", "transactional"],
  ])("allows only the approved %s notice", (template_key, topic, order_id, purpose) => {
    expect(
      approvedEssentialEmailDuringBlackout(
        { ...orderNotice, template_key, topic, order_id },
        purpose as CommunicationPurpose
      )
    ).toBe(true)
  })

  it.each([
    [{ template_key: "customer-welcome", topic: "account", order_id: null }, "service"],
    [{ template_key: "welcome-1", topic: "account", order_id: null }, "service"],
    [{ template_key: "cart-abandoned-1" }, "marketing_1to1"],
    [{ stream: "broadcast" }, "transactional"],
    [{ order_id: null }, "transactional"],
    [{ topic: "promotions" }, "transactional"],
    [{ flow_id: "flow_123" }, "transactional"],
    [{ campaign_id: "campaign_123" }, "transactional"],
    [{ staff_test: true }, "transactional"],
    [{ postmark_template_alias: "editable-marketing" }, "transactional"],
  ])("defers a nonessential or untrusted shape %#", (overrides, purpose) => {
    expect(
      approvedEssentialEmailDuringBlackout(
        { ...orderNotice, ...overrides } as SendTrackedEmailInput,
        purpose as CommunicationPurpose
      )
    ).toBe(false)
  })
})
