const mockShippingQuote = jest.fn(async () => ({ status: "blocked" }))
jest.mock("../../../../../../../../lib/wwex-finalization-shipment", () => ({
  quoteWwexFinalizationShipping: () => mockShippingQuote(),
}))
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../../../../../../../../lib/ops-alert"
import { previewFinalization } from "../../../../../../../../lib/catch-weight-finalization"
import { institutionalCheckoutAuthority, reserveInstitutionalCheckout } from "../../../../../../../../lib/gp-institutional-checkout"
import { persistInstitutionalReleaseIntent, reconcileInstitutionalReleaseIntent } from "../../../../../../../../lib/gp-institutional-release-intent"

const mockApproveFinalization = jest.fn()
const mockInvoiceArOrderMetadata = jest.fn((_input: any) => ({
  ..._input.order.metadata,
  payment_workflow: "invoice_ar",
  catch_weight_final_lines: [{ line_item_id: "ordli_1" }],
  catch_weight_packages: [{ shipper_qbd_list_id: "SHIPPER-LIST-ID" }],
}))
const mockIsInvoiceOrder = jest.fn((_order: any) => false)

jest.mock("../../../../../../../../lib/catch-weight-finalization", () => ({
  CATCH_WEIGHT_ORDER_FIELDS: ["id", "metadata"],
  FINALIZATION_PACKED_PENDING_CHARGE: "packed_pending_charge",
  appendStaffAudit: jest.fn((metadata) => metadata),
  approveFinalization: (...args: any[]) => mockApproveFinalization(...args),
  orderRequiresPackageCapture: (order: any) =>
    order.package_capture_required === true,
  previewFinalization: jest.fn(async () => ({
    package_capture_required: true,
  })),
  invoiceArOrderMetadata: (input: any) => mockInvoiceArOrderMetadata(input),
  isInvoiceOrder: (order: any) => mockIsInvoiceOrder(order),
  metadataObject: jest.fn((metadata) => metadata || {}),
}))

jest.mock("../../../../../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))
jest.mock("../../../../../../../../lib/gp-institutional-checkout", () => ({
  institutionalCheckoutAuthority: jest.fn(),
  institutionalDollarsToCents: jest.requireActual("../../../../../../../../lib/gp-institutional-checkout").institutionalDollarsToCents,
  reserveInstitutionalCheckout: jest.fn(),
}))
jest.mock("../../../../../../../../lib/gp-institutional-release-intent", () => ({
  institutionalReleaseIntent: jest.fn(() => ({ status: "prepared", requestKey: "invoice_ar:order_123" })),
  persistInstitutionalReleaseIntent: jest.fn(async () => undefined),
  reconcileInstitutionalReleaseIntent: jest.fn(async () => ({ status: "applied" })),
}))

import { POST } from "../route"

function makeRes() {
  return {
    status: jest.fn(function status(this: any) {
      return this
    }),
    json: jest.fn(),
  } as any
}

function makeScope() {
  const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() }
  const query = {
    graph: jest.fn(async () => ({
      data: [{ id: "order_123", metadata: {} }],
    })),
  }
  const auditInsert = jest.fn(async () => undefined)
  const db: any = jest.fn(() => ({ insert: auditInsert }))
  const trx: any = jest.fn(() => ({
    where: () => ({ whereNull: () => ({ first: async () => ({ status: "packed_pending_review" }) }) }),
  }))
  trx.raw = jest.fn(async () => ({ rows: [] }))
  db.transaction = jest.fn(async (run) => run(trx))
  const orderModule = {
    updateOrders: jest.fn(async () => undefined),
  }
  const eventBus = { emit: jest.fn(async () => undefined) }
  const scope = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.QUERY) return query
      if (key === ContainerRegistrationKeys.LOGGER) return logger
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
      if (key === Modules.ORDER) return orderModule
      if (key === Modules.EVENT_BUS) return eventBus
      throw new Error(`Unknown dependency ${key}`)
    },
  }

  return { auditInsert, db, trx, eventBus, logger, orderModule, query, scope }
}

describe("approve finalization route", () => {
  const priorInstitutionalFlag = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsInvoiceOrder.mockReturnValue(false)
    delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  })
  afterAll(() => {
    if (priorInstitutionalFlag === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
    else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = priorInstitutionalFlag
  })

  it("passes finalized lines and shipper packages into the A/R envelope without starting a charge", async () => {
    mockIsInvoiceOrder.mockReturnValue(true)
    mockApproveFinalization.mockResolvedValueOnce({
      finalization: {
        id: "fin_123",
        status: "released_to_fulfillment",
        final_order_total: 143.42,
      },
      totals: { final_order_total: 143.42, delta_total: 13.42 },
      lines: [
        {
          line_item_id: "ordli_1",
          actual_weight_total: 4.12,
          final_line_subtotal: 61.76,
        },
      ],
      packages: [
        {
          package_type: "Polystyrene Container 24x17x13",
          shipper_qbd_list_id: "SHIPPER-LIST-ID",
        },
      ],
    })
    const { eventBus, orderModule, scope } = makeScope()
    const req = {
      auth_context: { actor_id: "user_123" },
      body: { staff_actor_customer_id: "cust_staff" },
      params: { id: "order_123" },
      scope,
    } as any
    const res = makeRes()

    await POST(req, res)

    expect(mockInvoiceArOrderMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        order: expect.objectContaining({ id: "order_123" }),
        finalization: expect.objectContaining({ id: "fin_123" }),
        lines: [
          expect.objectContaining({
            line_item_id: "ordli_1",
            actual_weight_total: 4.12,
            final_line_subtotal: 61.76,
          }),
        ],
        packages: [
          expect.objectContaining({
            shipper_qbd_list_id: "SHIPPER-LIST-ID",
          }),
        ],
      })
    )
    expect(orderModule.updateOrders).toHaveBeenCalledWith("order_123", {
      metadata: expect.objectContaining({
        payment_workflow: "invoice_ar",
        catch_weight_final_lines: [{ line_item_id: "ordli_1" }],
        catch_weight_packages: [{ shipper_qbd_list_id: "SHIPPER-LIST-ID" }],
      }),
    })
    // Invoice approval releases to A/R. It never emits the card auto-charge event.
    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it.each([false, true])("only triggers the optional auto-charge for a verified charge grant: %s", async charge => {
    mockApproveFinalization.mockResolvedValueOnce({ finalization: { id: "fin_123", status: "packed_pending_charge" }, totals: {}, lines: [], packages: [] })
    const { eventBus, scope } = makeScope()
    const res = makeRes()
    await POST({ params: { id: "order_123" }, body: {}, scope,
      gp_staff_principal: { id: "cus_packer", kind: "customer", capabilities: new Set(charge ? ["charge"] : []) } } as any, res)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(eventBus.emit).toHaveBeenCalledTimes(charge ? 1 : 0)
  })

  it("alerts when approval fails after the order is loaded", async () => {
    mockApproveFinalization.mockRejectedValueOnce(
      new Error("finalization preview is stale")
    )
    const { logger, scope } = makeScope()
    const req = {
      auth_context: { actor_id: "user_123" },
      body: { staff_actor_customer_id: "cust_staff" },
      params: { id: "order_123" },
      scope,
    } as any
    const res = makeRes()

    await POST(req, res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      message: "finalization preview is stale",
    })
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "catch_weight_finalization_route_failed",
        severity: "page",
        title: "Catch-weight finalization route failed: approve_finalization",
        path: "src/api/admin/grillers/orders/[id]/finalization/approve/route.ts",
        logger,
        meta: expect.objectContaining({
          action: "approve_finalization",
          order_id: "order_123",
          route_status: 409,
          error_message: "finalization preview is stale",
        }),
      })
    )
  })
it("holds a flagged invoice before release when its source is stale", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  mockIsInvoiceOrder.mockReturnValue(true)
  ;(institutionalCheckoutAuthority as jest.Mock).mockResolvedValueOnce({ status: "hold", reason: "stale_source" })
  const { scope, query, orderModule, auditInsert, db } = makeScope()
  query.graph.mockResolvedValueOnce({ data: [{
    id: "order_123", cart_id: "cart_123", customer_id: "cus_123",
    metadata: { gp_institutional_commitment_id: "cart:cart_123" },
  }] } as any)
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {
    institutional_override_reason: "staff_clicked_release",
  } } as any, res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(mockApproveFinalization).not.toHaveBeenCalled()
  expect(reserveInstitutionalCheckout).not.toHaveBeenCalled()
  expect(orderModule.updateOrders).not.toHaveBeenCalled()
  expect(db).toHaveBeenCalledWith("gp_institutional_override_attempt")
  expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({
    order_id: "order_123", reason_code: "staff_clicked_release",
    authority_reason: "stale_source", named_capability: null, decision: "denied",
  }))
})

it("keeps release denied and pages when the denied-attempt audit cannot be stored", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  mockIsInvoiceOrder.mockReturnValue(true)
  ;(institutionalCheckoutAuthority as jest.Mock).mockResolvedValueOnce({
    status: "hold", reason: "credit_limit_exceeded",
  })
  const { scope, query, auditInsert } = makeScope()
  auditInsert.mockRejectedValueOnce(new Error("audit table unavailable"))
  query.graph.mockResolvedValueOnce({ data: [{
    id: "order_123", cart_id: "cart_123", customer_id: "cus_123",
    metadata: { gp_institutional_commitment_id: "cart:cart_123" },
  }] } as any)
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(503)
  expect(mockApproveFinalization).not.toHaveBeenCalled()
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
    severity: "page",
    meta: expect.objectContaining({ action: "institutional_denied_release_audit_failed" }),
  }))
})

it("audits an over-limit release attempt after its credit transaction is denied", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  mockIsInvoiceOrder.mockReturnValue(true)
  ;(institutionalCheckoutAuthority as jest.Mock).mockResolvedValueOnce({
    status: "allow", account: {
      companyKey: "TEST_SHA", customerListId: "TEST_LIST", creditLimitCents: 100000,
      invoices: [],
    },
  })
  ;(previewFinalization as jest.Mock).mockResolvedValueOnce({
    errors: [], totals: { final_order_total: 500 },
  })
  ;(reserveInstitutionalCheckout as jest.Mock).mockResolvedValueOnce({
    status: "hold", reason: "credit_limit_exceeded", projectedCents: 105000,
  })
  const { scope, query, auditInsert } = makeScope()
  query.graph.mockResolvedValueOnce({ data: [{
    id: "order_123", cart_id: "cart_123", customer_id: "cus_123",
    metadata: { gp_institutional_commitment_id: "cart:cart_123" },
  }] } as any)
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(mockApproveFinalization).not.toHaveBeenCalled()
  expect(auditInsert).toHaveBeenCalledWith(expect.objectContaining({
    authority_reason: "credit_limit_exceeded", decision: "denied",
  }))
})

it("reserves the packed invoice total in the approval transaction before A/R release", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  mockIsInvoiceOrder.mockReturnValue(true)
  const account = { companyKey: "TEST_SHA", customerListId: "TEST_LIST", creditLimitCents: 100000, invoices: [] }
  ;(institutionalCheckoutAuthority as jest.Mock).mockResolvedValueOnce({ status: "allow", account })
  ;(reserveInstitutionalCheckout as jest.Mock).mockResolvedValueOnce({ status: "reserved", projectedCents: 50000 })
  ;(previewFinalization as jest.Mock).mockResolvedValueOnce({ errors: [], totals: { final_order_total: 500 } })
  mockApproveFinalization.mockResolvedValueOnce({
    finalization: { id: "fin_123", status: "released_to_fulfillment" },
    totals: { final_order_total: 500, delta_total: 50 }, lines: [], packages: [],
  })
  const { scope, query, db, trx, orderModule } = makeScope()
  let transactionCommitted = false
  db.transaction.mockImplementationOnce(async (run: any) => {
    const result = await run(trx)
    transactionCommitted = true
    return result
  })
  ;(reconcileInstitutionalReleaseIntent as jest.Mock).mockImplementationOnce(async () => {
    expect(transactionCommitted).toBe(true)
    return { status: "applied" }
  })
  query.graph.mockResolvedValueOnce({ data: [{
    id: "order_123", cart_id: "cart_123", customer_id: "cus_123",
    metadata: { gp_institutional_commitment_id: "cart:cart_123" },
  }] } as any)
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {} } as any, res)
  expect(reserveInstitutionalCheckout).toHaveBeenCalledWith(expect.objectContaining({
    account, reservationId: "cart:cart_123", amountCents: 50000, transaction: trx,
  }))
  expect(mockApproveFinalization).toHaveBeenCalledTimes(1)
  expect(persistInstitutionalReleaseIntent).toHaveBeenCalledWith(
    trx, "fin_123", expect.objectContaining({ requestKey: "invoice_ar:order_123" })
  )
  expect(reconcileInstitutionalReleaseIntent).toHaveBeenCalledWith(
    expect.objectContaining({ orderId: "order_123" })
  )
  expect(orderModule.updateOrders).not.toHaveBeenCalled()
  expect(res.status).toHaveBeenCalledWith(200)
})

it("rolls back approval when the packed total differs from the reserved amount", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  mockIsInvoiceOrder.mockReturnValue(true)
  ;(institutionalCheckoutAuthority as jest.Mock).mockResolvedValueOnce({ status: "allow", account: {
    companyKey: "TEST_SHA", customerListId: "TEST_LIST", creditLimitCents: 100000, invoices: [],
  } })
  ;(reserveInstitutionalCheckout as jest.Mock).mockResolvedValueOnce({ status: "reserved" })
  ;(previewFinalization as jest.Mock).mockResolvedValueOnce({ errors: [], totals: { final_order_total: 500 } })
  mockApproveFinalization.mockResolvedValueOnce({
    finalization: { id: "fin_123", status: "released_to_fulfillment" },
    totals: { final_order_total: 501 }, lines: [], packages: [],
  })
  const { scope, query, orderModule } = makeScope()
  query.graph.mockResolvedValueOnce({ data: [{
    id: "order_123", cart_id: "cart_123", customer_id: "cus_123",
    metadata: { gp_institutional_commitment_id: "cart:cart_123" },
  }] } as any)
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(orderModule.updateOrders).not.toHaveBeenCalled()
})
})

it("holds an invoice shipment before approval and A/R release when pricing is incomplete", async () => {
  mockIsInvoiceOrder.mockReturnValue(true)
  mockApproveFinalization.mockClear()
  const { scope, query, orderModule } = makeScope()
  query.graph.mockResolvedValueOnce({
    data: [{ id: "order_123", metadata: {}, package_capture_required: true }],
  } as any)
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(mockApproveFinalization).not.toHaveBeenCalled()
  expect(orderModule.updateOrders).not.toHaveBeenCalled()
})

it("preserves the accepted shipping cost in the released invoice metadata", async () => {
  mockIsInvoiceOrder.mockReturnValue(true)
  mockShippingQuote.mockResolvedValueOnce({ status: "quoted", metadata: { shipping_cost_actual: 18.75 } } as any)
  mockApproveFinalization.mockResolvedValueOnce({
    finalization: { id: "fin_123", status: "released_to_fulfillment" },
    totals: {}, lines: [], packages: [],
  })
  const { scope, query, orderModule, eventBus } = makeScope()
  query.graph.mockResolvedValueOnce({
    data: [{ id: "order_123", metadata: { shipping_quote_revision: "accepted-1" }, package_capture_required: true }],
  } as any)
  const res = makeRes()
  await POST({ scope, params: { id: "order_123" }, body: {} } as any, res)
  expect(res.status).toHaveBeenCalledWith(200)
  expect(orderModule.updateOrders).toHaveBeenCalledWith("order_123", {
    metadata: expect.objectContaining({
      shipping_cost_actual: 18.75,
      shipping_quote_revision: "accepted-1",
      payment_workflow: "invoice_ar",
    }),
  })
  expect(eventBus.emit).not.toHaveBeenCalled()
})
