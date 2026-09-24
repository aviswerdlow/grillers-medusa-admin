import { ShippingInputError, type ShippingLine } from "./shipping-weights";

/** Medusa's native rate query omits variant/product metadata. Resolve it here
 * by stable Medusa variant ID; never accept a Store request's embedded catalog. */
export async function loadShippingCatalogLines(
  query: any,
  lines: Array<ShippingLine & Record<string, any>>,
) {
  const ids = Array.from(
    new Set(lines.map((line) => line.variant_id ?? line.variant?.id)),
  );
  if (!ids.length || ids.some((id) => typeof id !== "string" || !id))
    throw new ShippingInputError("missing_variant_identity");
  if (!query?.graph)
    throw new ShippingInputError("shipping_catalog_query_unavailable");
  const { data } = await query.graph({
    entity: "variant",
    fields: ["id", "sku", "metadata", "product.id", "product.metadata"],
    filters: { id: ids },
  });
  if (
    !Array.isArray(data) ||
    data.length !== ids.length ||
    new Set(data.map((v) => v.id)).size !== ids.length
  )
    throw new ShippingInputError("shipping_catalog_incomplete");
  const variants = new Map(data.map((v) => [v.id, v]));
  return lines.map((line) => {
    const variant: any = variants.get(line.variant_id ?? line.variant?.id);
    if (!variant) throw new ShippingInputError("shipping_catalog_incomplete");
    return {
      ...line,
      variant_id: variant.id,
      variant,
      product: variant.product,
    };
  });
}
