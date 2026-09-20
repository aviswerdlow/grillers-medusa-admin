import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

// These aliases also exist in Strapi and the storefront. Internal is a deny
// signal at either level; an active variant cannot override its parent.
export const CATALOG_LIFECYCLE_KEYS = [
  "availability_lifecycle",
  "availabilityLifecycle",
  "AvailabilityLifecycle",
] as const

export function isInternalCatalogRecord(record: any): boolean {
  if (!record || typeof record !== "object") return false
  return (
    /^RM-/i.test(typeof record.sku === "string" ? record.sku.trim() : "") ||
    CATALOG_LIFECYCLE_KEYS.some(
      (key) =>
        String(record.metadata?.[key] ?? "")
          .trim()
          .toLowerCase() === "internal_only"
    )
  )
}

export function isInternalCatalogProduct(product: any): boolean {
  return (
    isInternalCatalogRecord(product) ||
    Boolean(product?.variants?.some(isInternalCatalogRecord))
  )
}

// Read only the excluded IDs, before Medusa applies pagination, prices and
// sales-channel filters. This query never modifies QBD identity or catalog data.
// Keep its semantics covered alongside the pure predicate in PostgreSQL tests.
const internalMetadataSql = (alias: string) =>
  CATALOG_LIFECYCLE_KEYS.map(
    (key) =>
      `lower(btrim(coalesce(${alias}.metadata->>'${key}', ''))) = 'internal_only'`
  ).join(" OR ")
const internalProductSql = `(${internalMetadataSql("p")}) OR EXISTS (
  SELECT 1 FROM product_variant v WHERE v.product_id = p.id AND v.deleted_at IS NULL
  AND (regexp_replace(coalesce(v.sku, ''), '^[[:space:]]+|[[:space:]]+$', '', 'g') ILIKE 'RM-%'
    OR (${internalMetadataSql("v")}))
)`

export async function internalCatalogProductIds(db: any): Promise<string[]> {
  const rows = await db("product as p")
    .select("p.id")
    .whereNull("p.deleted_at")
    .whereRaw(`(${internalProductSql})`)
  return rows.map((row: any) => row.id)
}

export class PublicCatalogError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

export async function assertPublicCatalogVariants(scope: any, ids: unknown[]) {
  if (ids.some((id) => typeof id !== "string" || !id.trim())) {
    throw new PublicCatalogError(400, "A valid product variant is required.")
  }
  const unique = [...new Set(ids as string[])]
  if (!unique.length) return
  const db = scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const rows = await db("product_variant as requested")
    .join("product as p", "p.id", "requested.product_id")
    .select("requested.id")
    .whereIn("requested.id", unique)
    .whereNull("requested.deleted_at")
    .whereNull("p.deleted_at")
    .where("p.status", "published")
    .whereRaw(`NOT (${internalProductSql})`)
  const allowed = new Set(rows.map((row: any) => row.id))
  if (!unique.every((id) => allowed.has(id))) {
    throw new PublicCatalogError(
      400,
      "This item is not available for online ordering."
    )
  }
}

export async function assertPublicCatalogCart(
  scope: any,
  cartId: unknown,
  lineId?: string
) {
  if (typeof cartId !== "string" || !cartId.trim()) {
    throw new PublicCatalogError(400, "A valid cart is required.")
  }
  const { data } = await scope.resolve(ContainerRegistrationKeys.QUERY).graph({
    entity: "cart",
    fields: ["id", "items.id", "items.variant_id"],
    filters: { id: cartId },
  })
  const cart = data?.[0]
  if (!cart || cart.id !== cartId || !Array.isArray(cart.items)) {
    throw new PublicCatalogError(
      503,
      "Product availability could not be verified. Please try again."
    )
  }
  const lines = lineId
    ? cart.items.filter((item: any) => item.id === lineId)
    : cart.items
  if (lineId && lines.length !== 1)
    throw new PublicCatalogError(400, "The cart item was not found.")
  await assertPublicCatalogVariants(
    scope,
    lines.map((item: any) => item.variant_id)
  )
}
