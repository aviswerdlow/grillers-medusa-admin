import { model } from "@medusajs/framework/utils"

const LegacyCustomerMap = model
  .define("legacy_customer_map", {
    id: model.id({ prefix: "lgcmap" }).primaryKey(),
    legacy_customer_id: model.text(),
    qbd_customer_list_id: model.text().nullable(),
    medusa_customer_id: model.text().nullable(),
    medusa_auth_identity_id: model.text().nullable(),
    email_lower: model.text().nullable(),
    legacy_username: model.text().nullable(),
    first_name: model.text().nullable(),
    last_name: model.text().nullable(),
    phone: model.text().nullable(),
    auth_import_status: model.text().nullable(),
    address_import_status: model.text().nullable(),
    last_imported_at: model.dateTime().nullable(),
    metadata: model.json().nullable(),
  })
  .indexes([
    {
      name: "IDX_legacy_customer_map_legacy_customer_id",
      on: ["legacy_customer_id"],
      unique: true,
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_customer_map_qbd_customer_list_id",
      on: ["qbd_customer_list_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_customer_map_medusa_customer_id",
      on: ["medusa_customer_id"],
      where: "deleted_at IS NULL",
    },
    {
      name: "IDX_legacy_customer_map_email_lower",
      on: ["email_lower"],
      where: "deleted_at IS NULL",
    },
  ])

export default LegacyCustomerMap
