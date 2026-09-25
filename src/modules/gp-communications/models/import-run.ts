import { model } from "@medusajs/framework/utils"

const ImportRun = model
  .define("gp_import_run", {
    id: model.id({ prefix: "gpimprt" }).primaryKey(),
    source: model.text(),
    batch_id: model.text().nullable(),
    status: model.text().default("pending"),
    started_at: model.dateTime().nullable(),
    completed_at: model.dateTime().nullable(),
    imported_count: model.number().default(0),
    skipped_count: model.number().default(0),
    failed_count: model.number().default(0),
    stats: model.json().nullable(),
    metadata: model.json().nullable(),
    error_message: model.text().nullable(),
  })
  .indexes([
    {
      name: "IDX_gp_import_run_source_status",
      on: ["source", "status"],
      where: "deleted_at IS NULL",
    },
    {
      name: "UQ_gp_import_run_source_batch",
      on: ["source", "batch_id"],
      unique: true,
      where: "batch_id IS NOT NULL",
    },
  ])

export default ImportRun
