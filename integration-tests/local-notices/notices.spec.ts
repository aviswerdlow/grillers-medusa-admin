import { applyMigration, withMigrationFixture } from "../migration-fixture"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { sendTrackedEmail } from "../../src/lib/communications/core"
import { emitOpsAlert } from "../../src/lib/ops-alert"
import { runLocalMilestoneNotices } from "../../src/lib/local-milestone-notices"
import { Migration20260924230000 } from "../../src/modules/gp-communications/migrations/Migration20260924230000"

jest.mock("../../src/lib/communications/core", () => ({
  sendTrackedEmail: jest.fn(async () => ({ ok: true, messageId: "pm_fixture" })),
  recordCommunicationEvent: jest.fn(async () => ({})),
}))
jest.mock("../../src/lib/ops-alert", () => ({ emitOpsAlert: jest.fn(async () => ({ ok: true })) }))

const sender = sendTrackedEmail as jest.MockedFunction<typeof sendTrackedEmail>
const alert = emitOpsAlert as jest.MockedFunction<typeof emitOpsAlert>
const fixture = (run: (db: any) => Promise<void>) =>
  withMigrationFixture(process.env.LOCAL_NOTICE_TEST_DATABASE_URL, run)

async function tables(db: any) {
  await db.raw('create table "order" (id text primary key, display_id integer, email text, customer_id text, metadata jsonb)')
  await db.raw('create table gp_local_milestone_event (event_id text primary key, order_id text, milestone text, kind text, recorded_at timestamptz)')
  await applyMigration(db, Migration20260924230000)
  await db("order").insert({ id: "order_fixture", display_id: 367, email: "receipt@example.com",
    customer_id: "cus_fixture", metadata: JSON.stringify({}) })
}

function container(db: any): any {
  return { resolve: (key: string) => key === ContainerRegistrationKeys.PG_CONNECTION ? db : { info() {}, warn() {}, error() {} } }
}

test("F367-01/06/09/16 office alert and accepted-order email claim once across scheduled runs", async () => {
  await fixture(async db => {
    await tables(db)
    await db("gp_local_milestone_event").insert([
      { event_id: "evt_ready_fixture", order_id: "order_fixture", milestone: "pickup_ready", kind: "record", recorded_at: "2026-09-24T12:00:00Z" },
      { event_id: "evt_failed_fixture", order_id: "order_fixture", milestone: "local_failed", kind: "record", recorded_at: "2026-09-24T12:01:00Z" },
    ])
    const priorFlag = process.env.GP_LOCAL_MILESTONES_ENABLED
    const priorPolicy = process.env.GP_LOCAL_MILESTONE_NOTICE_POLICY
    try {
      process.env.GP_LOCAL_MILESTONES_ENABLED = "true"
      process.env.GP_LOCAL_MILESTONE_NOTICE_POLICY = JSON.stringify({
        version: "issue-359-test-policy", approved_at: "2026-09-24T11:00:00Z",
        start_at: "2026-09-24T11:01:00Z", email: ["pickup_ready"], sms: [],
      })
      await runLocalMilestoneNotices(container(db))
      await runLocalMilestoneNotices(container(db))
      expect(sender).toHaveBeenCalledTimes(1)
      expect(sender).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ to: "receipt@example.com" }))
      expect(alert).toHaveBeenCalledTimes(1)
      const notices = await db("gp_local_milestone_notice").orderBy("channel", "asc")
      expect(notices.map((row: any) => [row.channel, row.status])).toEqual([["email", "sent"], ["office", "alerted"]])
    } finally {
      if (priorFlag === undefined) delete process.env.GP_LOCAL_MILESTONES_ENABLED
      else process.env.GP_LOCAL_MILESTONES_ENABLED = priorFlag
      if (priorPolicy === undefined) delete process.env.GP_LOCAL_MILESTONE_NOTICE_POLICY
      else process.env.GP_LOCAL_MILESTONE_NOTICE_POLICY = priorPolicy
    }
  })
})
