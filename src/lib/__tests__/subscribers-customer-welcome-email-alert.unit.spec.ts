import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

const mockEmitTransactionalEmailHandlerFailureAlert = jest.fn()
const mockEmitTransactionalEmailPreconditionAlert = jest.fn()
const mockSendTrackedEmail = jest.fn()
const mockUpsertCustomerProfile = jest.fn()

jest.mock("../emails/ops-alerts", () => ({
  emitTransactionalEmailHandlerFailureAlert: (...args: any[]) =>
    mockEmitTransactionalEmailHandlerFailureAlert(...args),
  emitTransactionalEmailPreconditionAlert: (...args: any[]) =>
    mockEmitTransactionalEmailPreconditionAlert(...args),
}))

jest.mock("../communications/core", () => ({
  sendTrackedEmail: (...args: any[]) => mockSendTrackedEmail(...args),
  smsConsentFromCustomerMetadata: jest.fn(() => ({})),
  upsertCustomerProfile: (...args: any[]) => mockUpsertCustomerProfile(...args),
}))

import customerWelcomeEmailHandler from "../../subscribers/customer-welcome-email"

function makeContainer(customers: Array<Record<string, any>>) {
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const db = jest.fn()
  const query = {
    graph: jest.fn(async () => ({ data: customers })),
  }
  const container = {
    resolve: jest.fn((key: string) => {
      if (key === "logger") return logger
      if (key === "query") return query
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
      throw new Error(`Unexpected dependency ${key}`)
    }),
  }

  return { container, db, logger, query }
}

const previousFlag = process.env.GP_ACCOUNT_WELCOME_ENABLED
afterEach(() => {
  if (previousFlag === undefined) delete process.env.GP_ACCOUNT_WELCOME_ENABLED
  else process.env.GP_ACCOUNT_WELCOME_ENABLED = previousFlag
})

describe("customer welcome email precondition alerts", () => {
  beforeEach(() => {
    delete process.env.GP_ACCOUNT_WELCOME_ENABLED
    jest.clearAllMocks()
    mockUpsertCustomerProfile.mockResolvedValue({ id: "gpcprof_123" })
    mockSendTrackedEmail.mockResolvedValue(undefined)
  })

  it("alerts and skips sending when customer.created cannot load a customer", async () => {
    const { container, logger } = makeContainer([])

    await customerWelcomeEmailHandler({
      event: { data: { id: "cus_missing" } },
      container,
    } as any)

    expect(logger.warn).toHaveBeenCalledWith(
      "[customer-welcome-email] customer not found id=cus_missing"
    )
    expect(mockEmitTransactionalEmailPreconditionAlert).toHaveBeenCalledWith({
      logger,
      templateKey: "customer-welcome",
      reason: "customer_not_found",
      path: "src/subscribers/customer-welcome-email.ts",
      eventName: "customer.created",
      eventId: "cus_missing",
      customerId: "cus_missing",
    })
    expect(mockSendTrackedEmail).not.toHaveBeenCalled()
  })

  it("alerts and skips sending when the customer has no email", async () => {
    const { container, logger } = makeContainer([
      {
        id: "cus_no_email",
        email: null,
        first_name: "Avi",
        has_account: true,
        metadata: {},
      },
    ])

    await customerWelcomeEmailHandler({
      event: { data: { id: "cus_no_email" } },
      container,
    } as any)

    expect(logger.warn).toHaveBeenCalledWith(
      "[customer-welcome-email] customer cus_no_email has no email"
    )
    expect(mockEmitTransactionalEmailPreconditionAlert).toHaveBeenCalledWith({
      logger,
      templateKey: "customer-welcome",
      reason: "customer_missing_email",
      path: "src/subscribers/customer-welcome-email.ts",
      eventName: "customer.created",
      eventId: "cus_no_email",
      customerId: "cus_no_email",
    })
    expect(mockSendTrackedEmail).not.toHaveBeenCalled()
  })

  it("does not alert when the created customer is a guest", async () => {
    const { container, logger } = makeContainer([
      {
        id: "cus_guest",
        email: "guest@example.com",
        first_name: "Guest",
        has_account: false,
        metadata: {},
      },
    ])

    await customerWelcomeEmailHandler({
      event: { data: { id: "cus_guest" } },
      container,
    } as any)

    expect(logger.info).toHaveBeenCalledWith(
      "[customer-welcome-email] skipping guest customer cus_guest"
    )
    expect(mockEmitTransactionalEmailPreconditionAlert).not.toHaveBeenCalled()
    expect(mockSendTrackedEmail).not.toHaveBeenCalled()
  })

  it("alerts when the welcome email handler throws unexpectedly", async () => {
    const error = new Error("profile upsert failed")
    mockUpsertCustomerProfile.mockRejectedValueOnce(error)
    const { container, logger } = makeContainer([
      {
        id: "cus_123",
        email: "shopper@example.com",
        first_name: "Shopper",
        phone: null,
        has_account: true,
        metadata: {},
      },
    ])

    await customerWelcomeEmailHandler({
      event: { data: { id: "cus_123" } },
      container,
    } as any)

    expect(mockEmitTransactionalEmailHandlerFailureAlert).toHaveBeenCalledWith({
      logger,
      templateKey: "customer-welcome",
      path: "src/subscribers/customer-welcome-email.ts",
      eventName: "customer.created",
      eventId: "cus_123",
      customerId: "cus_123",
      error,
    })
    expect(mockSendTrackedEmail).not.toHaveBeenCalled()
  })
})


it.each([undefined, "", "false", "invalid"])("keeps the legacy service welcome until explicit activation (%s)", async flag => {
  if (flag === undefined) delete process.env.GP_ACCOUNT_WELCOME_ENABLED
  else process.env.GP_ACCOUNT_WELCOME_ENABLED = flag
  const { container } = makeContainer([{ id: "cus_legacy", email: "legacy@example.invalid", has_account: true, metadata: {} }])
  await customerWelcomeEmailHandler({ event: { data: { id: "cus_legacy" } }, container } as any)
  expect(mockSendTrackedEmail).toHaveBeenLastCalledWith(container, expect.objectContaining({
    template_key: "customer-welcome", purpose: "service", stream: "transactional", idempotency_key: "customer-welcome:cus_legacy",
  }))
})

it("retires the legacy subscriber when the original-source worker is explicitly enabled", async () => {
  process.env.GP_ACCOUNT_WELCOME_ENABLED = "true"
  const { container } = makeContainer([])
  await customerWelcomeEmailHandler({ event: { data: { id: "cus_legacy" } }, container } as any)
  expect(container.resolve).not.toHaveBeenCalled()
})
