import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { refreshSegmentMembership } from "../communications/admin"
import { enrollCalendarAnchoredFlows, runDueFlowEnrollments } from "../communications/flows"
import { refreshMaterializedSegment, segmentDefinitionHash } from "../communications/segment-membership"
import { emitCommunicationsAudienceHoldAlert } from "../communications-job-alerts"
import { emitOpsAlert } from "../ops-alert"
import gpCommunicationsAudiences from "../../jobs/gp-communications-audiences"
import refreshCommunicationAudiences from "../../scripts/refresh-communication-audiences"

jest.mock("../ops-alert", () => ({ emitOpsAlert: jest.fn().mockResolvedValue({ ok: true }) }))
jest.mock("../communications/flows", () => ({
  seedCommunicationDefaults: jest.fn(),
  enrollCalendarAnchoredFlows: jest.fn(),
  runDueFlowEnrollments: jest.fn(),
}))
jest.mock("../communications/segments", () => ({
  seedGpSegmentLibrary: jest.fn(),
  isClickHouseSegmentDefinition: jest.fn(),
  clickHouseSegmentProfileIds: jest.fn(),
}))
jest.mock("../communications/segment-membership", () => ({
  ...jest.requireActual("../communications/segment-membership"),
  refreshMaterializedSegment: jest.fn(),
}))

const at = new Date("2026-09-22T01:00:00Z")
function segment(id: string, ageHours = 0) {
  const completed = new Date(at.getTime() - ageHours * 3600000)
  return {
    id, status: "active", cached_count: 0, last_computed_at: completed,
    query_definition: {},
    metadata: { membership_refresh_v1: {
      status: "available", completed_at: completed.toISOString(),
      refresh_id: "fixture", member_set_hash: "fixture", member_count: 0,
      definition_hash: segmentDefinitionHash({}),
    } },
  }
}
function fixture(rows: any[]) {
  const query: any = { where: jest.fn().mockReturnThis(), whereNull: jest.fn().mockReturnThis(), select: jest.fn().mockResolvedValue(rows) }
  const db = jest.fn((table: string) => {
    if (table !== "gp_segment") throw new Error(`Unexpected table ${table}`)
    return query
  })
  const logger = { warn: jest.fn(), error: jest.fn(), info: jest.fn() }
  const container: any = { resolve: jest.fn((key: string) => {
    if (key === ContainerRegistrationKeys.PG_CONNECTION) return db
    if (key === "logger") return logger
    throw new Error(`No provider access allowed: ${key}`)
  }) }
  return { container, logger }
}
beforeEach(async () => {
  jest.useFakeTimers().setSystemTime(at)
  jest.clearAllMocks()
  ;(emitOpsAlert as jest.Mock).mockResolvedValue({ ok: true })
  ;(refreshMaterializedSegment as jest.Mock).mockResolvedValue({ status: "available", member_count: 0 })
  for (const stage of ["refresh", "calendar"] as const)
    await emitCommunicationsAudienceHoldAlert({ stage, unavailable: 0, evaluated: 0 })
})
afterEach(() => jest.useRealTimers())

it("retries missing/failed/changed/six-hour audiences and skips a recent complete receipt", async () => {
  const missing = { ...segment("missing"), metadata: {} }
  const failed = segment("failed")
  failed.metadata.membership_refresh_v1.status = "unavailable"
  const changed = { ...segment("changed"), query_definition: { total_orders: 3 } }
  const { container } = fixture([segment("recent", 5), segment("due", 6), missing, failed, changed])
  expect(await refreshSegmentMembership(container, { onlyDue: true })).toEqual({
    refreshed: 4, unavailable: 0, skipped: 1, active_members: 0,
  })
  expect((refreshMaterializedSegment as jest.Mock).mock.calls.map((call) => call[1])).toEqual(["due", "missing", "failed", "changed"])
  expect(emitOpsAlert).not.toHaveBeenCalled()
})

it("alerts on a failed refresh result even though the query wrapper did not throw", async () => {
  ;(refreshMaterializedSegment as jest.Mock).mockResolvedValue({ status: "unavailable", member_count: 0 })
  const { container, logger } = fixture([segment("failed")])
  expect((await refreshSegmentMembership(container)).unavailable).toBe(1)
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
    alertKind: "communications_audience_held", severity: "warn",
    meta: { stage: "refresh", unavailable: 1, evaluated: 1, suppressed_since_last_alert: 0 },
  }))
  expect(logger.warn).toHaveBeenCalled()
})

it("the retry job can refresh membership without provider access, flow enrollment or sending", async () => {
  const { container } = fixture([{ ...segment("first"), metadata: {} }])
  await gpCommunicationsAudiences(container)
  expect(refreshMaterializedSegment).toHaveBeenCalledTimes(1)
  expect(enrollCalendarAnchoredFlows).not.toHaveBeenCalled()
  expect(runDueFlowEnrollments).not.toHaveBeenCalled()
  expect(container.resolve.mock.calls.map((call: any[]) => call[0])).toEqual(expect.arrayContaining(["logger", ContainerRegistrationKeys.PG_CONNECTION]))
})

it("the release warm-up reports failure and never uses the sending maintenance path", async () => {
  ;(refreshMaterializedSegment as jest.Mock).mockResolvedValue({ status: "unavailable", member_count: 0 })
  const { container } = fixture([segment("failed")])
  await expect(refreshCommunicationAudiences({ container } as any)).rejects.toThrow("sending stays held")
  expect(enrollCalendarAnchoredFlows).not.toHaveBeenCalled()
  expect(runDueFlowEnrollments).not.toHaveBeenCalled()
})

it("surfaces a storage failure through the retry job without treating it as an empty success", async () => {
  ;(refreshMaterializedSegment as jest.Mock).mockRejectedValue(new Error("receipt storage unavailable"))
  const { container } = fixture([{ ...segment("failed"), metadata: {} }])
  await expect(gpCommunicationsAudiences(container)).rejects.toThrow("receipt storage unavailable")
  expect(emitOpsAlert).toHaveBeenCalledWith(expect.objectContaining({
    alertKind: "communications_scheduled_job_failed",
    meta: expect.objectContaining({ job_name: "gp-communications-audiences" }),
  }))
})

it("coalesces repeated holds for fifteen minutes and reports the suppressed count", async () => {
  const input = { stage: "calendar" as const, unavailable: 2, evaluated: 3 }
  await emitCommunicationsAudienceHoldAlert(input)
  await emitCommunicationsAudienceHoldAlert(input)
  expect(emitOpsAlert).toHaveBeenCalledTimes(1)
  jest.advanceTimersByTime(15 * 60 * 1000)
  await emitCommunicationsAudienceHoldAlert(input)
  expect(emitOpsAlert).toHaveBeenLastCalledWith(expect.objectContaining({
    meta: expect.objectContaining({ suppressed_since_last_alert: 1 }),
  }))
  await emitCommunicationsAudienceHoldAlert({ ...input, unavailable: 0 })
  await emitCommunicationsAudienceHoldAlert(input)
  expect(emitOpsAlert).toHaveBeenCalledTimes(3)
})

it("keeps an audience unavailable when the alert sink fails", async () => {
  ;(emitOpsAlert as jest.Mock).mockRejectedValueOnce(new Error("sink failed"))
  ;(refreshMaterializedSegment as jest.Mock).mockResolvedValue({ status: "unavailable", member_count: 0 })
  const { container, logger } = fixture([segment("failed")])
  expect((await refreshSegmentMembership(container)).unavailable).toBe(1)
  expect(logger.warn).toHaveBeenCalledWith("[communications-audience] hold alert unavailable")
})
