import { verifiedStaffActorId } from "../../../../../lib/staff-principal"
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { upsertLegacyItemMapping } from "../../../../../lib/legacy-item-mapping"
import { emitOpsAlert } from "../../../../../lib/ops-alert"

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim()
  return text.length ? text : null
}

function isGenericHistoryKey(value: unknown) {
  return String(value ?? "").startsWith("legacy-description:")
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const id = String(req.params.id)
  const body = (req.body ?? {}) as {
    medusa_variant_id?: string
    medusa_sku?: string
    description_contains?: string
    description_fingerprint?: string
    confidence?: number | string
    priority?: number | string
    mapping_source?: string
    staff_note?: string
    match_sku_with_qbd_item_list_id?: boolean
    dry_run?: boolean
  }
  const request = await db("legacy_reorder_request")
    .select("*")
    .where("id", id)
    .whereNull("deleted_at")
    .first()

  if (!request) {
    res.status(404).json({ message: "Reorder request not found" })
    return
  }

  const medusaVariantId = normalizeText(body.medusa_variant_id)
  const medusaSku = normalizeText(body.medusa_sku)
  if (!medusaVariantId && !medusaSku) {
    res.status(400).json({ message: "Enter a Medusa variant ID or SKU" })
    return
  }

  const descriptionContains = normalizeText(body.description_contains)
  const descriptionFingerprint = normalizeText(body.description_fingerprint)
  const genericHistory = isGenericHistoryKey(request.legacy_history_key)

  if (genericHistory && !descriptionContains && !descriptionFingerprint) {
    res.status(400).json({
      message:
        "This request came from a generic QuickBooks item bucket. Add a description matcher before mapping it.",
    })
    return
  }

  const actorId = normalizeText(verifiedStaffActorId(req))
  const dryRun = Boolean(body.dry_run)

  try {
    const result = await upsertLegacyItemMapping(db, {
      qbdItemListId: request.legacy_item_id,
      qbdName: request.title,
      sku: request.sku,
      descriptionContains,
      descriptionFingerprint,
      medusaVariantId,
      medusaSku,
      confidence: body.confidence || (genericHistory ? 0.95 : 0.98),
      priority: body.priority || 50,
      mappingSource:
        normalizeText(body.mapping_source) || "manual_admin_reorder_request",
      sourceLabel: "admin-legacy-reorder-request",
      actorId,
      dryRun,
      matchSkuWithQbdItemListId: Boolean(body.match_sku_with_qbd_item_list_id),
      metadata: {
        reorder_request_id: id,
        staff_note: normalizeText(body.staff_note),
      },
    })

    if (!dryRun) {
      const now = new Date()
      await db("legacy_reorder_request")
        .where("id", id)
        .update({
          request_status: "mapped",
          metadata: db.raw("coalesce(metadata, '{}'::jsonb) || ?::jsonb", [
            JSON.stringify({
              mapped_at: now.toISOString(),
              mapped_by: actorId,
              staff_note: normalizeText(body.staff_note),
              mapping_result: {
                qbd_item_list_id: result.qbdItemListId,
                sku: result.sku,
                medusa_product_id: result.variant.product_id,
                medusa_variant_id: result.variant.variant_id,
                medusa_sku: result.variant.sku,
                line_rows_backfilled: result.lineRowsBackfilled,
                item_map_upserted: result.itemMapUpserted,
                match_rule_upserted: result.matchRuleUpserted,
              },
            }),
          ]),
          updated_at: now,
        })
    }

    res.json({
      ok: true,
      dry_run: dryRun,
      request_id: id,
      result,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emitOpsAlert({
      alertKind: "legacy_item_mapping_failed",
      severity: "warn",
      path: "src/api/admin/legacy-reorder-requests/[id]/map/route.ts",
      title: "Legacy reorder request mapping failed",
      fingerprint: "legacy_item_mapping:reorder_request:400",
      meta: {
        request_id: id,
        legacy_history_key: request.legacy_history_key,
        qbd_item_list_id: request.legacy_item_id || null,
        sku: request.sku || null,
        medusa_variant_id: medusaVariantId,
        medusa_sku: medusaSku,
        dry_run: dryRun,
        staff_actor_id: actorId,
        error_message: message.slice(0, 300),
      },
      logger,
    })
    res.status(400).json({
      message,
    })
  }
}
