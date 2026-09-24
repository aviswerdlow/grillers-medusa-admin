import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { POST } from "../[id]/refund/route"
import { config as refundIssuedEmailConfig } from "../../../../../subscribers/refund-issued-email"
import { emitOpsAlert } from "../../../../../lib/ops-alert"

jest.mock("../../../../../lib/ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true, skipped: false })),
}))

function makeAllocationDb(rows: any[] = []) {
  const updates: any[] = []
  const inserts: any[] = []
  const db: any = jest.fn((table: string) => {
    const chain: any = {
      select: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereRaw: jest.fn(() => chain),
      forUpdate: jest.fn(() => chain),
      first: jest.fn(async () => table === "order" ? { id: "order_123", status: "pending", canceled_at: null } : undefined),
      limit: jest.fn(() => chain),
      update: jest.fn(async (payload: any) => {
        updates.push({ table, payload })
        return 1
      }),
      insert: jest.fn(async (payload: any) => {
        inserts.push({ table, payload })
        return payload
      }),
      then: (resolve: any) =>
        resolve(table === "gp_inventory_allocation" ? rows : []),
    }

    return chain
  })
  db.transaction = async (work: any) => work(db)

  return { db, updates, inserts }
}

describe("staff payment refund route", () => {
  it("routes refund emails from the payment refunded event", () => {
    expect(refundIssuedEmailConfig.event).toBe("payment.refunded")
  })

  it("emits the Medusa payment refunded event for customer refund emails", async () => {
    const refund = {
      id: "refund_123",
      amount: 5,
      raw_amount: { value: "5" },
      data: { id: "re_123" },
    }
    const paymentModule = {
      retrievePayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [],
      })),
      refundPayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [refund],
      })),
    }
    const orderModule = {
      listOrderTransactions: jest.fn(async () => []),
      addOrderTransactions: jest.fn(async () => undefined),
      retrieveOrder: jest.fn(async () => ({
        id: "order_123",
        metadata: { qbd_existing: "kept" },
      })),
      updateOrders: jest.fn(async () => undefined),
    }
    const eventBus = {
      emit: jest.fn(async () => undefined),
    }
    const query = {
      graph: jest.fn(async () => ({
        data: [{ order_id: "order_123" }],
      })),
    }
    const { db } = makeAllocationDb()
    const req = {
      params: { id: "pay_123" },
      body: { amount: 5, note: "Customer refund test" },
      scope: {
        resolve: (key: string) => {
          if (key === Modules.PAYMENT) return paymentModule
          if (key === Modules.ORDER) return orderModule
          if (key === Modules.EVENT_BUS) return eventBus
          if (key === "query") return query
          if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
          throw new Error(`Unknown dependency ${key}`)
        },
      },
      auth_context: { actor_id: "user_123" },
    } as any
    const res = {
      status: jest.fn(function status() {
        return this
      }),
      json: jest.fn(),
    } as any

    await POST(req, res)

    expect(paymentModule.refundPayment).toHaveBeenCalledWith({
      payment_id: "pay_123",
      amount: 5,
      note: "Customer refund test",
      refund_reason_id: undefined,
      created_by: "user_123",
    })
    expect(orderModule.addOrderTransactions).toHaveBeenCalledWith({
      order_id: "order_123",
      amount: -5,
      currency_code: "usd",
      reference: "refund",
      reference_id: "refund_123",
    })
    expect(orderModule.updateOrders).toHaveBeenCalledWith("order_123", {
      metadata: expect.objectContaining({
        qbd_existing: "kept",
        qbd_posting_required: true,
        qbd_posting_status: "pending_manual",
        qbd_posting_action: "card_refund_accounting_record",
        qbd_posting_amount: 500,
        qbd_posting_request_key: "refund:refund_123",
        stripe_refund_id: "refund_123",
        stripe_provider_refund_id: "re_123",
      }),
    })
    expect(eventBus.emit).toHaveBeenCalledWith({
      name: "payment.refunded",
      data: {
        id: "pay_123",
        payment_id: "pay_123",
        refund_id: "refund_123",
        order_id: "order_123",
        amount: 5,
        reason: "Customer refund test",
      },
    })
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it.each([
    ["snapshotted", { native_reservation_snapshot: { line_quantity: 3, reservations: [] } }, false, false],
    ["legacy", {}, true, false],
    ["invalid snapshot", { native_reservation_snapshot: { line_quantity: 3, reservations: [{ id: "res_missing" }] } }, false, true],
  ])("handles %s allocation state before a line-level refund", async (_kind, metadata, legacy, invalid) => {
    const refund = {
      id: "refund_123",
      amount: 2,
      raw_amount: { value: "2" },
      data: { id: "re_123" },
    }
    const paymentModule = {
      retrievePayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [],
      })),
      refundPayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [refund],
      })),
    }
    const orderModule = {
      listOrderTransactions: jest.fn(async () => []),
      addOrderTransactions: jest.fn(async () => undefined),
      retrieveOrder: jest.fn(async () => ({
        id: "order_123",
        metadata: {},
      })),
      updateOrders: jest.fn(async () => undefined),
    }
    const eventBus = {
      emit: jest.fn(async () => undefined),
    }
    const query = {
      graph: jest.fn(async () => ({
        data: [{ order_id: "order_123" }],
      })),
    }
    const { db, updates, inserts } = makeAllocationDb([
      {
        id: "ialloc_123",
        order_id: "order_123",
        line_item_id: "line_123",
        quantity: 3,
        status: "reserved",
        metadata,
      },
    ])
    const logger = { warn: jest.fn() }
    const req = {
      params: { id: "pay_123" },
      body: {
        amount: 2,
        note: "Partial refund",
        allocation_releases: [
          { order_id: "order_123", line_item_id: "line_123", quantity: 1 },
        ],
      },
      scope: {
        resolve: (key: string) => {
          if (key === Modules.PAYMENT) return paymentModule
          if (key === Modules.ORDER) return orderModule
          if (key === Modules.EVENT_BUS) return eventBus
          if (key === Modules.INVENTORY) return { updateReservationItems: jest.fn(), deleteReservationItemsByLineItem: jest.fn() }
          if (key === Modules.LOCKING) return { execute: async (_keys: string[], work: any) => work() }
          if (key === "query") return query
          if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
          if (key === ContainerRegistrationKeys.LOGGER) return logger
          throw new Error(`Unknown dependency ${key}`)
        },
      },
      auth_context: { actor_id: "user_123" },
    } as any
    const res = {
      status: jest.fn(function status() {
        return this
      }),
      json: jest.fn(),
    } as any

    await POST(req, res)

    if (invalid) {
      expect(paymentModule.refundPayment).not.toHaveBeenCalled()
      expect(res.status).toHaveBeenCalledWith(500)
      return
    }

    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "gp_inventory_allocation",
          payload: expect.objectContaining({
            quantity: 2,
            allocation_reason: "released_refund",
          }),
        }),
      ])
    )
    expect(inserts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "gp_inventory_allocation_audit",
          payload: expect.objectContaining({
            allocation_id: "ialloc_123",
            previous_status: "reserved",
            next_status: "reserved",
            previous_quantity: 3,
            next_quantity: 2,
            reason: "released_refund",
          }),
        }),
      ])
    )
    expect(res.status).toHaveBeenCalledWith(200)
    expect(logger.warn).toHaveBeenCalledTimes(legacy ? 1 : 0)
  })

  it("emits an ops alert when a refund overwrites a pending QBD posting request", async () => {
    const refund = {
      id: "refund_new",
      amount: 5,
      raw_amount: { value: "5" },
      data: { id: "re_new" },
    }
    const paymentModule = {
      retrievePayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [],
      })),
      refundPayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [refund],
      })),
    }
    const orderModule = {
      listOrderTransactions: jest.fn(async () => []),
      addOrderTransactions: jest.fn(async () => undefined),
      retrieveOrder: jest.fn(async () => ({
        id: "order_123",
        metadata: {
          qbd_posting_status: "pending_manual",
          qbd_posting_request_key: "final_charge:pi_existing",
        },
      })),
      updateOrders: jest.fn(async () => undefined),
    }
    const eventBus = {
      emit: jest.fn(async () => undefined),
    }
    const query = {
      graph: jest.fn(async () => ({
        data: [{ order_id: "order_123" }],
      })),
    }
    const logger = { warn: jest.fn(), error: jest.fn() }
    const { db } = makeAllocationDb()
    const req = {
      params: { id: "pay_123" },
      body: { amount: 5, note: "Refund after pending posting" },
      scope: {
        resolve: (key: string) => {
          if (key === Modules.PAYMENT) return paymentModule
          if (key === Modules.ORDER) return orderModule
          if (key === Modules.EVENT_BUS) return eventBus
          if (key === "query") return query
          if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
          if (key === ContainerRegistrationKeys.LOGGER) return logger
          throw new Error(`Unknown dependency ${key}`)
        },
      },
      auth_context: { actor_id: "user_123" },
    } as any
    const res = {
      status: jest.fn(function status() {
        return this
      }),
      json: jest.fn(),
    } as any
    ;(emitOpsAlert as jest.Mock).mockClear()

    await POST(req, res)

    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "qbd_pending_posting_overwritten",
        path: "src/api/admin/grillers/payments/[id]/refund/route.ts",
        meta: expect.objectContaining({
          order_id: "order_123",
          refund_id: "refund_new",
          previous_qbd_posting_request_key: "final_charge:pi_existing",
          next_qbd_posting_request_key: "refund:refund_new",
        }),
      })
    )
  })

  it("alerts when the refund provider rejects before money moves", async () => {
    const paymentModule = {
      retrievePayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [],
      })),
      refundPayment: jest.fn(async () => {
        throw new Error("Stripe rejected re_123 for avi@example.com")
      }),
    }
    const orderModule = {
      listOrderTransactions: jest.fn(),
      addOrderTransactions: jest.fn(),
      retrieveOrder: jest.fn(),
      updateOrders: jest.fn(),
    }
    const eventBus = { emit: jest.fn() }
    const query = { graph: jest.fn() }
    const logger = { warn: jest.fn(), error: jest.fn() }
    const { db } = makeAllocationDb()
    const req = {
      params: { id: "pay_123" },
      body: { amount: 5, note: "Customer refund test" },
      scope: {
        resolve: (key: string) => {
          if (key === Modules.PAYMENT) return paymentModule
          if (key === Modules.ORDER) return orderModule
          if (key === Modules.EVENT_BUS) return eventBus
          if (key === "query") return query
          if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
          if (key === ContainerRegistrationKeys.LOGGER) return logger
          throw new Error(`Unknown dependency ${key}`)
        },
      },
      auth_context: { actor_id: "user_123" },
    } as any
    const res = {
      status: jest.fn(function status() {
        return this
      }),
      json: jest.fn(),
    } as any
    ;(emitOpsAlert as jest.Mock).mockClear()

    await POST(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      message: "Could not refund payment. Please try again.",
    })
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "staff_refund_route_failed",
        severity: "page",
        title: "Staff refund failed during refund_payment",
        path: "src/api/admin/grillers/payments/[id]/refund/route.ts",
        logger,
        meta: expect.objectContaining({
          stage: "refund_payment",
          payment_id: "pay_123",
          order_id: null,
          refund_id: null,
          refund_completed: false,
          allocation_release_count: 0,
          actor_id: "user_123",
          error_message: "Stripe rejected [redacted-id] for [redacted-email]",
        }),
      })
    )
  })

  it("warns staff not to retry when follow-up recording fails after refund", async () => {
    const refund = {
      id: "refund_123",
      amount: 5,
      raw_amount: { value: "5" },
      data: { id: "re_123" },
    }
    const paymentModule = {
      retrievePayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [],
      })),
      refundPayment: jest.fn(async () => ({
        id: "pay_123",
        payment_collection_id: "paycol_123",
        currency_code: "usd",
        refunds: [refund],
      })),
    }
    const orderModule = {
      listOrderTransactions: jest.fn(async () => []),
      addOrderTransactions: jest.fn(async () => {
        throw new Error("ledger write failed for refund_123")
      }),
      retrieveOrder: jest.fn(),
      updateOrders: jest.fn(),
    }
    const eventBus = { emit: jest.fn() }
    const query = {
      graph: jest.fn(async () => ({
        data: [{ order_id: "order_123" }],
      })),
    }
    const logger = { warn: jest.fn(), error: jest.fn() }
    const { db } = makeAllocationDb()
    const req = {
      params: { id: "pay_123" },
      body: { amount: 5, note: "Customer refund test" },
      scope: {
        resolve: (key: string) => {
          if (key === Modules.PAYMENT) return paymentModule
          if (key === Modules.ORDER) return orderModule
          if (key === Modules.EVENT_BUS) return eventBus
          if (key === "query") return query
          if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
          if (key === ContainerRegistrationKeys.LOGGER) return logger
          throw new Error(`Unknown dependency ${key}`)
        },
      },
      auth_context: { actor_id: "user_123" },
    } as any
    const res = {
      status: jest.fn(function status() {
        return this
      }),
      json: jest.fn(),
    } as any
    ;(emitOpsAlert as jest.Mock).mockClear()

    await POST(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({
      message:
        "Refund was issued, but follow-up recording failed. Do not retry until support checks the order.",
    })
    expect(eventBus.emit).not.toHaveBeenCalled()
    expect(emitOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        alertKind: "staff_refund_route_failed",
        severity: "page",
        title: "Staff refund failed during record_order_transaction",
        path: "src/api/admin/grillers/payments/[id]/refund/route.ts",
        logger,
        meta: expect.objectContaining({
          stage: "record_order_transaction",
          payment_id: "pay_123",
          order_id: "order_123",
          refund_id: "refund_123",
          refund_completed: true,
          allocation_release_count: 0,
          actor_id: "user_123",
          error_message: "ledger write failed for [redacted-id]",
        }),
      })
    )
  })
})
