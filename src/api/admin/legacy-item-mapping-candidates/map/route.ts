import { verifiedStaffActorId } from "../../../../lib/staff-principal"
import { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { upsertLegacyItemMapping } from "../../../../lib/legacy-item-mapping"
import { getLegacyItemMappingCandidate } from "../../../../lib/legacy-item-mapping-review"
import { emitOpsAlert } from "../../../../lib/ops-alert"

function normalizeText(value: unknown): string | null {
  const text = String(value ?? "").trim()
  return text.length ? text : null
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const db = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER)
  const body = (req.body ?? {}) as {
    qbd_item_list_id?: string | null
    sku?: string | null
    title?: string | null
    description_group?: string | null
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

  const medusaVariantId = normalizeText(body.medusa_variant_id)
  const medusaSku = normalizeText(body.medusa_sku)

  if (!medusaVariantId && !medusaSku) {
    res.status(400).json({ message: "Enter a Medusa variant ID or SKU" })
    return
  }

  const candidate = await getLegacyItemMappingCandidate(db, {
    qbdItemListId: body.qbd_item_list_id,
    sku: body.sku,
    title: body.title,
    descriptionGroup: body.description_group,
  })

  if (!candidate) {
    res.status(404).json({ message: "Legacy mapping candidate not found" })
    return
  }

  const descriptionContains = normalizeText(body.description_contains)
  const descriptionFingerprint = normalizeText(body.description_fingerprint)

  if (
    candidate.requires_description_matcher &&
    !descriptionContains &&
    !descriptionFingerprint
  ) {
    res.status(400).json({
      message:
        "This candidate came from a generic QuickBooks item bucket. Add a description matcher before mapping it.",
    })
    return
  }

  try {
    const actorId = normalizeText(verifiedStaffActorId(req))
    const dryRun = Boolean(body.dry_run)
    const result = await upsertLegacyItemMapping(db, {
      qbdItemListId: candidate.qbd_item_list_id,
      qbdName: candidate.title,
      sku: candidate.sku,
      descriptionContains,
      descriptionFingerprint,
      medusaVariantId,
      medusaSku,
      confidence:
        body.confidence ||
        (candidate.requires_description_matcher ? 0.95 : 0.98),
      priority: body.priority || 60,
      mappingSource:
        normalizeText(body.mapping_source) || "manual_admin_mapping_review",
      sourceLabel: "admin-legacy-item-mapping-candidates",
      actorId,
      dryRun,
      matchSkuWithQbdItemListId: Boolean(body.match_sku_with_qbd_item_list_id),
      metadata: {
        staff_note: normalizeText(body.staff_note),
        mapping_candidate_key: candidate.key,
        mapping_candidate: {
          qbd_item_list_id: candidate.qbd_item_list_id,
          sku: candidate.sku,
          title: candidate.title,
          description_group: candidate.description_group,
          sample_description: candidate.sample_description,
          line_count: candidate.line_count,
          order_count: candidate.order_count,
          customer_count: candidate.customer_count,
        },
      },
    })

    res.json({
      ok: true,
      dry_run: dryRun,
      candidate,
      result,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await emitOpsAlert({
      alertKind: "legacy_item_mapping_failed",
      severity: "warn",
      path: "src/api/admin/legacy-item-mapping-candidates/map/route.ts",
      title: "Legacy item mapping candidate failed",
      fingerprint: "legacy_item_mapping:candidate:400",
      meta: {
        qbd_item_list_id: candidate.qbd_item_list_id,
        sku: candidate.sku || null,
        mapping_candidate_key: candidate.key,
        medusa_variant_id: medusaVariantId,
        medusa_sku: medusaSku,
        dry_run: Boolean(body.dry_run),
        staff_actor_id: normalizeText(verifiedStaffActorId(req)),
        error_message: message.slice(0, 300),
      },
      logger,
    })
    res.status(400).json({
      message,
    })
  }
}
