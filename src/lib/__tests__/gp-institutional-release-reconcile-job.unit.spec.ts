import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { reconcileInstitutionalReleaseIntent } from "../gp-institutional-release-intent"
import { reconcileInstitutionalPostingHandoff } from "../gp-institutional-posting-handoff"
import { quarantineStaleInstitutionalReservations } from "../gp-institutional-stale-reservations"
import { emitOpsAlert } from "../ops-alert"
import run from "../../jobs/gp-institutional-release-reconcile"

jest.mock("../gp-institutional-release-intent", () => ({
  reconcileInstitutionalReleaseIntent: jest.fn(),
}))
jest.mock("../gp-institutional-posting-handoff", () => ({
  reconcileInstitutionalPostingHandoff: jest.fn(),
}))
jest.mock("../gp-institutional-stale-reservations", () => ({
  quarantineStaleInstitutionalReservations: jest.fn(),
}))
jest.mock("../ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true })),
}))

const prior = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
afterAll(() => {
  if (prior === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = prior
})
beforeEach(() => {
  jest.clearAllMocks()
  ;(quarantineStaleInstitutionalReservations as jest.Mock).mockResolvedValue(0)
})

function container(rows = [{ order_id: "order_fixture" }], dueRows: Array<Record<string, string>> = []) {
  const scan: any = {
    select: () => scan,
    where: () => scan,
    whereNull: () => scan,
    whereRaw: () => scan,
    orderBy: () => scan,
    limit: async () => rows,
    update: jest.fn(async () => 1),
  }
  const db = Object.assign(jest.fn(() => scan), {
    raw: jest.fn(async () => ({ rows: dueRows })),
  })
  const orderModule = { retrieveOrder: jest.fn(async (id: string) => ({ id })) }
  const logger = { error: jest.fn(), warn: jest.fn() }
  const resolve = jest.fn((key: string) => {
    if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
    if (key === Modules.ORDER) return orderModule
    if (key === ContainerRegistrationKeys.LOGGER) return logger
    throw new Error(`Unexpected service ${key}`)
  })
  return { db, resolve, orderModule, logger, scan }
}

it("does no reconciliation or database read while the feature is off", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const fixture = container()
  await run({ resolve: fixture.resolve } as any)
  expect(fixture.resolve).not.toHaveBeenCalled()
  expect(reconcileInstitutionalReleaseIntent).not.toHaveBeenCalled()
  expect(quarantineStaleInstitutionalReservations).not.toHaveBeenCalled()
})

it("polls posted institutional orders and binds exact QBD invoice evidence", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  const fixture = container([], [{ order_id: "TEST_ORDER_C", commitment_id: "gpic_test_c" }])
  ;(reconcileInstitutionalPostingHandoff as jest.Mock).mockResolvedValue({
    status: "posted", invoiceTxnId: "TEST_INVOICE_C",
  })
  await run({ resolve: fixture.resolve } as any)
  expect(fixture.orderModule.retrieveOrder).toHaveBeenCalledWith("TEST_ORDER_C", {
    select: ["id", "cart_id", "customer_id", "metadata"],
  })
  expect(reconcileInstitutionalPostingHandoff).toHaveBeenCalledWith({
    db: fixture.db, order: { id: "TEST_ORDER_C" },
  })
  expect(fixture.scan.update).toHaveBeenCalledWith({ updated_at: expect.any(Date) })
  expect(quarantineStaleInstitutionalReservations).toHaveBeenCalledWith(fixture.db)
})

it("pages once with a count when stale unlinked reservations are quarantined", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  ;(quarantineStaleInstitutionalReservations as jest.Mock).mockResolvedValue(2)
  const fixture = container([])
  await run({ resolve: fixture.resolve } as any)
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
    alertKind: "institutional_checkout_reservation_quarantined",
    severity: "page",
    meta: { quarantined_count: 2 },
  }))
})

it("pages when reservation reconciliation cannot read its source", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  ;(quarantineStaleInstitutionalReservations as jest.Mock).mockRejectedValue(new Error("source unavailable"))
  const fixture = container([])
  await run({ resolve: fixture.resolve } as any)
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
    alertKind: "institutional_checkout_reservation_reconciliation_failed",
    severity: "page",
  }))
  expect(fixture.logger.error).toHaveBeenCalled()
})

it("reconciles prepared intents and pages on an unresolved outcome", async () => {
  process.env.GP_INSTITUTIONAL_TERMS_ENABLED = "true"
  ;(reconcileInstitutionalReleaseIntent as jest.Mock).mockResolvedValue({
    status: "pending", reason: "order_update_unconfirmed",
  })
  const fixture = container()
  await run({ resolve: fixture.resolve } as any)
  expect(reconcileInstitutionalReleaseIntent).toHaveBeenCalledWith({
    db: fixture.db, orderModule: fixture.orderModule, orderId: "order_fixture",
  })
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
    alertKind: "institutional_release_reconciliation_hold", severity: "page",
  }))
})
