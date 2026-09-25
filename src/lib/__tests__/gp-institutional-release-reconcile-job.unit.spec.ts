import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { reconcileInstitutionalReleaseIntent } from "../gp-institutional-release-intent"
import { emitOpsAlert } from "../ops-alert"
import run from "../../jobs/gp-institutional-release-reconcile"

jest.mock("../gp-institutional-release-intent", () => ({
  reconcileInstitutionalReleaseIntent: jest.fn(),
}))
jest.mock("../ops-alert", () => ({
  emitOpsAlert: jest.fn(async () => ({ ok: true })),
}))

const prior = process.env.GP_INSTITUTIONAL_TERMS_ENABLED
afterAll(() => {
  if (prior === undefined) delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  else process.env.GP_INSTITUTIONAL_TERMS_ENABLED = prior
})
beforeEach(() => { jest.clearAllMocks() })

function container(rows = [{ order_id: "order_fixture" }]) {
  const scan: any = {
    select: () => scan,
    whereNull: () => scan,
    whereRaw: () => scan,
    orderBy: () => scan,
    limit: async () => rows,
  }
  const db = jest.fn(() => scan)
  const orderModule = {}
  const logger = { error: jest.fn(), warn: jest.fn() }
  const resolve = jest.fn((key: string) => {
    if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
    if (key === Modules.ORDER) return orderModule
    if (key === ContainerRegistrationKeys.LOGGER) return logger
    throw new Error(`Unexpected service ${key}`)
  })
  return { db, resolve, orderModule, logger }
}

it("does no reconciliation or database read while the feature is off", async () => {
  delete process.env.GP_INSTITUTIONAL_TERMS_ENABLED
  const fixture = container()
  await run({ resolve: fixture.resolve } as any)
  expect(fixture.resolve).not.toHaveBeenCalled()
  expect(reconcileInstitutionalReleaseIntent).not.toHaveBeenCalled()
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
