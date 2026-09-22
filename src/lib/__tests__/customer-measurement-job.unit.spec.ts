import job from "../../jobs/gp-customer-measurement"
import { deliverCustomerMeasurements } from "../customer-measurement"
import { evaluateFlowsForEvent } from "../communications/flows"
import { emitOpsAlert } from "../ops-alert"
const mockDeliver = jest.fn()
const mockRoute = jest.fn()
jest.mock("../../modules/gp-analytics/service", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    deliverCustomerMeasurement: mockDeliver,
    publicationRehearsalRoute: mockRoute,
  })),
}))
jest.mock("../customer-measurement", () => ({
  deliverCustomerMeasurements: jest.fn(),
}))
jest.mock("../communications/flows", () => ({
  evaluateFlowsForEvent: jest.fn(),
}))
jest.mock("../order-publication-rehearsal", () => ({
  pinRehearsalRoute: jest.fn(async () => true),
}))
jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn() }))
const env = { ...process.env },
  logger = { warn: jest.fn() },
  trx = {}
const container = {
  resolve: (k: string) => (k === "logger" ? logger : {}),
} as any
const snapshot = (test: boolean) => ({
  event_name: "customer_updated",
  event_id: "native-customer:updated:cus_one:tx",
  customer_id: "cus_one",
  occurred_at: "2026-09-21T01:00:00Z",
  context: {
    test_order: test,
    analytics_consent: true,
    analytics_environment: test ? "rehearsal" : "production",
    rehearsal_id: test ? "launch-fixture" : undefined,
  },
})
beforeEach(() => {
  process.env = {
    ...env,
    GP_CUSTOMER_MEASUREMENT_ENABLED: "true",
    STRIPE_API_KEY: "sk_live_fixture",
  }
  jest.clearAllMocks()
  mockDeliver.mockResolvedValue({ status: "accepted" })
  mockRoute.mockReturnValue({ id: "launch-fixture", hash: "route" })
})
afterEach(() => {
  process.env = { ...env }
})
it("does nothing until explicitly activated", async () => {
  delete process.env.GP_CUSTOMER_MEASUREMENT_ENABLED
  await job(container)
  expect(deliverCustomerMeasurements).not.toHaveBeenCalled()
})
it("never enrolls a test event and retains its original rehearsal destination on a live server", async () => {
  ;(deliverCustomerMeasurements as jest.Mock).mockImplementation(
    async (_db, deliver) => {
      expect(
        await deliver("native_customer_automation", snapshot(true), {}, trx)
      ).toEqual({ status: "excluded", reason: "test_customer_event" })
      expect(
        await deliver("native_customer_jitsu", snapshot(true), {}, trx)
      ).toEqual({ status: "accepted" })
      mockRoute.mockReturnValue({ id: "other-run", hash: "other" })
      expect(
        await deliver("native_customer_gp", snapshot(true), {}, trx)
      ).toMatchObject({ status: "held" })
      return { held: 1, retry: 0, production_pending: 0 }
    }
  )
  await job(container)
  expect(evaluateFlowsForEvent).not.toHaveBeenCalled()
  expect(mockDeliver).toHaveBeenCalledWith(
    "jitsu_rehearsal",
    expect.objectContaining({
      actor_id: "cus_one",
      properties: expect.objectContaining({
        test_order: true,
        rehearsal_id: "launch-fixture",
      }),
    })
  )
  expect(emitOpsAlert).not.toHaveBeenCalled()
})
it("runs production flow enrollment with the saved source in the receipt transaction", async () => {
  const row = { event_id: "saved-event", profile_id: "profile-one" }
  ;(deliverCustomerMeasurements as jest.Mock).mockImplementation(
    async (_db, deliver) => {
      expect(
        await deliver("native_customer_automation", snapshot(false), row, trx)
      ).toEqual({ status: "accepted" })
      return { held: 0, retry: 0, production_pending: 0 }
    }
  )
  await job(container)
  expect(evaluateFlowsForEvent).toHaveBeenCalledWith(trx, row)
})
