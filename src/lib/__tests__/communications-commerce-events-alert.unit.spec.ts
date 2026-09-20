const mockRecordCommunicationEvent = jest.fn()
const mockUpsertCustomerProfile = jest.fn()
const mockSmsConsentFromCustomerMetadata = jest.fn((_metadata: any) => ({}))
const mockEmitOpsAlert = jest.fn(async (_input: any) => ({
  ok: true,
  skipped: false,
}))

jest.mock("../communications/core", () => ({
  recordCommunicationEvent: (db: any, input: any) =>
    mockRecordCommunicationEvent(db, input),
  upsertCustomerProfile: (db: any, input: any) =>
    mockUpsertCustomerProfile(db, input),
  smsConsentFromCustomerMetadata: (metadata: any) =>
    mockSmsConsentFromCustomerMetadata(metadata),
}))

jest.mock("../ops-alert", () => ({
  emitOpsAlert: (input: any) => mockEmitOpsAlert(input),
}))

import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import communicationsCommerceEvents from "../../subscribers/communications-commerce-events"

function makeContainer() {
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const db = jest.fn()
  const query = { graph: jest.fn() }
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
      if (key === "query") return query
      throw new Error(`Unexpected dependency ${key}`)
    }),
  }

  return { container, logger, db, query }
}

describe("communications commerce event subscriber alerts", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("alerts when commerce event recording fails before a communications row exists", async () => {
    mockUpsertCustomerProfile.mockResolvedValueOnce({ id: "gpcprof_123" })
    mockRecordCommunicationEvent.mockRejectedValueOnce(
      new Error("insert failed for shopper@example.com")
    )
    const { container, logger, query } = makeContainer()
    query.graph.mockResolvedValue({ data: [{ id: "cus_123", email: "shopper@example.com" }] })

    await communicationsCommerceEvents({
      event: {
        name: "customer.updated",
        data: {
          id: "cus_123",
          cart_id: "cart_123",
          customer_id: "cus_123",
          email: "shopper@example.com",
        },
      },
      container,
    } as any)

    expect(logger.warn).toHaveBeenCalledWith(
      "[communications] failed to record commerce event customer.updated: insert failed for [redacted-email]"
    )
    expect(mockEmitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "communications_commerce_event_record_failed",
        severity: "warn",
        title: "Communications commerce event failed for customer.updated",
        path: "src/subscribers/communications-commerce-events.ts",
        source: "medusa-server",
        logger,
        meta: expect.objectContaining({
          medusa_event_name: "customer.updated",
          source_event_id: "cus_123",
          order_id: null,
          cart_id: "cart_123",
          medusa_customer_id: "cus_123",
          has_email: true,
          error: "insert failed for [redacted-email]",
        }),
      })
    )
    expect(JSON.stringify(mockEmitOpsAlert.mock.calls[0][0].meta)).not.toContain(
      "shopper@example.com"
    )
  })
})
