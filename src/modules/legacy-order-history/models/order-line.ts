import { model } from "@medusajs/framework/utils"

const LegacyOrderLine = model
  .define("legacy_order_line", {
    id: model.id({ prefix: "lgline" }).primaryKey(),
    legacy_order_id: model.text(),
    source: model.text(),
    source_line_id: model.text(),
    qbd_txn_line_id: model.text().nullable(),
    qbd_item_list_id: model.text().nullable(),
    sku: model.text().nullable(),
    title: model.text().nullable(),
    description: model.text().nullable(),
    quantity: model.number().default(0),
    unit_price: model.number().default(0),
    line_total: model.number().default(0),
    currency_code: model.text().default("usd"),
    medusa_product_id: model.text().nullable(),
    medusa_variant_id: model.text().nullable(),
    medusa_product_title: model.text().nullable(),
    medusa_variant_title: model.text().nullable(),
    mapping_status: model.text().nullable(),
    imported_at: model.dateTime().nullable(),
    source_snapshot: model.json().nullable(),
    metadata: model.json().nullable(),
  })
  .indexes([
    {
      name: "IDX_legacy_order_line_source_line_id",
      on: ["source", "source_line_id"],
      unique: true,
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_line_legacy_order_id",
      on: ["legacy_order_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_line_qbd_item_list_id",
      on: ["qbd_item_list_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_line_sku",
      on: ["sku"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_line_medusa_variant_id",
      on: ["medusa_variant_id"],
      where: "deleted_at IS NULL",
    },
  ])

export default LegacyOrderLine
