import { ORDER_FIELDS } from "./qb-sync-order-fields"
import { QbdPostingConflict, qbdMetadata } from "./qbd-posting-outbox"

export async function loadQbdOrder(query: any, id: string): Promise<Record<string, any>> {
  const { data } = await query.graph({ entity: "order", fields: ORDER_FIELDS, filters: { id } })
  const order = data?.[0]
  if (order?.id !== id || !Array.isArray(order.items)) {
    throw new QbdPostingConflict("The full order could not be loaded for accounting.")
  }
  return order
}

export function appendQbdStaffAudit(current: Record<string, any>, patch: Record<string, any>, entry: Record<string, any>) {
  const raw = current.staff_audit_log
  const previous = typeof raw === "string" ? JSON.parse(raw) : raw
  return { ...current, ...patch,
    staff_audit_log: JSON.stringify([...(Array.isArray(previous) ? previous : []), { ...entry, at: new Date().toISOString() }].slice(-50)),
    staff_last_exception_action: entry.action, staff_last_exception_at: new Date().toISOString(),
  }
}

/** Audit-only updates share the order lock and preserve the accounting projection. */
export async function persistQbdOrderAudit(db: any, orderId: string, buildMetadata: (current: Record<string, any>) => Record<string, any>) {
  return db.transaction(async (trx: any) => {
    const row = await trx("order").where({ id: orderId }).whereNull("deleted_at").forUpdate().first("metadata")
    if (!row) throw new QbdPostingConflict("Order was not found.")
    const metadata = buildMetadata(qbdMetadata(row.metadata))
    await trx("order").where({ id: orderId }).update({ metadata: JSON.stringify(metadata), updated_at: new Date() })
    return metadata
  })
}
