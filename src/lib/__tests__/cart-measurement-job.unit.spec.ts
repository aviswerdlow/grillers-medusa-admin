import job from "../../jobs/gp-cart-measurement"
import { deliverCartMeasurements } from "../cart-measurement"
import {
  cartRecoveryAllowed,
  projectNativeCartActivity,
} from "../communications/cart-lifecycle"
import { evaluateFlowsForEvent } from "../communications/flows"
import { emitOpsAlert } from "../ops-alert"
const mockDeliver = jest.fn(),
  mockRoute = jest.fn()
jest.mock("../../modules/gp-analytics/service", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    deliverCartMeasurement: mockDeliver,
    publicationRehearsalRoute: mockRoute,
  })),
}))
jest.mock("../cart-measurement", () => ({
  ...jest.requireActual("../cart-measurement"),
  deliverCartMeasurements: jest.fn(),
}))
jest.mock("../communications/cart-lifecycle", () => ({
  cartRecoveryAllowed: jest.fn(),
  projectNativeCartActivity: jest.fn(),
}))
jest.mock("../communications/flows", () => ({
  evaluateFlowsForEvent: jest.fn(),
}))
jest.mock("../order-publication-rehearsal", () => ({
  pinRehearsalRoute: jest.fn(async () => true),
}))
jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn() }))
const env = { ...process.env },
  trx = {},
  row = { event_id: "saved", profile_id: "profile" }
const container: any = {
  resolve: (key: string) => (key === "logger" ? { warn: jest.fn() } : {}),
}
const snapshot = (test = false, analytics = true): any => ({
  kind: "activity",
  lane: test ? "rehearsal" : "production",
  event_name: "cart_updated",
  event_id: "native-cart:activity:cart_one:request",
  occurred_at: "2026-09-21T01:00:00Z",
  cart: {
    id: "cart_one",
    customer_id: "cus_one",
    email: "private@example.test",
    item_count: 1,
    value: 0,
  },
  context: {
    analytics_consent: analytics,
    test_order: test,
    analytics_environment: test ? "rehearsal" : "production",
    rehearsal_id: test ? "cart-fixture" : undefined,
    experiment_assignments: [],
    experiment_context_status: "unverified",
  },
})
beforeEach(() => {
  process.env = {
    ...env,
    GP_CART_MEASUREMENT_ENABLED: "true",
    STRIPE_API_KEY: "sk_live_fixture",
  }
  jest.clearAllMocks()
  mockDeliver.mockResolvedValue({ status: "accepted" })
  mockRoute.mockReturnValue({ id: "cart-fixture", hash: "route" })
  ;(projectNativeCartActivity as jest.Mock).mockResolvedValue({
    status: "accepted",
  })
})
afterEach(() => {
  process.env = { ...env }
})
it("does nothing while capture and worker are disabled", async () => {
  delete process.env.GP_CART_MEASUREMENT_ENABLED
  await job(container)
  expect(deliverCartMeasurements).not.toHaveBeenCalled()
})
it("keeps original test activity isolated after live configuration changes and never projects/alerts it", async () => {
  ;(deliverCartMeasurements as jest.Mock).mockImplementation(
    async (_db, deliver) => {
      expect(
        await deliver("native_cart_automation", snapshot(true), row, trx)
      ).toMatchObject({ status: "excluded" })
      expect(
        await deliver("native_cart_jitsu", snapshot(true), row, trx)
      ).toEqual({ status: "accepted" })
      mockRoute.mockReturnValue({ id: "other", hash: "other" })
      expect(
        await deliver("native_cart_gp", snapshot(true), row, trx)
      ).toMatchObject({ status: "held" })
      return { held: 1, retry: 0, production_pending: 0 }
    }
  )
  await job(container)
  expect(mockDeliver.mock.calls[0][0]).toBe("jitsu_rehearsal")
  expect(JSON.stringify(mockDeliver.mock.calls)).not.toContain(
    "private@example.test"
  )
  expect(projectNativeCartActivity).not.toHaveBeenCalled()
  expect(evaluateFlowsForEvent).not.toHaveBeenCalled()
  expect(emitOpsAlert).not.toHaveBeenCalled()
})
it("keeps operational projection independent of analytics choice and refuses stale/unapproved recovery", async () => {
  ;(deliverCartMeasurements as jest.Mock).mockImplementation(
    async (_db, deliver) => {
      expect(
        await deliver("native_cart_jitsu", snapshot(false, false), row, trx)
      ).toMatchObject({ status: "excluded" })
      expect(
        await deliver(
          "native_cart_automation",
          snapshot(false, false),
          row,
          trx
        )
      ).toEqual({ status: "accepted" })
      const expired = { ...snapshot(), kind: "expired" }
      ;(cartRecoveryAllowed as jest.Mock)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
      expect(
        await deliver("native_cart_automation", expired, row, trx)
      ).toMatchObject({ status: "excluded" })
      expect(
        await deliver("native_cart_automation", expired, row, trx)
      ).toEqual({ status: "accepted" })
      return { held: 0, retry: 0, production_pending: 0 }
    }
  )
  await job(container)
  expect(projectNativeCartActivity).toHaveBeenCalledWith(
    trx,
    expect.anything(),
    row
  )
  expect(evaluateFlowsForEvent).toHaveBeenCalledTimes(1)
  expect(evaluateFlowsForEvent).toHaveBeenCalledWith(trx, row)
  expect(mockDeliver).not.toHaveBeenCalled()
})
