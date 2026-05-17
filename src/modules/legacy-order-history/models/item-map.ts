import { model } from "@medusajs/framework/utils"

const LegacyItemMap = model
  .define("legacy_item_map", {
    id: model.id({ prefix: "lgimap" }).primaryKey(),
    qbd_item_list_id: model.text(),
    qbd_name: model.text().nullable(),
    sku: model.text().nullable(),
    medusa_product_id: model.text().nullable(),
    medusa_variant_id: model.text().nullable(),
    medusa_product_title: model.text().nullable(),
    medusa_variant_title: model.text().nullable(),
    confidence: model.number().default(0),
    mapping_source: model.text().nullable(),
    last_seen_at: model.dateTime().nullable(),
    metadata: model.json().nullable(),
  })
  .indexes([
    {
      name: "IDX_legacy_item_map_qbd_item_list_id",
      on: ["qbd_item_list_id"],
      unique: true,
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_item_map_sku",
      on: ["sku"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_item_map_medusa_variant_id",
      on: ["medusa_variant_id"],
      where: "deleted_at IS NULL",
    },
  ])

export default LegacyItemMap
