import { createHash } from "node:crypto"
import { metadataObject } from "./catch-weight-finalization"
import { withInstitutionalFinalizationWrite } from "./gp-institutional-finalization-lock"

const KEY = "gp_institutional_release_intent"
const postingStates = new Set(["pending", "pending_manual", "queued", "posted"])

type Intent = {
  version: 1
  status: "prepared" | "applied" | "quarantined"
  orderId: string
  commitmentId: string
  requestKey: string
  amountCents: number
  baseFingerprint: string
  targetMetadata: Record<string, unknown>
  preparedAt: string
  lastCheckedAt?: string
  quarantineReason?: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(metadataObject(value)))).digest("hex")
}

function safeText(value: unknown): string | null {
  return typeof value === "string" && value.trim() === value && value !== ""
    ? value : null
}

function safeCents(value: unknown): number | null {
  const amount = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0
    ? amount : null
}

export function institutionalReleaseIntent(input: {
  orderId: string
  commitmentId: string
  baseMetadata: unknown
  targetMetadata: Record<string, unknown>
  amountCents: number
}): Intent {
  if (!safeText(input.orderId) || !safeText(input.commitmentId) ||
      safeCents(input.amountCents) === null ||
      input.targetMetadata.qbd_posting_request_key !== `invoice_ar:${input.orderId}` ||
      input.targetMetadata.qbd_posting_amount !== input.amountCents ||
      input.targetMetadata.qbd_posting_action !== "invoice_ar_accounting_record" ||
      input.targetMetadata.qbd_posting_required !== true ||
      input.targetMetadata.fulfillment_gate_status !== "released") {
    throw new Error("Institutional release intent is incomplete.")
  }
  return {
    version: 1,
    status: "prepared",
    orderId: input.orderId,
    commitmentId: input.commitmentId,
    requestKey: `invoice_ar:${input.orderId}`,
    amountCents: input.amountCents,
    baseFingerprint: fingerprint(input.baseMetadata),
    targetMetadata: input.targetMetadata,
    preparedAt: new Date().toISOString(),
  }
}

export async function persistInstitutionalReleaseIntent(
  trx: any,
  finalizationId: string,
  intent: Intent
): Promise<void> {
  const row = await trx("gp_order_finalization")
    .where({ id: finalizationId })
    .whereNull("deleted_at")
    .first()
  if (!row || row.order_id !== intent.orderId ||
      row.status !== "released_to_fulfillment" ||
      metadataObject(row.metadata)[KEY]) {
    throw new Error("Institutional release intent cannot be recorded.")
  }
  await trx("gp_order_finalization")
    .where({ id: finalizationId })
    .update({ metadata: { ...metadataObject(row.metadata), [KEY]: intent }, updated_at: new Date() })
}

function readIntent(row: Record<string, any>): Intent | null {
  const intent = metadataObject(row.metadata)[KEY] as Intent | undefined
  if (!intent || intent.version !== 1 ||
      !["prepared", "applied", "quarantined"].includes(intent.status) ||
      intent.orderId !== row.order_id ||
      !safeText(intent.commitmentId) ||
      intent.requestKey !== `invoice_ar:${row.order_id}` ||
      safeCents(intent.amountCents) === null ||
      !safeText(intent.baseFingerprint) ||
      !intent.targetMetadata || typeof intent.targetMetadata !== "object" ||
      intent.targetMetadata.qbd_posting_request_key !== intent.requestKey ||
      safeCents(intent.targetMetadata.qbd_posting_amount) !== intent.amountCents ||
      intent.targetMetadata.qbd_posting_action !== "invoice_ar_accounting_record" ||
      intent.targetMetadata.qbd_posting_required !== true) return null
  return intent
}

function releaseVisible(metadata: Record<string, unknown>, intent: Intent): boolean {
  const status = String(metadata.qbd_posting_status)
  return metadata.qbd_posting_request_key === intent.requestKey &&
    metadata.qbd_posting_action === "invoice_ar_accounting_record" &&
    safeCents(metadata.qbd_posting_amount) === intent.amountCents &&
    metadata.fulfillment_gate_status === "released" &&
    metadata.finalization_status === "released_to_fulfillment" &&
    postingStates.has(status) &&
    (status === "posted" ? safeText(metadata.qbd_txn_id) !== null
      : metadata.qbd_posting_required === true)
}

async function markIntent(trx: any, row: Record<string, any>, intent: Intent): Promise<void> {
  await trx("gp_order_finalization")
    .where({ id: row.id })
    .update({
      metadata: { ...metadataObject(row.metadata), [KEY]: intent },
      updated_at: new Date(),
    })
}

type Result =
  | { status: "applied" }
  | { status: "pending"; reason: string }
  | { status: "quarantined"; reason: string }

/** Read the canonical order before every possible write. A failed/uncertain
 * module write is read back once and left prepared for the scheduled pass.
 * Conflicting metadata is quarantined, never overwritten.
 */
export async function reconcileInstitutionalReleaseIntent(input: {
  db: any
  orderModule: any
  orderId: string
}): Promise<Result> {
  const orderForLock = { id: input.orderId, metadata: { payment_workflow: "invoice_ar" } }
  return withInstitutionalFinalizationWrite(input.db, orderForLock, async (trx) => {
    const row = await trx("gp_order_finalization")
      .where({ order_id: input.orderId })
      .whereNull("deleted_at")
      .first()
    const intent = row && readIntent(row)
    if (!intent || row.status !== "released_to_fulfillment") {
      return { status: "pending", reason: "release_intent_unavailable" }
    }
    if (intent.status === "applied") return { status: "applied" }
    if (intent.status === "quarantined") {
      return { status: "quarantined", reason: intent.quarantineReason || "release_intent_quarantined" }
    }

    const creditRows = await trx("gp_institutional_credit_commitment")
      .where({ order_id: intent.commitmentId })
      .whereNull("deleted_at")
    if (!Array.isArray(creditRows) || creditRows.length !== 1 ||
        safeCents(creditRows[0].amount_cents) !== intent.amountCents ||
        !["accepted", "posting", "posted"].includes(String(creditRows[0].state))) {
      const reason = "release_credit_mismatch"
      await markIntent(trx, row, { ...intent, status: "quarantined", quarantineReason: reason, lastCheckedAt: new Date().toISOString() })
      return { status: "quarantined", reason }
    }

    const current = await input.orderModule.retrieveOrder(input.orderId, { select: ["id", "metadata"] })
    if (current?.id !== input.orderId) return { status: "pending", reason: "order_read_unavailable" }
    const metadata = metadataObject(current.metadata)
    if (releaseVisible(metadata, intent)) {
      await markIntent(trx, row, { ...intent, status: "applied", lastCheckedAt: new Date().toISOString() })
      return { status: "applied" }
    }
    if (metadata.qbd_posting_request_key || metadata.fulfillment_gate_status === "released" ||
        fingerprint(metadata) !== intent.baseFingerprint) {
      const reason = "order_metadata_conflict"
      await markIntent(trx, row, { ...intent, status: "quarantined", quarantineReason: reason, lastCheckedAt: new Date().toISOString() })
      return { status: "quarantined", reason }
    }

    try {
      await input.orderModule.updateOrders(input.orderId, { metadata: intent.targetMetadata })
    } catch {
      // The write may have committed despite an error. Read back; do not replay.
    }
    let readback: Record<string, any> | null = null
    try {
      readback = await input.orderModule.retrieveOrder(input.orderId, { select: ["id", "metadata"] })
    } catch {
      return { status: "pending", reason: "order_readback_unavailable" }
    }
    if (readback?.id === input.orderId && releaseVisible(metadataObject(readback.metadata), intent)) {
      await markIntent(trx, row, { ...intent, status: "applied", lastCheckedAt: new Date().toISOString() })
      return { status: "applied" }
    }
    return { status: "pending", reason: "order_update_unconfirmed" }
  }, { readReleased: true })
}
