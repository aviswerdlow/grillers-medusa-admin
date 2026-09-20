import type {
  MedusaRequest,
  MedusaResponse,
  MedusaNextFunction,
} from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { emitOpsAlert } from "../../lib/ops-alert"
import {
  assertPublicCatalogCart,
  assertPublicCatalogVariants,
  internalCatalogProductIds,
  PublicCatalogError,
} from "../../lib/public-catalog"

type Guard = (req: MedusaRequest) => Promise<void>
function guarded(check: Guard) {
  return async (
    req: MedusaRequest,
    res: MedusaResponse,
    next: MedusaNextFunction
  ) => {
    try {
      await check(req)
    } catch (error) {
      const known = error instanceof PublicCatalogError
      if (!known || error.status >= 500) {
        // Never include product/customer identifiers or a raw DB error.
        let logger: any
        try {
          logger = req.scope.resolve("logger")
          logger?.warn?.("[public-catalog] eligibility lookup unavailable")
        } catch {}
        // Preserve the existing monitored guard alert while refusing the
        // request. Alert delivery cannot change the eligibility decision.
        void emitOpsAlert({
          alertKind: "mw_rm_guard_failed", severity: "warn", source: "medusa",
          title: "Public catalog eligibility could not be verified",
          path: "src/api/middlewares/public-catalog.ts", logger,
          meta: { reason: "catalog_lookup_unavailable" },
        }).catch(() => {})
      }
      res.status(known ? error.status : 503).json({
        type:
          known && error.status < 500
            ? "invalid_request"
            : "catalog_unavailable",
        message: known
          ? error.message
          : "Product availability could not be verified. Please try again.",
      })
      return
    }
    return next()
  }
}

export const filterPublicCatalog = guarded(async (req) => {
  // Native exact-route validation runs before this app middleware in Medusa
  // 2.10.3. Do not silently fall back if that ordering changes on an upgrade.
  if (!req.filterableFields)
    throw new Error("Missing validated catalog filters")
  const ids = await internalCatalogProductIds(
    req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  )
  if (!ids.length) return
  if (req.params.id && ids.includes(req.params.id)) {
    throw new PublicCatalogError(404, "Product was not found.")
  }
  const previous = req.filterableFields.$and
  if (previous != null && !Array.isArray(previous))
    throw new Error("Invalid validated catalog filters")
  req.filterableFields.$and = [
    ...(Array.isArray(previous) ? previous : []),
    { id: { $nin: ids } },
  ]
})

export const guardNewCartItems = guarded(async (req) => {
  const items = (req.body as any)?.items
  if (items !== undefined && !Array.isArray(items))
    throw new PublicCatalogError(400, "Invalid cart items.")
  await assertPublicCatalogVariants(
    req.scope,
    (items || []).map((item: any) => item?.variant_id)
  )
})
export const guardAddedCartItem = guarded(async (req) => {
  await assertPublicCatalogVariants(req.scope, [(req.body as any)?.variant_id])
})
export const guardUpdatedCartItem = guarded(async (req) => {
  await assertPublicCatalogCart(req.scope, req.params.id, req.params.line_id)
})
export const guardCompletedCart = guarded(async (req) => {
  await assertPublicCatalogCart(
    req.scope,
    req.params.id || (req.body as any)?.cart_id
  )
})
export const guardCartPaymentSession = guarded(async (req) => {
  const { data } = await req.scope
    .resolve(ContainerRegistrationKeys.QUERY)
    .graph({
      entity: "cart_payment_collection",
      fields: ["cart_id"],
      filters: { payment_collection_id: req.params.id },
    })
  if (data?.length !== 1)
    throw new PublicCatalogError(
      503,
      "Cart payment eligibility could not be verified."
    )
  await assertPublicCatalogCart(req.scope, data[0].cart_id)
})
export const guardInventoryVariants = guarded(async (req) => {
  await assertPublicCatalogVariants(
    req.scope,
    ((req.body as any)?.lines || []).map((line: any) => line?.variant_id)
  )
})
export const guardInventoryResolution = guarded(async (req) => {
  const resolutions = (req.body as any)?.resolutions || []
  const ids = resolutions.flatMap((r: any) =>
    r.action === "substitute"
      ? [r.replacement_variant_id]
      : r.action === "waitlist"
      ? [r.original_variant_id]
      : []
  )
  await assertPublicCatalogVariants(req.scope, ids)
})
