import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"

// Keep the real assert + constants (the assert is the gate under test); mock
// only the heavy IO helpers so we can drive paymentIntent.status directly.
const mockCreateStripeFinalPaymentIntent = jest.fn()
const mockRetrieveStripeFinalPaymentIntent = jest.fn()
const mockPreviewFinalization = jest.fn()
const mockClaimFinalChargeAttempt = jest.fn()
const mockSettleFinalChargeAttempt = jest.fn()
const mockQuoteWwexFinalizationShipping = jest.fn(async () => null)
const mockBookWwexFinalizationShipment = jest.fn(async () => ({
  metadata: {},
}))
const mockEmitFinalizationRouteFailureAlert = jest.fn(async (_input: any) => ({
  ok: true,
}))

jest.mock("../../../../../../../../lib/catch-weight-finalization", () => {
  const actual = jest.requireActual(
    "../../../../../../../../lib/catch-weight-finalization"
  )
  return {
    ...actual,
    createStripeFinalPaymentIntent: (...args: any[]) =>
      mockCreateStripeFinalPaymentIntent(...args),
    retrieveStripeFinalPaymentIntent: (...args: any[]) =>
      mockRetrieveStripeFinalPaymentIntent(...args),
    previewFinalization: (...args: any[]) => mockPreviewFinalization(...args),
    claimFinalChargeAttempt: (...args: any[]) =>
      mockClaimFinalChargeAttempt(...args),
    settleFinalChargeAttempt: (...args: any[]) =>
      mockSettleFinalChargeAttempt(...args),
  }
})

jest.mock("../../utils", () => ({
  emitFinalizationRouteFailureAlert: (input: any) =>
    mockEmitFinalizationRouteFailureAlert(input),
  jsonError: (res: any, status: number, message: string, extra?: any) => {
    res.status(status).json({ message, ...(extra || {}) })
    return res
  },
  loadFinalizationOrderForRoute: async () => mockRetrieveFinalizationOrder(),
  retrieveFinalizationOrder: (...args: any[]) =>
    mockRetrieveFinalizationOrder(...args),
  staffAuditActorId: () => "user_123",
  staffAuditFields: () => ({}),
}))

const mockRetrieveFinalizationOrder = jest.fn()

jest.mock("../../../../../../../../lib/wwex-finalization-shipment", () => ({
  quoteWwexFinalizationShipping: (...args: any[]) =>
    (mockQuoteWwexFinalizationShipping as (...args: any[]) => any)(...args),
  bookWwexFinalizationShipment: (...args: any[]) =>
    (mockBookWwexFinalizationShipment as (...args: any[]) => any)(...args),
}))

jest.mock("../../../../../../../../lib/final-charge-ops-alerts", () => ({
  emitChargeFailedHoldAlert: jest.fn(async () => ({ ok: true })),
  emitChargeMarkedReadyButPiNotSucceededAlert: jest.fn(async () => ({
    ok: true,
  })),
  emitFinalChargeNonSucceededAlert: jest.fn(async () => ({ ok: true })),
}))

import { POST } from "../route"
import {
  FINALIZATION_CHARGE_ATTEMPTING,
  FINALIZATION_CHARGE_FAILED_HOLD,
  FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED,
  FINALIZATION_CHARGED_READY_TO_SHIP,
  FINALIZATION_PACKED_PENDING_CHARGE,
} from "../../../../../../../../lib/catch-weight-finalization"
import {
  emitChargeMarkedReadyButPiNotSucceededAlert,
  emitFinalChargeNonSucceededAlert,
} from "../../../../../../../../lib/final-charge-ops-alerts"

function makeDb() {
  const chain: any = {
    where: jest.fn(() => chain),
    update: jest.fn(async () => 1),
    insert: jest.fn(async () => undefined),
  }
  return jest.fn(() => chain)
}

function makeRes() {
  return {
    status: jest.fn(function status(this: any) {
      return this
    }),
    json: jest.fn(),
  } as any
}

function makeScope(db: any) {
  const orderModule = {
    listOrderTransactions: jest.fn(async () => []),
    addOrderTransactions: jest.fn(async () => undefined),
    updateOrders: jest.fn(async () => undefined),
  }
  const eventBus = { emit: jest.fn(async () => undefined) }
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const scope = {
    resolve: (key: string) => {
      if (key === Modules.ORDER) return orderModule
      if (key === Modules.EVENT_BUS) return eventBus
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
      if (key === ContainerRegistrationKeys.LOGGER) return logger
      throw new Error(`Unknown dependency ${key}`)
    },
  }
  return { scope, orderModule, eventBus, logger }
}

function basePreview() {
  return {
    errors: [],
    finalization: {
      id: "fin_123",
      status: FINALIZATION_PACKED_PENDING_CHARGE,
      currency_code: "usd",
      metadata: {},
    },
    payment_setup: {
      stripe_payment_method_id: "pm_123",
      stripe_customer_id: "cus_123",
    },
    totals: { final_order_total: 5000 },
    lines: [],
    packages: [],
    package_capture_required: false,
  }
}

function baseAttempt(overrides: Record<string, any> = {}) {
  return {
    id: "attempt_123",
    order_id: "order_123",
    finalization_id: "fin_123",
    attempt_number: 1,
    amount: 5000,
    currency_code: "usd",
    stripe_customer_id: "cus_123",
    stripe_payment_method_id: "pm_123",
    stripe_payment_intent_id: null,
    stripe_charge_id: null,
    stripe_status: null,
    status: "pending",
    failure_code: null,
    failure_message: null,
    idempotency_key: "final-charge:order_123:fin_123",
    metadata: { confirmed_decline_generation: 0 },
    ...overrides,
  }
}

function confirmedDecline() {
  return Object.assign(new Error("Your card was declined."), {
    stripe_error: {
      type: "card_error",
      code: "card_declined",
      decline_code: "generic_decline",
      payment_intent: { id: "pi_declined", status: "requires_payment_method" },
    },
  })
}

describe("charge-and-release PI gate", () => {
  const originalDeclineFlag = process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED
  beforeEach(() => {
    jest.clearAllMocks()
    delete process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED
    mockRetrieveFinalizationOrder.mockResolvedValue({
      id: "order_123",
      currency_code: "usd",
      display_id: 42,
      metadata: {},
    })
    mockPreviewFinalization.mockResolvedValue(basePreview())
    mockClaimFinalChargeAttempt.mockResolvedValue({
      attempt: baseAttempt(),
      claimed: true,
    })
    mockSettleFinalChargeAttempt.mockImplementation(
      async (
        _db: any,
        attempt: Record<string, any>,
        input: Record<string, any>
      ) => ({
        ...attempt,
        status: input.status,
        stripe_payment_intent_id:
          input.stripePaymentIntentId ||
          attempt.stripe_payment_intent_id ||
          null,
        stripe_charge_id:
          input.stripeChargeId || attempt.stripe_charge_id || null,
        stripe_status: input.stripeStatus || attempt.stripe_status || null,
        failure_code:
          input.status === "succeeded" ? null : input.failureCode || null,
        failure_message:
          input.status === "succeeded" ? null : input.failureMessage || null,
        metadata: {
          ...(attempt.metadata || {}),
          ...(input.metadata || {}),
        },
      })
    )
  })
  afterAll(() => {
    if (originalDeclineFlag === undefined) delete process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED
    else process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED = originalDeclineFlag
  })

  it("emits no decline notice when the flag is off", async () => {
    mockCreateStripeFinalPaymentIntent.mockRejectedValueOnce(confirmedDecline())
    const { scope, eventBus } = makeScope(makeDb())
    const res = makeRes()
    await POST({ params: { id: "order_123" }, body: {}, scope } as any, res)
    expect(res.status).toHaveBeenCalledWith(402)
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it("emits one declined notice with the durable attempt identity when enabled", async () => {
    process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED = "true"
    mockCreateStripeFinalPaymentIntent.mockRejectedValueOnce(confirmedDecline())
    const { scope, eventBus } = makeScope(makeDb())
    const res = makeRes()
    await POST({ params: { id: "order_123" }, body: {}, scope } as any, res)
    expect(res.status).toHaveBeenCalledWith(402)
    expect(eventBus.emit).toHaveBeenCalledTimes(1)
    expect(eventBus.emit).toHaveBeenCalledWith({
      name: "order.final_charge_declined",
      data: {
        id: "order_123",
        order_id: "order_123",
        finalization_id: "fin_123",
        charge_attempt_id: "attempt_123",
      },
    })
  })

  it("emits no decline notice for an uncertain payment outcome when enabled", async () => {
    process.env.GP_FINAL_CHARGE_DECLINE_EMAIL_ENABLED = "true"
    mockCreateStripeFinalPaymentIntent.mockRejectedValueOnce(new Error("Stripe request timed out"))
    const { scope, eventBus } = makeScope(makeDb())
    const res = makeRes()
    await POST({ params: { id: "order_123" }, body: {}, scope } as any, res)
    expect(res.status).toHaveBeenCalledWith(402)
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it("does NOT alert and proceeds when the PaymentIntent succeeded", async () => {
    mockCreateStripeFinalPaymentIntent.mockResolvedValue({
      id: "pi_ok_123",
      status: "succeeded",
      latest_charge: "ch_123",
    })

    const db = makeDb()
    const { scope } = makeScope(db)
    const req = { params: { id: "order_123" }, body: {}, scope } as any
    const res = makeRes()

    await POST(req, res)

    expect(emitFinalChargeNonSucceededAlert).not.toHaveBeenCalled()
    expect(emitChargeMarkedReadyButPiNotSucceededAlert).not.toHaveBeenCalled()
    // Normal flow: succeeded → marks finalization ready_to_ship via db update.
    const updatedToReady = db.mock.results.some((r: any) =>
      r.value.update.mock.calls.some((c: any[]) =>
        Object.values(c[0] || {}).includes(FINALIZATION_CHARGED_READY_TO_SHIP)
      )
    )
    expect(updatedToReady).toBe(true)
    expect(mockPreviewFinalization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "order_123" }),
      {
        persist: true,
        preserveWorkflowStatus: true,
      }
    )
    const updates = db.mock.results.flatMap((r: any) =>
      r.value.update.mock.calls.map((call: any[]) => call[0])
    )
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: FINALIZATION_CHARGE_ATTEMPTING,
          charge_attempt_id: "attempt_123",
        }),
      ])
    )
    expect(mockCreateStripeFinalPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "final-charge:order_123:fin_123",
      })
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it("does not create a second Stripe charge when retrying a succeeded-but-unrecorded finalization", async () => {
    mockPreviewFinalization.mockResolvedValueOnce({
      ...basePreview(),
      finalization: {
        ...basePreview().finalization,
        status: FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED,
        stripe_payment_intent_id: "pi_existing_123",
      },
    })
    mockRetrieveStripeFinalPaymentIntent.mockResolvedValueOnce({
      id: "pi_existing_123",
      status: "succeeded",
      latest_charge: "ch_existing_123",
    })

    const db = makeDb()
    const { scope } = makeScope(db)
    const req = { params: { id: "order_123" }, body: {}, scope } as any
    const res = makeRes()

    await POST(req, res)

    expect(mockCreateStripeFinalPaymentIntent).not.toHaveBeenCalled()
    expect(mockRetrieveStripeFinalPaymentIntent).toHaveBeenCalledWith(
      "pi_existing_123"
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it("holds fulfillment without marking the card failed when Stripe succeeds but local release recording fails", async () => {
    mockCreateStripeFinalPaymentIntent.mockResolvedValue({
      id: "pi_ok_recording_failure",
      status: "succeeded",
      latest_charge: "ch_recording_failure",
    })
    mockBookWwexFinalizationShipment.mockRejectedValueOnce(
      new Error("WWEX booking write failed")
    )

    const db = makeDb()
    const { scope } = makeScope(db)
    const req = { params: { id: "order_123" }, body: {}, scope } as any
    const res = makeRes()

    await POST(req, res)

    expect(mockSettleFinalChargeAttempt).toHaveBeenCalledTimes(2)
    expect(mockSettleFinalChargeAttempt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "attempt_123" }),
      expect.objectContaining({
        stripePaymentIntentId: "pi_ok_recording_failure",
        stripeChargeId: "ch_recording_failure",
        status: "succeeded",
      })
    )
    const updates = db.mock.results.flatMap(
      (r: any) => r.value.update.mock.calls
    )
    expect(
      updates.some(
        (call: any[]) =>
          call[0]?.stripe_payment_intent_id === "pi_ok_recording_failure"
      )
    ).toBe(true)
    expect(
      updates.some((call: any[]) =>
        Object.values(call[0] || {}).includes(
          FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED
        )
      )
    ).toBe(true)
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        finalization_status: FINALIZATION_CHARGE_SUCCEEDED_RECORDING_FAILED,
        payment_intent: expect.objectContaining({
          id: "pi_ok_recording_failure",
          status: "succeeded",
        }),
      })
    )
  })

  it("opens a fresh idempotency generation only after a confirmed decline and uses the repaired payment method", async () => {
    const declinedAttempt = baseAttempt()
    const retryAttempt = baseAttempt({
      id: "attempt_124",
      attempt_number: 2,
      stripe_payment_method_id: "pm_fixed",
      idempotency_key: "final-charge:order_123:fin_123:decline:1",
      metadata: { confirmed_decline_generation: 1 },
    })
    mockPreviewFinalization
      .mockResolvedValueOnce(basePreview())
      .mockResolvedValueOnce({
        ...basePreview(),
        finalization: {
          ...basePreview().finalization,
          status: FINALIZATION_CHARGE_FAILED_HOLD,
          charge_attempt_id: "attempt_123",
          stripe_payment_intent_id: "pi_declined",
        },
        payment_setup: {
          ...basePreview().payment_setup,
          stripe_payment_method_id: "pm_fixed",
        },
      })
    mockClaimFinalChargeAttempt
      .mockResolvedValueOnce({ attempt: declinedAttempt, claimed: true })
      .mockResolvedValueOnce({ attempt: retryAttempt, claimed: true })
    const decline = Object.assign(new Error("Your card was declined."), {
      stripe_error: {
        type: "card_error",
        code: "card_declined",
        decline_code: "generic_decline",
        payment_intent: {
          id: "pi_declined",
          status: "requires_payment_method",
        },
      },
    })
    mockCreateStripeFinalPaymentIntent
      .mockRejectedValueOnce(decline)
      .mockResolvedValueOnce({
        id: "pi_retry_ok",
        status: "succeeded",
        latest_charge: "ch_retry_ok",
      })

    const firstDb = makeDb()
    const first = makeScope(firstDb)
    const firstRes = makeRes()
    await POST(
      {
        params: { id: "order_123" },
        body: {},
        scope: first.scope,
      } as any,
      firstRes
    )

    const secondDb = makeDb()
    const second = makeScope(secondDb)
    const secondRes = makeRes()
    await POST(
      {
        params: { id: "order_123" },
        body: {},
        scope: second.scope,
      } as any,
      secondRes
    )

    expect(firstRes.status).toHaveBeenCalledWith(402)
    expect(secondRes.status).toHaveBeenCalledWith(200)
    expect(mockSettleFinalChargeAttempt).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ id: "attempt_123" }),
      expect.objectContaining({
        status: "failed",
        stripePaymentIntentId: "pi_declined",
        failureCode: "card_declined",
        metadata: expect.objectContaining({
          confirmed_stripe_decline: true,
          stripe_decline_code: "generic_decline",
        }),
      })
    )
    expect(mockClaimFinalChargeAttempt).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.objectContaining({
        stripePaymentMethodId: "pm_fixed",
      })
    )
    expect(mockCreateStripeFinalPaymentIntent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: "final-charge:order_123:fin_123",
        stripePaymentMethodId: "pm_123",
      })
    )
    expect(mockCreateStripeFinalPaymentIntent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: "final-charge:order_123:fin_123:decline:1",
        stripePaymentMethodId: "pm_fixed",
      })
    )
    expect(mockRetrieveStripeFinalPaymentIntent).not.toHaveBeenCalled()
  })

  it("replays an ambiguous attempt with the same Stripe key when no PaymentIntent id was returned", async () => {
    const sharedAttempt = baseAttempt()
    mockPreviewFinalization
      .mockResolvedValueOnce(basePreview())
      .mockResolvedValueOnce({
        ...basePreview(),
        finalization: {
          ...basePreview().finalization,
          status: FINALIZATION_CHARGE_FAILED_HOLD,
        },
      })
    mockClaimFinalChargeAttempt
      .mockResolvedValueOnce({ attempt: sharedAttempt, claimed: true })
      .mockResolvedValueOnce({
        attempt: { ...sharedAttempt, status: "pending" },
        claimed: true,
      })
    mockCreateStripeFinalPaymentIntent
      .mockRejectedValueOnce(new Error("Stripe request timed out"))
      .mockResolvedValueOnce({
        id: "pi_same_attempt",
        status: "succeeded",
        latest_charge: "ch_same_attempt",
      })

    const first = makeScope(makeDb())
    const firstRes = makeRes()
    await POST(
      { params: { id: "order_123" }, body: {}, scope: first.scope } as any,
      firstRes
    )
    const second = makeScope(makeDb())
    const secondRes = makeRes()
    await POST(
      { params: { id: "order_123" }, body: {}, scope: second.scope } as any,
      secondRes
    )

    expect(firstRes.status).toHaveBeenCalledWith(402)
    expect(secondRes.status).toHaveBeenCalledWith(200)
    expect(mockCreateStripeFinalPaymentIntent).toHaveBeenCalledTimes(2)
    expect(
      mockCreateStripeFinalPaymentIntent.mock.calls.map(
        (call: any[]) => call[0].idempotencyKey
      )
    ).toEqual([
      "final-charge:order_123:fin_123",
      "final-charge:order_123:fin_123",
    ])
  })

  it("adopts a known PaymentIntent after an unknown outcome instead of creating another one", async () => {
    const initialAttempt = baseAttempt()
    const retryAttempt = baseAttempt({
      status: "pending",
      stripe_payment_intent_id: "pi_ambiguous",
      stripe_status: "processing",
    })
    mockPreviewFinalization
      .mockResolvedValueOnce(basePreview())
      .mockResolvedValueOnce({
        ...basePreview(),
        finalization: {
          ...basePreview().finalization,
          status: FINALIZATION_CHARGE_FAILED_HOLD,
          stripe_payment_intent_id: "pi_ambiguous",
        },
      })
    mockClaimFinalChargeAttempt
      .mockResolvedValueOnce({ attempt: initialAttempt, claimed: true })
      .mockResolvedValueOnce({ attempt: retryAttempt, claimed: true })
    mockCreateStripeFinalPaymentIntent.mockRejectedValueOnce(
      Object.assign(new Error("Stripe response was interrupted"), {
        stripe_error: {
          type: "api_error",
          code: "api_connection_error",
          payment_intent: {
            id: "pi_ambiguous",
            status: "processing",
          },
        },
      })
    )
    mockRetrieveStripeFinalPaymentIntent.mockResolvedValueOnce({
      id: "pi_ambiguous",
      status: "succeeded",
      latest_charge: "ch_ambiguous",
    })

    const first = makeScope(makeDb())
    const firstRes = makeRes()
    await POST(
      { params: { id: "order_123" }, body: {}, scope: first.scope } as any,
      firstRes
    )
    const second = makeScope(makeDb())
    const secondRes = makeRes()
    await POST(
      { params: { id: "order_123" }, body: {}, scope: second.scope } as any,
      secondRes
    )

    expect(firstRes.status).toHaveBeenCalledWith(402)
    expect(secondRes.status).toHaveBeenCalledWith(200)
    expect(mockCreateStripeFinalPaymentIntent).toHaveBeenCalledTimes(1)
    expect(mockRetrieveStripeFinalPaymentIntent).toHaveBeenCalledTimes(1)
    expect(mockRetrieveStripeFinalPaymentIntent).toHaveBeenCalledWith(
      "pi_ambiguous"
    )
  })

  it("adopts a PaymentIntent durably linked on the finalization when attempt settlement was interrupted", async () => {
    mockPreviewFinalization.mockResolvedValueOnce({
      ...basePreview(),
      finalization: {
        ...basePreview().finalization,
        status: FINALIZATION_CHARGE_ATTEMPTING,
        charge_attempt_id: "attempt_123",
        stripe_payment_intent_id: "pi_linked",
      },
    })
    mockClaimFinalChargeAttempt.mockResolvedValueOnce({
      attempt: baseAttempt({ status: "pending" }),
      claimed: true,
    })
    mockRetrieveStripeFinalPaymentIntent.mockResolvedValueOnce({
      id: "pi_linked",
      status: "succeeded",
      latest_charge: "ch_linked",
    })

    const { scope } = makeScope(makeDb())
    const res = makeRes()
    await POST({ params: { id: "order_123" }, body: {}, scope } as any, res)

    expect(mockCreateStripeFinalPaymentIntent).not.toHaveBeenCalled()
    expect(mockRetrieveStripeFinalPaymentIntent).toHaveBeenCalledWith(
      "pi_linked"
    )
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it("lets only one concurrent caller own the shared pending attempt", async () => {
    const sharedAttempt = baseAttempt()
    mockClaimFinalChargeAttempt
      .mockResolvedValueOnce({ attempt: sharedAttempt, claimed: true })
      .mockResolvedValueOnce({ attempt: sharedAttempt, claimed: false })
    mockCreateStripeFinalPaymentIntent.mockResolvedValueOnce({
      id: "pi_concurrent",
      status: "succeeded",
      latest_charge: "ch_concurrent",
    })

    const first = makeScope(makeDb())
    const second = makeScope(makeDb())
    const firstRes = makeRes()
    const secondRes = makeRes()
    await Promise.all([
      POST(
        { params: { id: "order_123" }, body: {}, scope: first.scope } as any,
        firstRes
      ),
      POST(
        { params: { id: "order_123" }, body: {}, scope: second.scope } as any,
        secondRes
      ),
    ])

    expect(mockCreateStripeFinalPaymentIntent).toHaveBeenCalledTimes(1)
    expect(firstRes.status).toHaveBeenCalledWith(200)
    expect(secondRes.status).toHaveBeenCalledWith(409)
    expect(secondRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        charge_attempt_id: "attempt_123",
      })
    )
  })

  it("does not run release side effects when a stale caller loses the attempt lease after Stripe succeeds", async () => {
    mockCreateStripeFinalPaymentIntent.mockResolvedValueOnce({
      id: "pi_shared_success",
      status: "succeeded",
      latest_charge: "ch_shared_success",
    })
    mockSettleFinalChargeAttempt.mockResolvedValueOnce({
      ...baseAttempt(),
      claim_lost: true,
    })

    const { scope, orderModule, eventBus } = makeScope(makeDb())
    const res = makeRes()
    await POST({ params: { id: "order_123" }, body: {}, scope } as any, res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(mockBookWwexFinalizationShipment).not.toHaveBeenCalled()
    expect(orderModule.addOrderTransactions).not.toHaveBeenCalled()
    expect(orderModule.updateOrders).not.toHaveBeenCalled()
    expect(eventBus.emit).not.toHaveBeenCalled()
  })

  it("does not write a failed hold when a stale caller loses the attempt lease after an ambiguous Stripe error", async () => {
    mockCreateStripeFinalPaymentIntent.mockRejectedValueOnce(
      new Error("Stripe request timed out")
    )
    mockSettleFinalChargeAttempt.mockResolvedValueOnce({
      ...baseAttempt(),
      claim_lost: true,
    })

    const db = makeDb()
    const { scope, orderModule } = makeScope(db)
    const res = makeRes()
    await POST({ params: { id: "order_123" }, body: {}, scope } as any, res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(orderModule.updateOrders).not.toHaveBeenCalled()
    const updates = db.mock.results.flatMap((r: any) =>
      r.value.update.mock.calls.map((call: any[]) => call[0])
    )
    expect(updates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: FINALIZATION_CHARGE_FAILED_HOLD,
        }),
      ])
    )
  })

  it("pages charge_marked_ready_but_pi_not_succeeded when status is processing, and the transition is blocked (response unchanged)", async () => {
    mockCreateStripeFinalPaymentIntent.mockResolvedValue({
      id: "pi_proc_123",
      status: "processing",
    })

    const db = makeDb()
    const { scope } = makeScope(db)
    const req = { params: { id: "order_123" }, body: {}, scope } as any
    const res = makeRes()

    await POST(req, res)

    // The money-critical guard alert fired before the assert.
    expect(emitChargeMarkedReadyButPiNotSucceededAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: "order_123",
        finalizationId: "fin_123",
        paymentIntentId: "pi_proc_123",
        paymentIntentStatus: "processing",
        amount: 5000,
        blocked: true,
      })
    )
    // The existing non-succeeded alert also fired (unchanged behavior).
    expect(emitFinalChargeNonSucceededAlert).toHaveBeenCalled()
    // The assert tripped: the order was NOT marked ready_to_ship.
    const updatedToReady = db.mock.results.some((r: any) =>
      r.value.update.mock.calls.some((c: any[]) =>
        Object.values(c[0] || {}).includes(FINALIZATION_CHARGED_READY_TO_SHIP)
      )
    )
    expect(updatedToReady).toBe(false)
    // Response is the existing 402 charge-failed-hold path, unchanged.
    expect(res.status).toHaveBeenCalledWith(402)
  })

  it("pages route failure telemetry when final charge preflight throws", async () => {
    mockPreviewFinalization.mockRejectedValueOnce(
      new Error("preview persistence failed")
    )

    const db = makeDb()
    const { scope } = makeScope(db)
    const req = { params: { id: "order_123" }, body: {}, scope } as any
    const res = makeRes()

    await POST(req, res)

    expect(mockCreateStripeFinalPaymentIntent).not.toHaveBeenCalled()
    expect(mockEmitFinalizationRouteFailureAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "charge_and_release_preflight",
        error: expect.any(Error),
        order: expect.objectContaining({ id: "order_123" }),
        orderId: "order_123",
        path: "src/api/admin/grillers/orders/[id]/finalization/charge-and-release/route.ts",
        status: 409,
      })
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      message: "preview persistence failed",
    })
  })
})

it("refuses a new Stripe attempt when the shipping price review is blocked", async () => {
  mockCreateStripeFinalPaymentIntent.mockClear()
  mockClaimFinalChargeAttempt.mockClear()
  mockRetrieveFinalizationOrder.mockResolvedValueOnce({
    id: "order_123",
    currency_code: "usd",
    metadata: {},
  })
  mockPreviewFinalization.mockResolvedValueOnce(basePreview())
  ;(mockQuoteWwexFinalizationShipping as jest.Mock).mockResolvedValueOnce({
    status: "blocked",
    reason: "shipping_price_review_required",
    totals: {},
  })
  const { scope } = makeScope(makeDb())
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(mockClaimFinalChargeAttempt).not.toHaveBeenCalled()
  expect(mockCreateStripeFinalPaymentIntent).not.toHaveBeenCalled()
})
