import { model } from "@medusajs/framework/utils"

const LegacyOrder = model
  .define("legacy_order", {
    id: model.id({ prefix: "lgord" }).primaryKey(),
    source: model.text(),
    source_order_id: model.text(),
    qbd_txn_id: model.text().nullable(),
    ref_number: model.text().nullable(),
    legacy_order_id: model.text().nullable(),
    legacy_customer_id: model.text().nullable(),
    qbd_customer_list_id: model.text().nullable(),
    medusa_customer_id: model.text().nullable(),
    email_lower: model.text().nullable(),
    customer_name: model.text().nullable(),
    placed_at: model.dateTime().nullable(),
    ship_date: model.dateTime().nullable(),
    status: model.text().nullable(),
    subtotal: model.number().default(0),
    tax_total: model.number().default(0),
    shipping_total: model.number().default(0),
    discount_total: model.number().default(0),
    total: model.number().default(0),
    currency_code: model.text().default("usd"),
    line_count: model.number().default(0),
    searchable_text: model.text().nullable(),
    source_updated_at: model.dateTime().nullable(),
    imported_at: model.dateTime().nullable(),
    source_snapshot: model.json().nullable(),
    metadata: model.json().nullable(),
  })
  .indexes([
    {
      name: "IDX_legacy_order_source_order_id",
      on: ["source", "source_order_id"],
      unique: true,
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_medusa_customer_id",
      on: ["medusa_customer_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_qbd_customer_list_id",
      on: ["qbd_customer_list_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_legacy_customer_id",
      on: ["legacy_customer_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_email_lower",
      on: ["email_lower"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_order_placed_at",
      on: ["placed_at"],
      where: "deleted_at IS NULL",
    },
  ])

export default LegacyOrder
