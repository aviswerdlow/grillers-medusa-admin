import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../../../../../../../../lib/ops-alert"

const mockApproveFinalization = jest.fn()
const mockInvoiceArOrderMetadata = jest.fn((_input: any) => ({
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
  invoiceArOrderMetadata: (input: any) => mockInvoiceArOrderMetadata(input),
  isInvoiceOrder: (order: any) => mockIsInvoiceOrder(order),
  metadataObject: jest.fn((metadata) => metadata || {}),
}))

jest.mock("../../../../../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
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
  const db = jest.fn()
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

  return { db, eventBus, logger, orderModule, query, scope }
}

describe("approve finalization route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsInvoiceOrder.mockReturnValue(false)
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
        catch_weight_packages: [
          { shipper_qbd_list_id: "SHIPPER-LIST-ID" },
        ],
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
})
