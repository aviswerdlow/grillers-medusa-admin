import { resolveOrderReceiptEmail } from "../receipt-email-orders"
import { fulfillmentDates, formatFulfillmentDate } from "../fulfillment-dates";
import { STRAPI_MODULE } from "../../modules/strapi"
import StrapiModuleService from "../../modules/strapi/service"
import { STOREFRONT_URL } from "./layout"

type Container = { resolve: (key: string) => any }

const ORDER_FIELDS = [
  "id",
  "customer_id",
  "display_id",
  "email",
  "currency_code",
  "created_at",
  "total",
  "subtotal",
  "item_total",
  "item_subtotal",
  "tax_total",
  "shipping_total",
  "discount_total",
  "shipping_subtotal",
  "shipping_tax_total",
  "metadata",
  "items.*",
  "items.detail.*",
  "items.variant.*",
  "items.variant.product.*",
  "shipping_address.*",
  "billing_address.*",
  "shipping_methods.*",
  "shipping_methods.amount",
  "shipping_methods.raw_amount",
  "shipping_methods.total",
  "shipping_methods.raw_total",
  "shipping_methods.subtotal",
  "shipping_methods.raw_subtotal",
  "shipping_methods.tax_total",
  "shipping_methods.raw_tax_total",
  "payment_collections.payments.provider_id",
  "payment_collections.payments.amount",
  "payment_collections.payments.currency_code",
]

type MaybeMoney = number | string | { value?: number | string } | null | undefined

const numeric = (value: MaybeMoney): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }

  if (
    value &&
    typeof value === "object" &&
    "value" in value &&
    (typeof value.value === "number" || typeof value.value === "string")
  ) {
    return numeric(value.value)
  }

  return null
}

const firstNumeric = (...values: MaybeMoney[]): number | null => {
  for (const value of values) {
    const parsed = numeric(value)
    if (parsed !== null) {
      return parsed
    }
  }

  return null
}

const firstPositiveNumeric = (...values: MaybeMoney[]): number | null => {
  for (const value of values) {
    const parsed = numeric(value)
    if (parsed !== null && parsed > 0) {
      return parsed
    }
  }

  return null
}

const cleanText = (value: unknown): string | null => {
  const text = String(value ?? "").trim()
  return text === "" ? null : text
}

const objectValue = (value: unknown): Record<string, any> =>
  value && typeof value === "object" ? (value as Record<string, any>) : {}

const productIdForItem = (item: Record<string, any>): string | null => {
  const variant = objectValue(item.variant)
  const product = objectValue(item.product)
  const variantProduct = objectValue(variant.product)

  return (
    cleanText(item.product_id) ||
    cleanText(product.id) ||
    cleanText(variant.product_id) ||
    cleanText(variantProduct.id)
  )
}

const productHandleForItem = (item: Record<string, any>): string | null => {
  const variant = objectValue(item.variant)
  const product = objectValue(item.product)
  const variantProduct = objectValue(variant.product)
  const metadata = objectValue(item.metadata)

  return (
    cleanText(metadata.strapi_product_handle) ||
    cleanText(metadata.product_handle) ||
    cleanText(metadata.medusa_product_handle) ||
    cleanText(item.product_handle) ||
    cleanText(product.handle) ||
    cleanText(variantProduct.handle)
  )
}

const skuForItem = (item: Record<string, any>): string | null => {
  const variant = objectValue(item.variant)
  const detail = objectValue(item.detail)
  const metadata = objectValue(item.metadata)

  return (
    cleanText(metadata.sku) ||
    cleanText(metadata.variant_sku) ||
    cleanText(metadata.medusa_sku) ||
    cleanText(item.variant_sku) ||
    cleanText(item.sku) ||
    cleanText(detail.sku) ||
    cleanText(variant.sku)
  )
}

const metadataValue = (
  metadata: Record<string, any>,
  keys: string[]
): unknown => {
  for (const key of keys) {
    if (metadata[key] !== undefined && metadata[key] !== null) {
      return metadata[key]
    }
  }
  return null
}

const combinedLineMetadata = (item: Record<string, any>): Record<string, any> => {
  const variant = objectValue(item.variant)
  const product = objectValue(item.product)
  const variantProduct = objectValue(variant.product)
  return {
    ...objectValue(variantProduct.metadata),
    ...objectValue(product.metadata),
    ...objectValue(variant.metadata),
    ...objectValue(item.metadata),
  }
}

const normalizePricingMode = (
  value: unknown
): "per_lb" | "fixed_price" | null => {
  const raw = cleanText(value)?.toLowerCase()
  if (!raw) return null

  if (
    raw === "per_lb" ||
    raw === "per-pound" ||
    raw === "per pound" ||
    raw === "catch_weight" ||
    raw === "catch-weight"
  ) {
    return "per_lb"
  }

  if (
    raw === "fixed" ||
    raw === "fixed_price" ||
    raw === "fixed-price" ||
    raw === "flat" ||
    raw === "pack" ||
    raw === "by_pack"
  ) {
    return "fixed_price"
  }

  return null
}

const pricePerPoundFromText = (value: unknown): number | null => {
  const text = cleanText(value)
  if (!text) return null

  const match = text.match(
    /\$\s*(\d+(?:\.\d+)?)\s*(?:\/\s*)?(?:lb|lbs|pound|pounds)\b/i
  )
  if (!match) return null

  const price = Number(match[1])
  return Number.isFinite(price) && price > 0 ? price : null
}

const parseWeightRangeAverage = (value: unknown): number | null => {
  const direct = numeric(value as MaybeMoney)
  if (direct !== null && direct > 0) return direct

  const text = cleanText(value)?.toLowerCase().replace(/[~≈]/g, "")
  if (!text) return null

  const range = text.match(
    /(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds|oz|ounce|ounces)\b/
  )
  const ozMultipack = text.match(
    /(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*(oz|ounce|ounces)\b/
  )
  const single = text.match(
    /(\d+(?:\.\d+)?)\s*(lb|lbs|pound|pounds|oz|ounce|ounces)\b/
  )

  let amount: number | null = null
  let unit = ""
  if (range) {
    amount = (Number(range[1]) + Number(range[2])) / 2
    unit = range[3] || ""
  } else if (ozMultipack) {
    amount = Number(ozMultipack[1]) * Number(ozMultipack[2])
    unit = ozMultipack[3] || ""
  } else if (single) {
    amount = Number(single[1])
    unit = single[2] || ""
  }

  if (!amount || !Number.isFinite(amount)) return null
  return /oz|ounce/.test(unit || text) ? amount / 16 : amount
}

const pricingModeForItem = (
  item: Record<string, any>
): "per_lb" | "fixed_price" => {
  const metadata = combinedLineMetadata(item)
  const explicit = normalizePricingMode(
    metadataValue(metadata, [
      "strapi_pricing_mode",
      "pricing_mode",
      "PricingMode",
      "net_weight_pricing_mode",
      "catch_weight_pricing_mode",
      "price_type",
    ])
  )

  if (explicit) return explicit

  if (
    metadata.catch_weight === true ||
    metadata.is_catch_weight === true ||
    metadata.RequiresCatchWeight === true
  ) {
    return "per_lb"
  }

  const text = [
    item.title,
    item.subtitle,
    item.product_title,
    item.variant_title,
    metadata.title,
    metadata.customer_title,
  ]
    .filter((value) => typeof value === "string")
    .join(" ")

  return pricePerPoundFromText(text) !== null || /\bper\s+pound\b/i.test(text)
    ? "per_lb"
    : "fixed_price"
}

const pricePerPoundForItem = (
  item: Record<string, any>,
  lineSubtotal: number,
  quantity: number
): number | null => {
  const metadata = combinedLineMetadata(item)
  const metadataRate = metadataValue(metadata, [
    "strapi_price_per_lb",
    "price_per_lb",
    "price_per_pound",
    "unit_price_per_lb",
    "current_uom_price",
    "CurrentUomPrice",
    "catch_weight_unit_price",
  ])

  const parsedMetadataRate =
    typeof metadataRate === "string"
      ? pricePerPoundFromText(metadataRate)
      : numeric(metadataRate as MaybeMoney)
  if (parsedMetadataRate !== null && parsedMetadataRate > 0) {
    return parsedMetadataRate
  }

  const textRate = pricePerPoundFromText(
    [
      item.title,
      item.subtitle,
      item.product_title,
      item.variant_title,
      metadata.title,
      metadata.customer_title,
    ]
      .filter((value) => typeof value === "string")
      .join(" ")
  )
  if (textRate !== null) return textRate

  const averagePackWeight = parseWeightRangeAverage(
    metadataValue(metadata, [
      "strapi_avg_pack_weight",
      "AvgPackWeight",
      "average_pack_weight",
      "approximate_pack_weight",
      "ApproximatePackWeight",
      "pack_weight",
      "net_weight",
      "NetWeight",
    ])
  )
  if (averagePackWeight && averagePackWeight > 0 && lineSubtotal > 0) {
    return lineSubtotal / Math.max(quantity, 1) / averagePackWeight
  }

  return null
}

const productUrlForHandle = (handle: string | null): string | null => {
  if (!handle) return null
  const base = STOREFRONT_URL.replace(/\/+$/, "")
  return `${base}/us/products/${encodeURIComponent(handle)}`
}

const looksLikeAccountingTitle = (value: string | null): boolean => {
  if (!value) {
    return false
  }

  const title = value.toLowerCase()

  return (
    /\binstitutional\b/.test(title) ||
    /\bnot kosher for passover\b/.test(title) ||
    /\bno\s+msg\b/.test(title) ||
    /\bnot\s+gluten\s+free\b/.test(title) ||
    /\bfresh beef choice per lb\b/.test(title) ||
    /,\s*(?:with|in)\s+/.test(title) ||
    /@\s*\$?\d+(?:\.\d+)?\s*\/?\s*lb\.?/.test(title) ||
    (title.length > 72 && /\b(per lb|uncooked|choice|alle)\b/.test(title))
  )
}

const stripEmbeddedPrice = (value: string): string =>
  value
    .replace(
      /\s*@\s*\$?\d+(?:\.\d+)?\s*\/?\s*(?:lb|lbs|oz|kg|g|each|ea)\.?/gi,
      ""
    )
    .replace(
      /\s*\$\s?\d+(?:\.\d+)?\s*\/\s*(?:lb|lbs|oz|kg|g|each|ea)\.?/gi,
      ""
    )
    .replace(/\s+@\s*$/g, "")

const titleCaseLegacyWords = (value: string): string =>
  value
    .replace(/\b[A-Z]{3,}\b/g, (word) =>
      ["USDA", "KFP", "OU", "MSG"].includes(word)
        ? word
        : word[0] + word.slice(1).toLowerCase()
    )
    .replace(/\bBnls\b/gi, "Boneless")
    .replace(/\bLb\b/g, "lb")
    .replace(/\bOz\b/g, "oz")

const stripLegacyDescriptors = (value: string): string =>
  value
    .replace(/\s*\((?:alle)\)\s*/gi, " ")
    .replace(/\bInstitutional\b\.?/gi, " ")
    .replace(/\bUncooked\b\.?/gi, " ")
    .replace(/\bNOT\s+Kosher\s+for\s+Passover\.?/gi, " ")
    .replace(/\bNO\s+MSG\b\.?/gi, " ")
    .replace(/\bNOT\s+Gluten\s+Free\.?/gi, " ")
    .replace(/\bFresh\s+Beef\s+Choice\s+Per\s+LB\b\.?/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim()

const shortenLegacyDescriptionTitle = (value: string): string => {
  const commaIndex = value.indexOf(",")
  if (commaIndex <= 3) {
    return value
  }

  const head = value.slice(0, commaIndex).trim()
  const tail = value.slice(commaIndex + 1).trim().toLowerCase()

  if (
    head.length >= 4 &&
    (tail.startsWith("with ") ||
      tail.startsWith("in ") ||
      (value.length > 72 && !/^\(?\d{1,3}\s*\/\s*\d{1,3}\)?\b/.test(tail)))
  ) {
    return head
  }

  return value
}

const formatGroundBeefPackTitle = (value: string): string | null => {
  const match = value.match(
    /^(\d+(?:\.\d+)?)\s*lb\.?\s*(pack|tube)\s+ground\s+beef(?:\s*,?\s*\(?(\d{1,3}\s*\/\s*\d{1,3})\)?)?/i
  )

  if (!match?.[1] || !match?.[2] || !match?.[3]) {
    return null
  }

  const amount = match[1]
  const packageType =
    match[2].toLowerCase() === "tube" ? "Tube" : "Pack"
  const ratio = match[3].replace(/\s+/g, "")

  return `Ground Beef ${ratio} - ${amount} lb ${packageType}`
}

const cleanLegacyEmailTitle = (value: string | null): string | null => {
  const text = cleanText(value)
  if (!text) {
    return null
  }

  const shouldClean =
    looksLikeAccountingTitle(text) ||
    /\$\s?\d+(?:\.\d+)?\s*\/\s*(?:lb|lbs|oz|kg|g|each|ea)\.?/i.test(text) ||
    /\s*@\s*\$?\d+(?:\.\d+)?\s*\/?\s*(?:lb|lbs|oz|kg|g|each|ea)\.?/i.test(text)

  if (!shouldClean) {
    return text
  }

  const stripped = stripLegacyDescriptors(stripEmbeddedPrice(text))
  const shortened = shortenLegacyDescriptionTitle(stripped)

  const segments = shortened
    .split(",")
    .map((segment) =>
      segment
        .replace(/^[\s,.;:/-]+|[\s,.;:/-]+$/g, "")
        .replace(/\s{2,}/g, " ")
        .trim()
    )
    .filter((segment) => {
      if (!segment) {
        return false
      }

      const lower = segment.toLowerCase()
      return (
        lower !== "uncooked" &&
        lower !== "institutional" &&
        lower !== "not kosher for passover"
      )
    })

  const joined = segments.join(", ") || shortened || stripped
  const groundBeefTitle = formatGroundBeefPackTitle(joined)
  if (groundBeefTitle) {
    return groundBeefTitle
  }

  const cleaned = titleCaseLegacyWords(joined)
    .replace(/\blb\./gi, "lb")
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,.;:-]+$/g, "")
    .trim()

  return cleaned || text
}

const strapiTitleFromProduct = (product: Record<string, any>): string | null => {
  const attributes = objectValue(product.attributes)
  const medusaProduct = objectValue(product.MedusaProduct)
  const attributesMedusaProduct = objectValue(attributes.MedusaProduct)

  return (
    cleanText(product.Title) ||
    cleanText(attributes.Title) ||
    cleanText(medusaProduct.Title) ||
    cleanText(attributesMedusaProduct.Title)
  )
}

const strapiEmailMetadataFromProduct = (product: Record<string, any>) => {
  const attributes = objectValue(product.attributes)
  const medusaProduct = objectValue(product.MedusaProduct)
  const attributesMedusaProduct = objectValue(attributes.MedusaProduct)
  const metadata = objectValue(product.Metadata)
  const attributesMetadata = objectValue(attributes.Metadata)

  return {
    title: strapiTitleFromProduct(product),
    handle:
      cleanText(medusaProduct.Handle) ||
      cleanText(attributesMedusaProduct.Handle) ||
      cleanText(product.Handle) ||
      cleanText(attributes.Handle),
    pricingMode:
      cleanText(medusaProduct.PricingMode) ||
      cleanText(attributesMedusaProduct.PricingMode) ||
      cleanText(metadata.PricingMode) ||
      cleanText(attributesMetadata.PricingMode),
    avgPackWeight:
      cleanText(metadata.AvgPackWeight) ||
      cleanText(attributesMetadata.AvgPackWeight),
    pricePerLb:
      firstPositiveNumeric(
        metadata.PricePerLb,
        metadata.PricePerPound,
        attributesMetadata.PricePerLb,
        attributesMetadata.PricePerPound
      ),
  }
}

const hydrateStrapiTitles = async (
  container: Container,
  order: Record<string, unknown>
): Promise<Record<string, unknown>> => {
  const rawItems = Array.isArray(order.items) ? order.items : []
  const productIds = Array.from(
    new Set(
      rawItems
        .map((rawItem) => productIdForItem(objectValue(rawItem)))
        .filter((id): id is string => Boolean(id))
    )
  )

  if (!productIds.length) {
    return order
  }

  let strapiSvc: StrapiModuleService
  try {
    strapiSvc = container.resolve(STRAPI_MODULE) as StrapiModuleService
  } catch {
    return order
  }

  const logger = (() => {
    try {
      return container.resolve("logger")
    } catch {
      return null
    }
  })()

  const productMetadata = new Map<
    string,
    ReturnType<typeof strapiEmailMetadataFromProduct>
  >()
  for (const productId of productIds) {
    try {
      const product = await strapiSvc.findProductByMedusaId(productId)
      const metadata = product
        ? strapiEmailMetadataFromProduct(objectValue(product))
        : null
      if (
        metadata?.title ||
        metadata?.handle ||
        metadata?.pricingMode ||
        metadata?.avgPackWeight ||
        metadata?.pricePerLb
      ) {
        productMetadata.set(productId, metadata)
      }
    } catch (err) {
      logger?.warn?.(
        `[order-email] failed to load Strapi title for product=${productId}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }

  if (!productMetadata.size) {
    return order
  }

  return {
    ...order,
    items: rawItems.map((rawItem) => {
      const item = objectValue(rawItem)
      const productId = productIdForItem(item)
      const metadata = productId ? productMetadata.get(productId) : null
      if (!metadata) {
        return rawItem
      }

      return {
        ...item,
        metadata: {
          ...objectValue(item.metadata),
          ...(metadata.title ? { strapi_title: metadata.title } : {}),
          ...(metadata.handle
            ? { strapi_product_handle: metadata.handle }
            : {}),
          ...(metadata.pricingMode
            ? { strapi_pricing_mode: metadata.pricingMode }
            : {}),
          ...(metadata.avgPackWeight
            ? { strapi_avg_pack_weight: metadata.avgPackWeight }
            : {}),
          ...(metadata.pricePerLb
            ? { strapi_price_per_lb: metadata.pricePerLb }
            : {}),
        },
      }
    }),
  }
}

const displayTitleForItem = (item: Record<string, any>): string => {
  const variant = objectValue(item.variant)
  const product = objectValue(item.product)
  const variantProduct = objectValue(variant.product)
  const metadata = objectValue(item.metadata)

  const title =
    cleanText(metadata.strapi_title) ||
    cleanText(metadata.display_title) ||
    cleanText(metadata.customer_title) ||
    cleanText(metadata.medusa_product_title) ||
    cleanText(item.product_title) ||
    cleanText(variantProduct.title) ||
    cleanText(product.title) ||
    cleanText(variant.title) ||
    cleanText(item.title) ||
    null

  return cleanLegacyEmailTitle(title) || "Griller's Pride item"
}

const variantTitleForItem = (
  item: Record<string, any>,
  displayTitle: string
): string | null => {
  const variant = objectValue(item.variant)
  const product = objectValue(item.product)
  const variantProduct = objectValue(variant.product)
  const metadata = objectValue(item.metadata)
  const hasCustomerFacingTitle = Boolean(
    cleanText(metadata.strapi_title) ||
      cleanText(metadata.display_title) ||
      cleanText(metadata.customer_title)
  )

  if (hasCustomerFacingTitle) {
    return null
  }

  const title =
    cleanText(item.variant_title) ||
    cleanText(variant.title) ||
    cleanText(item.product_variant_title)

  const hiddenTitles = [
    displayTitle,
    item.title,
    item.subtitle,
    item.product_title,
    item.product_variant_title,
    product.title,
    variantProduct.title,
    "Default variant",
  ]
    .map((value) => cleanText(value)?.toLowerCase())
    .filter(Boolean)

  if (
    !title ||
    hiddenTitles.includes(title.toLowerCase()) ||
    looksLikeAccountingTitle(title)
  ) {
    return null
  }

  return title
}

export type OrderForEmail = {
  id: string
  customer_id?: string | null
  display_id?: number | string
  email: string
  currency_code: string
  total: number | string
  subtotal: number | string
  tax_total: number | string
  shipping_total: number | string
  discount_total: number | string
  metadata?: Record<string, any> | null
  items?: Array<{
    id: string
    title?: string
    display_title?: string
    source_title?: string | null
    sku?: string | null
    quantity?: number
    unit_price?: number
    line_total?: number
    thumbnail?: string | null
    product_handle?: string | null
    product_url?: string | null
    pricing_mode?: "per_lb" | "fixed_price"
    price_per_lb?: number | null
    variant_title?: string | null
    product_title?: string | null
    metadata?: Record<string, any> | null
    variant?: {
      id?: string
      title?: string | null
      sku?: string | null
      product?: {
        id?: string
        title?: string | null
        handle?: string | null
        thumbnail?: string | null
      } | null
    } | null
    detail?: {
      quantity?: number | string | null
    } | null
  }>
  shipping_address?: {
    first_name?: string | null
    last_name?: string | null
    company?: string | null
    address_1?: string | null
    address_2?: string | null
    city?: string | null
    province?: string | null
    postal_code?: string | null
    country_code?: string | null
    phone?: string | null
  } | null
  shipping_methods?: Array<{ name?: string; amount?: number }>
  payment_collections?: Array<{
    payments?: Array<{ provider_id?: string; amount?: number | string }>
  }>
}

export const fetchOrderForEmail = async (
  container: Container,
  orderId: string
): Promise<OrderForEmail | null> => {
  const query = container.resolve("query")
  const { data: orders } = await query.graph({
    entity: "order",
    fields: ORDER_FIELDS,
    filters: { id: orderId },
  })
  const order = orders?.[0] as Record<string, unknown> | undefined
  if (!order) return null
  const recipient = await resolveOrderReceiptEmail(container, order)
  return normalizeOrderForEmail(await hydrateStrapiTitles(container, { ...order, email: recipient }))
}

export const normalizeOrderForEmail = (
  order: Record<string, unknown>
): OrderForEmail => {
  const rawItems = Array.isArray(order.items) ? order.items : []
  const items = rawItems.map((rawItem) => {
    const item = objectValue(rawItem)
    const detail = objectValue(item.detail)
    const variant = objectValue(item.variant)
    const variantProduct = objectValue(variant.product)
    const quantity = firstNumeric(
      item.quantity,
      detail.quantity,
      item.raw_quantity,
      detail.raw_quantity
    ) ?? 1
    const unitPrice = firstNumeric(item.unit_price, item.raw_unit_price)
    const computedLineTotal = unitPrice !== null ? unitPrice * quantity : null
    const lineSubtotal =
      firstPositiveNumeric(
        item.subtotal,
        item.item_subtotal,
        item.raw_subtotal,
        item.original_subtotal,
        computedLineTotal
      ) ??
      firstNumeric(
        item.subtotal,
        item.item_subtotal,
        item.raw_subtotal,
        item.original_subtotal,
        computedLineTotal
      ) ??
      firstPositiveNumeric(
        item.total,
        item.item_total,
        item.raw_total
      ) ??
      firstNumeric(
        item.total,
        item.item_total,
        item.raw_total
      ) ??
      0
    const effectiveUnitPrice =
      unitPrice !== null
        ? unitPrice
        : quantity > 0 && lineSubtotal > 0
          ? lineSubtotal / quantity
          : 0
    const displayTitle = displayTitleForItem(item)
    const sku = skuForItem(item)
    const productHandle = productHandleForItem(item)
    const pricingMode = pricingModeForItem(item)
    const thumbnail =
      cleanText(item.thumbnail) ||
      cleanText(variantProduct.thumbnail) ||
      cleanText(variant.thumbnail)

    return {
      ...item,
      id: String(item.id || ""),
      title: displayTitle,
      display_title: displayTitle,
      source_title: cleanText(item.title),
      sku,
      variant_title: variantTitleForItem(item, displayTitle),
      quantity,
      unit_price: effectiveUnitPrice,
      line_total: lineSubtotal,
      thumbnail,
      product_handle: productHandle,
      product_url: productUrlForHandle(productHandle),
      pricing_mode: pricingMode,
      price_per_lb:
        pricingMode === "per_lb"
          ? pricePerPoundForItem(item, lineSubtotal, quantity)
          : null,
    }
  })

  const itemSubtotal = items.reduce((sum, item) => sum + (item.line_total || 0), 0)
  const shippingMethods = Array.isArray(order.shipping_methods)
    ? order.shipping_methods
    : []
  const shippingFromMethods = shippingMethods.reduce(
    (sum, method) => {
      const candidate = objectValue(method)
      return (
        sum +
        (firstNumeric(
          candidate.amount,
          candidate.raw_amount,
          candidate.total,
          candidate.raw_total,
          candidate.subtotal,
          candidate.raw_subtotal
        ) ?? 0)
      )
    },
    0
  )
  const shippingTotal =
    firstNumeric(order.shipping_total as MaybeMoney, order.shipping_subtotal as MaybeMoney) ??
    shippingFromMethods
  const discountTotal = firstNumeric(order.discount_total as MaybeMoney) ?? 0
  const paymentTotal = firstPositiveNumeric(
    ...(Array.isArray(order.payment_collections)
      ? order.payment_collections.flatMap((collection) =>
          Array.isArray(objectValue(collection).payments)
            ? objectValue(collection).payments.map(
                (payment: Record<string, unknown>) => payment.amount as MaybeMoney
              )
            : []
        )
      : [])
  )
  const explicitItemTotal = firstPositiveNumeric(order.item_total as MaybeMoney)
  const explicitItemSubtotal = firstPositiveNumeric(
    order.item_subtotal as MaybeMoney,
    order.subtotal as MaybeMoney
  )
  const derivedTaxTotal =
    explicitItemTotal !== null && explicitItemSubtotal !== null
      ? Math.max(0, explicitItemTotal - explicitItemSubtotal)
      : null
  const explicitTaxTotal = firstNumeric(
    order.tax_total as MaybeMoney,
    order.shipping_tax_total as MaybeMoney
  )
  const taxTotal =
    explicitTaxTotal !== null && explicitTaxTotal > 0
      ? explicitTaxTotal
      : derivedTaxTotal !== null && derivedTaxTotal > 0
        ? derivedTaxTotal
        : explicitTaxTotal ?? 0
  const subtotal =
    firstPositiveNumeric(
      order.item_subtotal as MaybeMoney,
      order.subtotal as MaybeMoney
    ) ??
    itemSubtotal
  const paymentDerivedTax =
    paymentTotal !== null
      ? Math.max(0, paymentTotal - subtotal - shippingTotal + discountTotal)
      : null
  const resolvedTaxTotal =
    paymentDerivedTax !== null && paymentTotal !== null
      ? Math.max(0, paymentDerivedTax)
      : taxTotal > 0
        ? taxTotal
        : paymentDerivedTax !== null && paymentDerivedTax > 0
          ? paymentDerivedTax
          : taxTotal
  const computedTotal = subtotal + shippingTotal + resolvedTaxTotal - discountTotal
  const total =
    paymentTotal ??
    (computedTotal > 0 &&
    (resolvedTaxTotal > 0 || shippingTotal > 0 || discountTotal > 0)
      ? computedTotal
      : firstPositiveNumeric(order.total as MaybeMoney) ?? computedTotal)

  return {
    ...(order as OrderForEmail),
    currency_code: String(order.currency_code || "usd"),
    items,
    subtotal,
    total,
    shipping_total: shippingTotal,
    tax_total: resolvedTaxTotal,
    discount_total: discountTotal,
  }
}

export const getPaymentLabel = (order: OrderForEmail): string => {
  const provider =
    order.payment_collections?.[0]?.payments?.[0]?.provider_id || ""
  if (provider.includes("stripe")) return "Credit Card"
  if (provider.includes("paypal")) return "PayPal"
  if (provider.includes("manual")) return "Payment on file"
  return "Payment"
}

export const getFulfillmentInfo = (order: OrderForEmail) => {
  const meta = (order.metadata || {}) as Record<string, any>
  const fulfillmentType = meta.fulfillmentType as string | undefined
  const isPickup = fulfillmentType === "plant_pickup" || fulfillmentType === "southeast_pickup"
  const isLocalDelivery = fulfillmentType === "local_delivery" || fulfillmentType === "atlanta_delivery"
  const dates = fulfillmentDates(meta)
  const scheduledDate = formatFulfillmentDate(dates.arrivalDate)
  const requestedDeliveryDate = scheduledDate
  const windowLabel = typeof meta.fulfillmentWindowLabel === "string"
    ? meta.fulfillmentWindowLabel.trim() : ""
  const scheduledWindow = windowLabel
    ? `${windowLabel}${meta.fulfillmentCalendarTimezone === "America/New_York" ? " ET" : ""}` : ""
  const fulfillmentZip = meta.fulfillmentZip as string | undefined

  const shippingMethodName =
    order.shipping_methods?.[0]?.name ||
    (fulfillmentType === "southeast_pickup" ? "Regional Pickup" : isPickup ? "Plant Pickup" : isLocalDelivery ? "Local Delivery" : "Shipping")

  return {
    fulfillmentType,
    isPickup,
    isLocalDelivery,
    scheduledDate,
    requestedDeliveryDate,
    scheduledWindow,
    fulfillmentZip,
    shippingMethodName,
  }
}
