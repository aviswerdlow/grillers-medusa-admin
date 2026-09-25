import { randomUUID } from "node:crypto"
import { QBD_POSTING_OUTBOX_SQL } from "../../src/lib/qbd-posting-schema"
import { deliverQbdOutbox } from "../../src/lib/qbd-outbox-delivery"
import { claimStaffRefundRequest, completeStaffRefundRequest, recordStaffRefundProvider,
  requireStaffRefundReconciliation, STAFF_REFUND_REQUEST_TABLE } from "../../src/lib/staff-refund-request"
import {
  acknowledgeQbdPosting, assertQbdPostingReady, persistQbdPosting,
  QBD_OUTBOX_TABLE, retryQbdPosting, untrackedQbdPostings,
} from "../../src/lib/qbd-posting-outbox"

const knex = require("knex")
// PostgreSQL stores sub-millisecond timestamps; the test clock advances past inserts.
const deliver = (input: Parameters<typeof deliverQbdOutbox>[0]) => deliverQbdOutbox({ now: () => new Date(Date.now() + 1000), ...input })
const schema = `gp_accounting_${randomUUID().replace(/-/g, "")}`
let db: any
let admin: any

beforeAll(async () => {
  const url = process.env.QBD_TEST_DATABASE_URL
  const socket = process.env.QBD_TEST_PG_SOCKET
  if (!url && !socket) throw new Error("Supply an isolated QBD_TEST_DATABASE_URL or QBD_TEST_PG_SOCKET; never the application DATABASE_URL.")
  const connection = url || { host: socket, port: 55431, user: "gp_launch_test", database: "gp_launch" }
  admin = knex({ client: "pg", connection })
  await admin.raw(`create schema ${schema}`)
  db = knex({ client: "pg", connection, searchPath: [schema], pool: { min: 0, max: 8 } })
  await db.raw(`create table "order" (
    id text primary key, metadata jsonb, deleted_at timestamptz, updated_at timestamptz,
    constraint test_projection_failure check (coalesce(metadata->>'reject_projection', '') <> 'true')
  )`)
  await db.raw(QBD_POSTING_OUTBOX_SQL)
})

afterAll(async () => {
  if (db) await db.destroy()
  if (admin) {
    await admin.raw(`drop schema if exists ${schema} cascade`)
    await admin.destroy()
  }
})

beforeEach(async () => {
  await db(STAFF_REFUND_REQUEST_TABLE).delete()
  await db(QBD_OUTBOX_TABLE).delete()
  await db("order").delete()
  await db("order").insert({ id: "order_test", metadata: "{}" })
})

const refundIntent = (key = "intent_one") => ({ orderId: "order_test", paymentId: "pay_test", requestKey: key,
  amount: 5, currencyCode: "usd", note: "Synthetic test refund" })

it("claims only one provider attempt for concurrent HTTP retries", async () => {
  const results = await Promise.allSettled([claimStaffRefundRequest(db, refundIntent()), claimStaffRefundRequest(db, refundIntent())])
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1)
  expect(await db(STAFF_REFUND_REQUEST_TABLE)).toHaveLength(1)
})

it("replays the confirmed refund and rejects a changed amount under the same key", async () => {
  const intent = await claimStaffRefundRequest(db, refundIntent())
  const response = { payment: { id: "pay_test", refunds: [{ id: "re_test", amount: 5 }] } }
  await recordStaffRefundProvider(db, intent.id, "re_test")
  await completeStaffRefundRequest(db, intent.id, response)
  expect((await claimStaffRefundRequest(db, refundIntent())).replay).toEqual(response)
  await expect(claimStaffRefundRequest(db, { ...refundIntent(), amount: 6 })).rejects.toThrow("different details")
  expect((await claimStaffRefundRequest(db, refundIntent("intent_two"))).replay).toBeNull()
})

it("does not expire an uncertain refund or permit a second key to bypass it", async () => {
  const intent = await claimStaffRefundRequest(db, refundIntent())
  await recordStaffRefundProvider(db, intent.id, "re_known_but_not_recorded")
  await requireStaffRefundReconciliation(db, intent.id)
  await db(STAFF_REFUND_REQUEST_TABLE).update({ created_at: new Date("2020-01-01") })
  await expect(claimStaffRefundRequest(db, refundIntent())).rejects.toThrow("needs reconciliation")
  await expect(claimStaffRefundRequest(db, refundIntent("intent_two"))).rejects.toThrow("earlier refund")
  expect((await db(STAFF_REFUND_REQUEST_TABLE).first()).provider_refund_id).toBe("re_known_but_not_recorded")
  expect((await db(STAFF_REFUND_REQUEST_TABLE).first()).request_details).toEqual(expect.objectContaining({ amount: 5, currency_code: "usd" }))
})

it("accepts a documented note merge but never substitutes that for a financial receipt", async () => {
  await queue("note:one", 0, "append_order_note")
  await acknowledgeQbdPosting(db, "order_test", { request_key: "note:one", bridge_job_id: "job_note", status: "posted",
    transactions: [], no_effect_reason: "note_merged_into_pending_sales_order" })
  await queue("final_charge:pi_test")
  await expect(acknowledgeQbdPosting(db, "order_test", { ...invoiceReceipt(), transactions: [],
    no_effect_reason: "note_merged_into_pending_sales_order" })).rejects.toThrow("transaction receipts")
})

it("blocks deterministic bridge rejection without starving another action", async () => {
  await queue("edit:unsupported", 0, "update_sales_order_items")
  await queue("final_charge:pi_test")
  const result = await deliver({ db, normalize: async (o) => o, post: async (_order, envelope) => {
    if (envelope.request_key === "edit:unsupported") return new Response("{}", { status: 422 })
    return new Response(JSON.stringify({ qbd_outbox_receipt: { ...envelope, bridge_job_id: "job_test" } }))
  } })
  expect(result).toEqual({ delivered: 1, retried: 0, blocked: 1 })
  expect((await db(QBD_OUTBOX_TABLE).where({ request_key: "edit:unsupported" }).first()).status).toBe("blocked")
})

it("does not let a delayed failed receipt undo an explicit accounting retry", async () => {
  await queue("final_charge:pi_test")
  await acknowledgeQbdPosting(db, "order_test", { ...invoiceReceipt(), status: "failed", transactions: [], error: "Rejected" })
  await retryQbdPosting(db, "order_test", "final_charge:pi_test")
  const row = await db(QBD_OUTBOX_TABLE).first()
  expect(row.retry_generation).toBe(1)
  await expect(acknowledgeQbdPosting(db, "order_test", { ...invoiceReceipt(), status: "failed", transactions: [] })).rejects.toThrow("different accounting retry")
  await acknowledgeQbdPosting(db, "order_test", { ...invoiceReceipt(), retry_generation: 1 })
  expect((await db(QBD_OUTBOX_TABLE).first()).status).toBe("posted")
})

it("retries an older action without replacing a newer refund projection", async () => {
  await queue("final_charge:pi_test")
  await queue("refund:re_one", 500, "card_refund_accounting_record")
  await acknowledgeQbdPosting(db, "order_test", { ...invoiceReceipt(), status: "failed", transactions: [], error: "Rejected" })
  await retryQbdPosting(db, "order_test", "final_charge:pi_test")
  expect((await db("order").first()).metadata.qbd_posting_request_key).toBe("refund:re_one")
  expect((await db(QBD_OUTBOX_TABLE).where({ request_key: "final_charge:pi_test" }).first()).status).toBe("pending")
})

it("rejects a different bridge job claiming the delivered action", async () => {
  await queue("final_charge:pi_test")
  await db(QBD_OUTBOX_TABLE).update({ status: "delivered", bridge_job_id: "job_expected" })
  await expect(acknowledgeQbdPosting(db, "order_test", invoiceReceipt())).rejects.toThrow("different bridge job")
  expect((await db(QBD_OUTBOX_TABLE).first()).status).toBe("delivered")
})

const snapshot = () => ({
  id: "order_test", currency_code: "usd", total: 30,
  items: [{ id: "item_test", quantity: 2, unit_price: 15, metadata: { qbd_list_id: "TEST-LIST-ID" } }],
})

const action = (key: string, amount = 3000, kind = "final_card_charge_accounting_record") => ({
  qbd_posting_required: true, qbd_posting_status: "pending_manual", qbd_posting_request_key: key,
  qbd_posting_action: kind, qbd_posting_amount: amount, stripe_payment_intent_id: "pi_test",
  ...(kind === "card_refund_accounting_record" ? { stripe_refund_id: key.replace("refund:", "") } : {}),
})

const queue = (key: string, amount = 3000, kind = "final_card_charge_accounting_record") => persistQbdPosting({
  db, order: snapshot(), buildMetadata: (current) => ({ ...current, ...action(key, amount, kind) }),
})

const invoiceReceipt = () => ({ request_key: "final_charge:pi_test", bridge_job_id: "job_invoice", status: "posted" as const,
  transactions: [{ kind: "invoice", txn_id: "TEST-INVOICE" }, { kind: "payment", txn_id: "TEST-PAYMENT" }] })

it("retains a charge and two immediate refunds while the bridge is offline", async () => {
  await queue("final_charge:pi_test")
  await queue("refund:re_one", 500, "card_refund_accounting_record")
  await queue("refund:re_two", 700, "card_refund_accounting_record")
  const rows = await db(QBD_OUTBOX_TABLE).orderBy("sequence")
  expect(rows.map((row: any) => [row.request_key, Number(row.amount_minor), row.depends_on_request_key])).toEqual([
    ["final_charge:pi_test", 3000, null], ["refund:re_one", 500, "final_charge:pi_test"], ["refund:re_two", 700, "refund:re_one"],
  ])
  expect(rows.every((row: any) => row.status === "pending")).toBe(true)
  expect(rows[0].order_snapshot.items[0].metadata.qbd_list_id).toBe("TEST-LIST-ID")
  expect(rows[0].order_snapshot.metadata.qbd_posting_request_key).toBe("final_charge:pi_test")
  expect((await db("order").first()).metadata.qbd_posting_request_key).toBe("refund:re_two")
})

it("serializes concurrent producers into one complete dependency chain", async () => {
  await queue("final_charge:pi_test")
  await Promise.all([
    queue("refund:re_one", 500, "card_refund_accounting_record"),
    queue("refund:re_two", 700, "card_refund_accounting_record"),
  ])
  const rows = await db(QBD_OUTBOX_TABLE).orderBy("sequence")
  expect(rows).toHaveLength(3)
  expect(rows[1].depends_on_request_key).toBe(rows[0].request_key)
  expect(rows[2].depends_on_request_key).toBe(rows[1].request_key)
})

it("deduplicates a simultaneous delivery of the same source request", async () => {
  const results = await Promise.all([queue("final_charge:pi_test"), queue("final_charge:pi_test")])
  expect(results.map((r: any) => r.replayed).sort()).toEqual([false, true])
  expect(await db(QBD_OUTBOX_TABLE)).toHaveLength(1)
})

it("does not let a retried old request overwrite the latest order projection", async () => {
  await queue("final_charge:pi_test")
  await queue("refund:re_one", 500, "card_refund_accounting_record")
  await persistQbdPosting({ db, order: snapshot(), buildMetadata: () => action("final_charge:pi_test") })
  expect((await db("order").first()).metadata.qbd_posting_request_key).toBe("refund:re_one")
  await expect(queue("refund:re_one", 800, "card_refund_accounting_record")).rejects.toThrow("different action")
  expect(await db(QBD_OUTBOX_TABLE)).toHaveLength(2)
})

it("rolls back the action if its order projection cannot commit", async () => {
  await expect(persistQbdPosting({
    db, order: snapshot(), buildMetadata: () => ({ ...action("final_charge:pi_test"), reject_projection: true }),
  })).rejects.toThrow("test_projection_failure")
  expect(await db(QBD_OUTBOX_TABLE)).toHaveLength(0)
  expect((await db("order").first()).metadata).toEqual({})
})

it("accepts an old action's receipt without falsely completing a newer refund", async () => {
  await queue("final_charge:pi_test")
  await queue("refund:re_one", 500, "card_refund_accounting_record")
  await acknowledgeQbdPosting(db, "order_test", invoiceReceipt())
  const metadata = (await db("order").first()).metadata
  expect(metadata.qbd_posting_request_key).toBe("refund:re_one")
  expect(metadata.qbd_posting_status).toBe("pending_manual")
  expect(metadata.qbd_invoice_txn_id).toBe("TEST-INVOICE")
  expect((await db(QBD_OUTBOX_TABLE).where({ request_key: "final_charge:pi_test" }).first()).status).toBe("posted")
  expect((await db(QBD_OUTBOX_TABLE).where({ request_key: "refund:re_one" }).first()).status).toBe("pending")
})

it("requires both invoice and applied-payment IDs for a completed card charge", async () => {
  await queue("final_charge:pi_test")
  await expect(acknowledgeQbdPosting(db, "order_test", {
    ...invoiceReceipt(), transactions: [{ kind: "invoice", txn_id: "TEST-INVOICE" }],
  })).rejects.toThrow("both invoice and applied-payment")
  expect((await db(QBD_OUTBOX_TABLE).first()).status).toBe("pending")
  await acknowledgeQbdPosting(db, "order_test", invoiceReceipt())
  expect((await acknowledgeQbdPosting(db, "order_test", invoiceReceipt())).replayed).toBe(true)
  await expect(acknowledgeQbdPosting(db, "order_test", {
    ...invoiceReceipt(), status: "failed", error: "late error",
  })).rejects.toThrow("cannot be replaced")
})

it("enforces immutable accounting facts while allowing delivery bookkeeping", async () => {
  await queue("final_charge:pi_test")
  await expect(db(QBD_OUTBOX_TABLE).update({ amount_minor: 1 })).rejects.toThrow("source is immutable")
  await expect(db(QBD_OUTBOX_TABLE).update({ order_snapshot: "{}" })).rejects.toThrow("source is immutable")
  await db(QBD_OUTBOX_TABLE).update({ attempts: 1, last_error: "writer offline" })
  expect(Number((await db(QBD_OUTBOX_TABLE).first()).amount_minor)).toBe(3000)
})

it("reports older pending metadata and blocks new work without replaying it", async () => {
  await db("order").update({ metadata: JSON.stringify(action("legacy:old")) })
  expect(await untrackedQbdPostings(db)).toEqual([{
    order_id: "order_test", request_key: "legacy:old", action: "final_card_charge_accounting_record", status: "pending_manual",
  }])
  await expect(assertQbdPostingReady(db, "order_test")).rejects.toThrow("older QuickBooks request")
  await expect(queue("refund:re_one", 500, "card_refund_accounting_record")).rejects.toThrow("older QuickBooks request")
  expect(await db(QBD_OUTBOX_TABLE)).toHaveLength(0)
})

it("refuses a list-only payload or a preliminary staff request", async () => {
  await expect(persistQbdPosting({ db, order: { id: "order_test" }, buildMetadata: () => action("key") })).rejects.toThrow("full order snapshot")
  await expect(persistQbdPosting({
    db, order: snapshot(), buildMetadata: () => ({ ...action("refund:re_one", 500, "card_refund_accounting_record"), stripe_refund_status: "requested" }),
  })).rejects.toThrow("source action has not completed")
  expect(await db(QBD_OUTBOX_TABLE)).toHaveLength(0)
})

it("retains work across a writer outage, delivers each snapshot on retry and requires an exact acknowledgement", async () => {
  await queue("final_charge:pi_test")
  await queue("refund:re_one", 500, "card_refund_accounting_record")
  const normalize = async (order: any) => order
  const outage = await deliver({ db, normalize, post: async () => new Response("unavailable", { status: 503 }) })
  expect(outage).toEqual({ delivered: 0, retried: 2, blocked: 0 })
  expect((await db(QBD_OUTBOX_TABLE)).every((r: any) => r.status === "pending")).toBe(true)
  const sent: string[] = []
  const result = await deliver({ db, normalize, now: () => new Date(Date.now() + 60_000),
    post: async (order, envelope) => {
      sent.push(order.metadata.qbd_posting_request_key)
      return Response.json({ qbd_outbox_receipt: { id: envelope.id, request_key: envelope.request_key, bridge_job_id: `job_${sent.length}` } })
    },
  })
  expect(result).toEqual({ delivered: 2, retried: 0, blocked: 0 })
  expect(sent).toEqual(["final_charge:pi_test", "refund:re_one"])
  expect((await db(QBD_OUTBOX_TABLE)).every((r: any) => r.status === "delivered")).toBe(true)
})

it("does not accept a successful HTTP response for a different action", async () => {
  await queue("final_charge:pi_test")
  const result = await deliver({ db, normalize: async (order) => order,
    post: async () => Response.json({ ok: true, qbd_outbox_receipt: { id: "wrong", request_key: "other", bridge_job_id: "1" } }),
  })
  expect(result.retried).toBe(1)
  expect((await db(QBD_OUTBOX_TABLE).first()).status).toBe("pending")
})

it("does not let a malformed action or a concurrently leased action starve valid work", async () => {
  await db(QBD_OUTBOX_TABLE).insert({ id: "malformed", order_id: "bad_order", request_key: "bad:key", action: "append_order_note",
    amount_minor: 0, currency_code: "usd", order_snapshot: "{}" })
  await queue("final_charge:pi_test")
  await queue("refund:re_one", 500, "card_refund_accounting_record")
  const sent: string[] = []
  const post = async (_: any, envelope: any) => {
    sent.push(envelope.request_key)
    return Response.json({ qbd_outbox_receipt: { ...envelope, bridge_job_id: envelope.request_key } })
  }
  await Promise.all([deliver({ db, normalize: async (o) => o, post }), deliver({ db, normalize: async (o) => o, post })])
  expect(sent.sort()).toEqual(["final_charge:pi_test", "refund:re_one"])
  expect((await db(QBD_OUTBOX_TABLE).where({ id: "malformed" }).first()).status).toBe("blocked")
})

it("recovers an expired worker lease and does not overwrite a faster posting receipt", async () => {
  await queue("final_charge:pi_test")
  await db(QBD_OUTBOX_TABLE).update({ lease_id: "dead_worker", leased_until: new Date(Date.now() - 1000) })
  await deliver({ db, normalize: async (order) => order, post: async (_, envelope) => {
    await acknowledgeQbdPosting(db, "order_test", invoiceReceipt())
    return Response.json({ qbd_outbox_receipt: { ...envelope, bridge_job_id: "job_invoice" } })
  } })
  expect((await db(QBD_OUTBOX_TABLE).first()).status).toBe("posted")
})
